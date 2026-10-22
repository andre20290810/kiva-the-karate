// 公式データ（全利用者に配布する初期譜面・判定設定・個別エフェクト・公式デモ履歴）の結合・検証・変更概要。
// 純粋ロジック（DOM 非依存）。画面（公開前の確認）とサーバー（Cloudflare Worker の検証・保存）で同じ関数を使う。
// 更新は「対象」を選んで、その部分だけを今の公式データへ重ねる（無関係な部分は上書きしない）:
//   notes   … 譜面（ノーツの時刻・コマンド・長押し・表示名・連続コマンドのまとまり・メモ・判定以外の設定・人物の表示）
//   timing  … 判定設定（PERFECT・GOOD・許容限界・息の押し始め・早離しの許容・入力補正）
//   effects … 個別エフェクト（ノーツごとのエフェクト。同じ ID のノーツだけ）
//   demos   … 公式デモ履歴（入力ログから計算し直して一致するものだけ）

import { validateChart, normalizeChart, exportChart, TIMING_KEYS } from './chart.js';
import { recordError, chartHash } from './score.js';
import { verifyRecord } from './replay.js';

export const OFFICIAL_SCHEMA = 'kiva-official/1';
export const TARGETS = Object.freeze({ notes: '譜面（ノーツ）', timing: '判定設定', effects: '個別エフェクト', demos: '公式デモ履歴' });
export const DEMO_PREFIX = 'official-demo-';

const clone = (v) => JSON.parse(JSON.stringify(v));
const NOTE_KEYS = (n) => Object.keys(n).filter((k) => k !== 'effect');

/** 今の公式の譜面に、選んだ対象だけを重ねた譜面 */
export function mergeChart(current, submitted, targets) {
  const out = clone(current);
  const t = new Set(targets);
  if (t.has('notes')) {
    const effOf = new Map(current.notes.map((n) => [n.id, n.effect]));
    out.notes = submitted.notes.map((n) => {
      const o = {};
      for (const k of NOTE_KEYS(n)) o[k] = clone(n[k]);
      // 個別エフェクトは「個別エフェクト」を選んだときだけ変える（今の公式の値を残す）
      if (effOf.get(n.id) !== undefined) o.effect = clone(effOf.get(n.id));
      return o;
    });
    for (const k of ['title', 'sequences', 'memo', 'display']) if (submitted[k] !== undefined) out[k] = clone(submitted[k]); else delete out[k];
    for (const k of Object.keys(submitted.settings || {})) if (!TIMING_KEYS.includes(k)) out.settings[k] = submitted.settings[k];
  }
  if (t.has('timing')) for (const k of TIMING_KEYS) if (submitted.settings?.[k] !== undefined) out.settings[k] = submitted.settings[k];
  if (t.has('effects')) {
    const eff = new Map(submitted.notes.map((n) => [n.id, n.effect]));
    for (const n of out.notes) {
      if (!eff.has(n.id)) continue;
      const e = eff.get(n.id);
      if (e === undefined || e === null) delete n.effect; else n.effect = clone(e);
    }
  }
  return out;
}

/** 変更の概要（公開前の確認とサーバーの記録で共通） */
export function changeSummary(curChart, newChart, curDemos = [], newDemos = curDemos) {
  const a = new Map(curChart.notes.map((n) => [n.id, n])), b = new Map(newChart.notes.map((n) => [n.id, n]));
  const sig = (n) => JSON.stringify(NOTE_KEYS(n).sort().map((k) => [k, n[k]]));
  let changed = 0, effects = 0;
  const added = [...b.keys()].filter((id) => !a.has(id)), removed = [...a.keys()].filter((id) => !b.has(id));
  for (const [id, n] of b) {
    const o = a.get(id);
    if (!o) continue;
    if (sig(o) !== sig(n)) changed++;
    if (JSON.stringify(o.effect ?? null) !== JSON.stringify(n.effect ?? null)) effects++;
  }
  const timing = TIMING_KEYS.filter((k) => curChart.settings[k] !== newChart.settings[k]).map((k) => ({ key: k, from: curChart.settings[k], to: newChart.settings[k] }));
  const da = new Map(curDemos.map((r) => [r.id, r])), db = new Map(newDemos.map((r) => [r.id, r]));
  const demos = {
    added: [...db.keys()].filter((id) => !da.has(id)), removed: [...da.keys()].filter((id) => !db.has(id)),
    changed: [...db.keys()].filter((id) => da.has(id) && JSON.stringify(da.get(id)) !== JSON.stringify(db.get(id))),
  };
  const notes = { changed, added: added.length, removed: removed.length };
  const any = changed || added.length || removed.length || effects || timing.length || demos.added.length || demos.removed.length || demos.changed.length
    || JSON.stringify(exportChart(curChart)) !== JSON.stringify(exportChart(newChart));
  return { notes, effects, timing, demos, any: !!any, hash: chartHash(newChart) };
}

/** 変更の概要を文章に */
export function summaryText(s) {
  const out = [];
  if (s.notes.changed || s.notes.added || s.notes.removed) out.push(`ノーツ: 変更 ${s.notes.changed}・追加 ${s.notes.added}・削除 ${s.notes.removed}`);
  if (s.effects) out.push(`個別エフェクト: ${s.effects} ノーツ`);
  if (s.timing.length) out.push(`判定設定: ${s.timing.map((x) => `${x.key} ${x.from}→${x.to}`).join('、')}`);
  const d = s.demos;
  if (d.added.length || d.removed.length || d.changed.length) out.push(`公式デモ: 追加 ${d.added.length}・更新 ${d.changed.length}・削除 ${d.removed.length}`);
  return out.length ? out.join(' ／ ') : s.any ? 'そのほかの項目の変更' : '変更なし';
}

/** 公式デモの検証: 形式・ID・公式デモの印・譜面の一致・入力ログから計算し直した結果との一致 */
export function validateDemos(demos, chart) {
  const errors = [];
  if (!Array.isArray(demos)) return ['公式デモ履歴は配列にしてください'];
  if (demos.length > 12) errors.push('公式デモ履歴は 12 件までです');
  const ids = new Set();
  const hash = chartHash(chart);
  demos.forEach((r, k) => {
    const at = `公式デモ ${k + 1}`;
    const e = recordError(r);
    if (e) { errors.push(`${at}: ${e}`); return; }
    if (typeof r.id !== 'string' || !r.id.startsWith(DEMO_PREFIX) || !/^[a-z0-9-]{1,64}$/.test(r.id)) errors.push(`${at}: ID は ${DEMO_PREFIX}… の英小文字・数字・- にしてください`);
    if (ids.has(r.id)) errors.push(`${at}: ID ${r.id} が重複しています`);
    ids.add(r.id);
    if (r.mode !== 'demo' || !r.demo?.official) errors.push(`${at}: 公式デモ（mode: demo）の印がありません`);
    if (r.chart?.hash !== hash) errors.push(`${at}: 公式の譜面（識別 ${hash}）と違う譜面の記録です（${r.chart?.hash}）`);
    const v = verifyRecord(r);
    if (!v.ok) errors.push(`${at}: ${v.reason}${v.diffs?.length ? `（${v.diffs.slice(0, 3).join('／')}）` : ''}`);
  });
  return errors;
}

/**
 * 公開する内容を作って検証する（サーバーと画面で共通）。
 * cur: 今の公式データ {chart, demos}、body: {targets, chart?, demos?}、ctx: {frameCount, gameVersion}
 * 戻り値: { errors, chart, demos, summary }
 */
export function prepareUpdate(cur, body, ctx = {}) {
  const errors = [];
  const targets = Array.isArray(body?.targets) ? [...new Set(body.targets)] : [];
  if (!targets.length) errors.push('更新する対象を選んでください');
  for (const t of targets) if (!TARGETS[t]) errors.push(`対象 ${t} は更新できません`);
  const needChart = targets.some((t) => t !== 'demos');
  let chart = cur.chart, demos = cur.demos || [];
  if (needChart) {
    if (!body.chart || typeof body.chart !== 'object') errors.push('譜面 JSON がありません');
    else {
      const v = validateChart(body.chart, { frameCount: ctx.frameCount, gameVersion: ctx.gameVersion });
      if (v.errors.length) errors.push(...v.errors.map((e) => `譜面: ${e}`));
      else chart = mergeChart(cur.chart, normalizeChart(body.chart), targets);
      if (!errors.length) {
        const v2 = validateChart(chart, { frameCount: ctx.frameCount, gameVersion: ctx.gameVersion });
        if (v2.errors.length) errors.push(...v2.errors.map((e) => `結合後の譜面: ${e}`));
      }
    }
  }
  if (targets.includes('demos')) {
    const d = body.demos;
    const es = validateDemos(d, chart);
    if (es.length) errors.push(...es); else demos = d;
  } else if (needChart && chartHash(chart) !== chartHash(cur.chart) && (cur.demos || []).length) {
    // 譜面が変わると今の公式デモは別の譜面の記録になる（混ぜない）
    errors.push('譜面のノーツを変えると、今の公式デモ履歴は別の譜面の記録になります。公式デモ履歴も選び、新しい譜面で作り直したデモを一緒に公開してください');
  }
  const summary = errors.length ? null : changeSummary(cur.chart, chart, cur.demos || [], demos);
  if (summary && !summary.any) errors.push('変更がありません（公開しませんでした）');
  return { errors, chart, demos, summary, targets };
}
