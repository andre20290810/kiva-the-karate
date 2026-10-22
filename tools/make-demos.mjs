// 公式デモ履歴（シミュレーション）を作る: 正答率 約90％・約70％・約50％ の 3 件。
//   node tools/make-demos.mjs            → charts/official-demos.json を書き出す
//   node tools/make-demos.mjs --check    → 書き出し済みのファイルを入力ログから計算し直して一致を確認（書き出さない）
// - 正式譜面（charts/seipai_v2.json）のノーツの時刻に対して、押下・解除の入力ログを固定の乱数（種つき）で作る（毎回同じ）。
// - 結果は手で書かず、入力ログを通常の判定処理（Judge）に通して計算する（app/replay.js の simulate と score.js の buildRecord）。
// - 成功（PERFECT・GOOD。息は保持して成功）の件数 = round(目標 × 対象ノーツ数) になるまで、失敗の割り当てを調整する。
// - 失敗は全編・4 種類のコマンドに分散（技ごとのノーツ数に比例して割り当て、時刻を等間隔に選ぶ）。
//   種類: 入力なし・ボタン違い・早すぎ・遅すぎ（範囲外の MISS）・息の早離し・息の押し始めが遅すぎ。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeChart } from '../app/chart.js';
import { simulate, snapshotNotes, verifyRecord, JUDGE_VERSION, LOG_VERSION } from '../app/replay.js';
import { buildRecord, RECORD_SCHEMA } from '../app/score.js';

const root = resolve(import.meta.dirname, '..');
const chartPath = 'charts/seipai_v2.json';
const OUT = resolve(root, 'charts/official-demos.json');
const chart = normalizeChart(JSON.parse(readFileSync(resolve(root, chartPath), 'utf8')));
const manifest = JSON.parse(readFileSync(resolve(root, chart.source.frameManifest), 'utf8'));
const frameAt = (t) => { let i = 0; for (let k = 0; k < manifest.frames.length; k++) { if (manifest.frames[k].t <= Math.max(0, t) + 1e-9) i = k; else break; } return { i, t: manifest.frames[i].t }; };
const S = chart.settings;
const DURATION = Math.round((manifest.durationSeconds || chart.source.durationSeconds) * 1000) / 1000;

// 固定の乱数（mulberry32）
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const gauss = (r) => { let u = 0; for (let k = 0; k < 6; k++) u += r(); return (u - 3) / Math.sqrt(0.5); }; // おおよその正規分布

const LEVELS = [
  { key: '90', target: 0.9, label: '公式デモ：正答率 約90％', seed: 9001, sigma: 22, goodShare: 0.12, bias: -4 },
  { key: '70', target: 0.7, label: '公式デモ：正答率 約70％', seed: 7001, sigma: 38, goodShare: 0.3, bias: 8 },
  { key: '50', target: 0.5, label: '公式デモ：正答率 約50％', seed: 5001, sigma: 50, goodShare: 0.45, bias: 14 },
];
const notes = chart.notes.slice().sort((a, b) => a.time - b.time);
const BTN = ['Y', 'X', 'A', 'B'];

/** 失敗の件数を技ごとに比例配分（最大剰余）し、各技の中で時刻が等間隔になるノーツを選ぶ */
function pickFailures(F, r) {
  const groups = Object.fromEntries(BTN.map((b) => [b, notes.filter((n) => n.button === b)]));
  const quota = BTN.map((b) => ({ b, q: (F * groups[b].length) / notes.length }));
  const base = quota.map((x) => ({ ...x, n: Math.floor(x.q) }));
  let rest = F - base.reduce((s, x) => s + x.n, 0);
  for (const x of base.slice().sort((a, b) => (b.q - b.n) - (a.q - a.n))) { if (rest-- > 0) x.n++; }
  const out = new Set();
  for (const { b, n } of base) {
    const g = groups[b], off = r();
    for (let k = 0; k < n; k++) out.add(g[Math.min(g.length - 1, Math.floor(((k + off) / n) * g.length))].id);
  }
  return out;
}

/** 1 つのデモの入力ログ（押下・解除）を作る。plan: ノーツ ID → 'ok' | 失敗の種類 */
function makeEvents(level, plan) {
  const r = rng(level.seed + 17);
  const ev = [];
  const push = (kind, b, t) => ev.push({ kind, b, t: Math.round(t * 1e6) / 1e6 });
  let tapFail = 0, holdFail = 0;
  for (const n of notes) {
    const p = plan.get(n.id);
    const hold = n.input === 'hold';
    if (p === 'ok') {
      // 成功: 多くは PERFECT、一部は GOOD（範囲内に収める）
      const good = r() < level.goodShare;
      let d = good ? (r() < 0.5 ? -1 : 1) * (68 + r() * 45) : level.bias + gauss(r) * level.sigma * 0.5;
      d = Math.max(-112, Math.min(112, d));
      if (!good) d = Math.max(-55, Math.min(55, d));
      push('d', n.button, n.time + d / 1000);
      if (hold) {
        const end = n.time + n.duration;
        push('u', n.button, r() < 0.4 ? end - 0.05 - r() * 0.08 : end + 0.08 + r() * 0.3); // 許容内で離す／完了後に離す
      } else push('u', n.button, n.time + d / 1000 + 0.06 + r() * 0.06);
      continue;
    }
    if (hold) {
      const kind = ['early-release', 'none', 'late-start'][holdFail++ % 3];
      if (kind === 'none') continue;
      if (kind === 'early-release') { push('d', n.button, n.time + (gauss(r) * 20) / 1000); push('u', n.button, n.time + n.duration * (0.3 + r() * 0.35)); continue; }
      push('d', n.button, n.time + (135 + r() * 30) / 1000); push('u', n.button, n.time + n.duration + 0.1); continue;
    }
    const kind = ['none', 'wrong', 'early', 'late'][tapFail++ % 4];
    if (kind === 'none') continue;
    if (kind === 'wrong') {
      // そのボタンのノーツが近くにないボタンを押す（どのノーツにも当たらない入力 = 余分な入力）
      const other = BTN.filter((b) => b !== n.button && b !== 'Y').find((b) => !notes.some((m) => m.button === b && Math.abs(m.time - n.time) < 0.45));
      if (!other) continue;
      const t = n.time + (r() - 0.5) * 0.06;
      push('d', other, t); push('u', other, t + 0.07); continue;
    }
    const d = (kind === 'early' ? -1 : 1) * (138 + r() * 34);
    push('d', n.button, n.time + d / 1000); push('u', n.button, n.time + d / 1000 + 0.07);
  }
  ev.sort((a, b) => a.t - b.t || (a.kind === 'u' ? -1 : 1)); // 同じ時刻なら解除を先に（記録した順として固定）
  // 判定ログの形: 直前に判定を進めた時刻 = 60fps の描画の時刻（入力より前の最後のコマ）
  let last = null;
  return ev.map((e) => {
    const frame = Math.floor(e.t * 60 - 1e-9) / 60;
    const at = last == null ? frame : Math.max(last, frame);
    last = at;
    return [e.kind, e.b, e.t, e.t, Math.round(at * 1e6) / 1e6, 'demo', 'demo'];
  });
}

function buildDemo(level, k) {
  const total = notes.length;
  const want = Math.round(level.target * total);
  const r = rng(level.seed);
  let fails = pickFailures(total - want, r);
  for (let attempt = 0; attempt < 30; attempt++) {
    const plan = new Map(notes.map((n) => [n.id, fails.has(n.id) ? 'fail' : 'ok']));
    const events = makeEvents(level, plan);
    const startT = -S.leadInSeconds;
    const { judge } = simulate({ notes: snapshotNotes(chart.notes), settings: S, startT, events, endT: DURATION });
    const at = new Date(Date.UTC(2026, 9, 22, 0, k, 0)).toISOString(); // 作成日時（公式デモの識別用。実プレイの日時ではない）
    const rec = buildRecord(judge, {
      chart, settings: S, rate: 1, mode: 'demo', kind: 'full', practiceReasons: [], bgm: null, startedAt: at, endedAt: at,
      chartSource: 'official', startT, endT: DURATION, duration: DURATION, frameAt, id: `official-demo-${level.key}`,
    });
    rec.demo = { official: true, label: level.label, note: '公式に用意したシミュレーションデータです（実際の利用者の実績ではありません）', targetRate: level.target, successes: rec.summary.perfect + rec.summary.good, total: rec.summary.total };
    rec.replay = { v: LOG_VERSION, judgeVersion: JUDGE_VERSION, startT, endT: DURATION, notes: snapshotNotes(chart.notes), events, chartRef: { path: chartPath, hash: rec.chart.hash } };
    const ok = rec.summary.perfect + rec.summary.good;
    // 意図と違う結果のノーツ（失敗の予定が成功した、または成功の予定が失敗した）を調整
    const okIds = new Set(rec.notes.filter((n) => n.result === 'PERFECT' || n.result === 'GOOD').map((n) => n.id));
    const wrong = notes.filter((n) => fails.has(n.id) === okIds.has(n.id));
    if (ok === want && !wrong.length) return rec;
    // 予定外に成功した失敗ノーツ → 別のノーツを失敗に。予定外に失敗した成功ノーツ → 失敗の予定から外す
    for (const n of wrong) {
      if (fails.has(n.id)) { fails.delete(n.id); const alt = notes.find((m) => m.button === n.button && !fails.has(m.id) && Math.abs(m.time - n.time) > 3); if (alt) fails.add(alt.id); }
      else { fails.add(n.id); const drop = [...fails].find((id) => id !== n.id && notes.find((m) => m.id === id).button === n.button); if (drop) fails.delete(drop); }
    }
  }
  throw new Error(`${level.label}: 成功 ${want} 件にできませんでした`);
}

if (process.argv.includes('--check')) {
  const data = JSON.parse(readFileSync(OUT, 'utf8'));
  let bad = 0;
  for (const rec of data.records) {
    const v = verifyRecord(rec);
    const ok = rec.summary.perfect + rec.summary.good;
    console.log(`${rec.demo.label}: 成功 ${ok}/${rec.summary.total}（${(ok / rec.summary.total * 100).toFixed(1)}%）スコア ${rec.summary.score} 最大コンボ ${rec.summary.maxCombo} 平均絶対誤差 ${rec.summary.maeMs}ms — 再計算 ${v.ok ? '一致' : `不一致 ${v.diffs.slice(0, 3).join(' / ')}`}`);
    if (!v.ok) bad++;
  }
  process.exit(bad ? 1 : 0);
}

const records = LEVELS.map((l, k) => buildDemo(l, k));
for (const rec of records) {
  const v = verifyRecord(rec);
  if (!v.ok) throw new Error(`${rec.id}: 再計算が一致しません ${v.diffs.join(' / ')}`);
}
const out = { schema: 'kiva-official-demos/1', note: '公式デモ／シミュレーション（入力ログから通常の判定処理で計算した結果）', chart: { path: chartPath, hash: records[0].chart.hash }, judgeVersion: JUDGE_VERSION, records };
writeFileSync(OUT, `${JSON.stringify(out)}\n`);
for (const rec of records) {
  const s = rec.summary, ok = s.perfect + s.good;
  const kinds = { none: rec.notes.filter((n) => !n.input && n.result === 'MISS').length, withInput: rec.notes.filter((n) => n.input && n.result === 'MISS').length, early: rec.notes.filter((n) => n.reason === 'early-release').length };
  console.log(`${rec.demo.label}: 成功 ${ok}/${s.total}（${(ok / s.total * 100).toFixed(1)}%）PERFECT ${s.perfect} GOOD ${s.good} MISS ${s.miss}（入力なし ${kinds.none}・範囲外 ${kinds.withInput}・早離し ${kinds.early}）余分な入力 ${s.extras} スコア ${s.score} 最大コンボ ${s.maxCombo} 平均絶対誤差 ${s.maeMs}ms`);
}
console.log(`書き出し: ${OUT}`);
