// 成績の比較（純粋ロジック・DOM 非依存）: 複数の記録の比較と、期間平均の比較。
// 約束（画面・書き出し・テストで共通）:
// - ノーツは譜面の安定した ID で対応付ける（配列の順番では結ばない）。同じ ID でも時刻・コマンド・保持時間が違えば「条件変更」、
//   基準にない／記録にないノーツは「対応なし」。どちらも同じ条件の比較・集計に入れない。
// - ずれ（ms）= 入力時刻 − 正解時刻（マイナス = 早い）。絶対誤差 = その大きさ。早押しと遅押しを相殺しない。
// - 入力なしの MISS・ボタン違い（記録上は余分な入力）は誤差 0ms として扱わない（誤差の集計から外し、MISS の件数に入れる）。
// - 改善量（ms）= 基準（期間 A）の絶対誤差 − 比較（期間 B）の絶対誤差。プラスが改善。改善率 = 改善量 ÷ 基準の値（基準が 0 なら計算しない）。
// - 全体の平均誤差は対象の入力をすべて合算して計算する（記録ごとの平均の平均にしない）。
// - 件数が少なくても件数を示すだけで、統計的な有意性は判断しない。

import { CMD, conditionDiffs } from './score.js';

export const BUTTONS = ['Y', 'X', 'A', 'B'];
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const RANK = { PERFECT: 2, GOOD: 1, MISS: 0 };
/** 記録ごとの色と記号（日時順に割り当て、画面全体で共通） */
export const RECORD_STYLE = Object.freeze([
  { color: '#ffb347', sym: 'A' }, { color: '#5fd3ff', sym: 'B' }, { color: '#b28cff', sym: 'C' }, { color: '#7be08a', sym: 'D' },
  { color: '#ff7aa8', sym: 'E' }, { color: '#e8e070', sym: 'F' }, { color: '#ff8f5a', sym: 'G' }, { color: '#8fb8ff', sym: 'H' },
]);
export const styleOf = (k) => RECORD_STYLE[k % RECORD_STYLE.length];

/** ノーツの署名（時刻・コマンド・保持時間）。同じ ID でも署名が違えば別のノーツ */
export const noteSig = (n) => `${Number(n.time).toFixed(3)}|${n.button}|${n.hold ? Number(n.hold.duration ?? 0).toFixed(3) : 'tap'}`;

/** 長押しの保持・解除の結果: true = 保持して成功、false = 早離し・押し始めの MISS、null = 判定なし／記録なし */
export function holdOk(n) {
  const s = n.hold?.status;
  if (s === undefined) return null;
  if (['completed-released', 'completed-held', 'released-in-window'].includes(s)) return true;
  if (['early-release', 'start-miss', 'not-pressed'].includes(s)) return false;
  return null;
}

/** 1 つのノーツの観測値（記録から。推測で補わない） */
export function observe(n) {
  if (!n) return null;
  const timed = n.input && n.input.deltaMs != null;
  return {
    id: n.id, button: n.button, time: n.time, result: n.result,
    input: n.input ? { button: n.input.button, time: n.input.time, device: n.input.device } : null,
    d: timed ? n.input.deltaMs : null, abs: timed ? Math.abs(n.input.deltaMs) : null,
    noInput: !n.input && n.result === 'MISS',
    hold: n.hold ? { ok: holdOk(n), status: n.hold.status, heldSec: n.hold.heldSec, requiredSec: n.hold.requiredSec, releasedAt: n.hold.releasedAt, releaseDeltaMs: n.hold.releaseDeltaMs } : null,
  };
}

/**
 * 基準のノーツと記録のノーツを ID で対応付ける。
 * 戻り値: { status: 'ok' | 'changed' | 'missing', obs, why }
 */
export function matchNote(refNote, rec) {
  const n = rec.notes.find((x) => x.id === refNote.id);
  if (!n) return { status: 'missing', obs: null, why: '対応なし（この記録の譜面にこのノーツがない）' };
  if (noteSig(n) !== noteSig(refNote)) {
    const diff = [];
    if (Math.abs(n.time - refNote.time) > 5e-4) diff.push(`時刻 ${refNote.time.toFixed(3)}→${n.time.toFixed(3)} 秒`);
    if (n.button !== refNote.button) diff.push(`コマンド ${CMD[refNote.button]}→${CMD[n.button]}`);
    if (!!n.hold !== !!refNote.hold || (n.hold && Math.abs((n.hold.duration ?? 0) - (refNote.hold.duration ?? 0)) > 5e-4)) diff.push('保持時間');
    return { status: 'changed', obs: observe(n), why: `条件変更（${diff.join('・')}）` };
  }
  return { status: 'ok', obs: observe(n), why: '' };
}

/** 基準から見た 1 ノーツの変化。改善量は絶対誤差の差（基準 − 比較）。入力がない側があれば ms の改善量は作らない */
export function noteChange(base, cur) {
  if (!base || !cur) return { kind: 'na', ms: null, label: '比較不能' };
  const rb = RANK[base.result], rc = RANK[cur.result];
  const ms = base.abs != null && cur.abs != null ? r1(base.abs - cur.abs) : null;
  const tag = (o) => (o.noInput ? '入力なし' : o.result);
  if (rb == null || rc == null) return { kind: 'na', ms, label: '比較不能' };
  if (rc !== rb) {
    const kind = rc > rb ? 'up' : 'down';
    return { kind, ms, label: `${tag(base)}→${tag(cur)}${ms != null ? `（${fmtImp(ms)}）` : ''}` };
  }
  if (ms == null) return { kind: 'same', ms: null, label: base.noInput && cur.noInput ? '入力なしのまま' : '変化なし（誤差は計算できない）' };
  if (ms > 0.05) return { kind: 'up', ms, label: fmtImp(ms) };
  if (ms < -0.05) return { kind: 'down', ms, label: fmtImp(ms) };
  return { kind: 'same', ms: 0, label: '変化なし' };
}
export const fmtImp = (ms) => (ms == null ? '—' : ms > 0 ? `${ms.toFixed(1)}ms 改善` : ms < 0 ? `${Math.abs(ms).toFixed(1)}ms 悪化` : '変化なし');

/** 長押しの保持・解除の変化（押し始めの精度とは別） */
export function holdChange(base, cur) {
  const b = base?.hold?.ok, c = cur?.hold?.ok;
  if (b == null || c == null) return { kind: 'na', label: '記録なし' };
  if (b === c) return { kind: 'same', label: c ? '保持して成功のまま' : '失敗のまま' };
  return c ? { kind: 'up', label: '失敗→保持して成功' } : { kind: 'down', label: '保持して成功→失敗' };
}

/** 集計（入力を合算）: {n, timed, mae, mean, sd, perfect, good, miss, missNoInput, successRate, perfectRate, missRate} */
export function pool(obsList) {
  const list = obsList.filter(Boolean);
  const d = list.filter((o) => o.d != null).map((o) => o.d);
  const k = d.length;
  const mean = k ? d.reduce((a, v) => a + v, 0) / k : null;
  const mae = k ? d.reduce((a, v) => a + Math.abs(v), 0) / k : null;
  const sd = k ? Math.sqrt(d.reduce((a, v) => a + (v - mean) ** 2, 0) / k) : null;
  const c = { PERFECT: 0, GOOD: 0, MISS: 0 };
  for (const o of list) if (c[o.result] != null) c[o.result]++;
  const n = c.PERFECT + c.GOOD + c.MISS;
  const holds = list.filter((o) => o.hold && o.hold.ok != null);
  return {
    n, timed: k, mae: r1(mae), mean: r1(mean), sd: r1(sd), perfect: c.PERFECT, good: c.GOOD, miss: c.MISS,
    missNoInput: list.filter((o) => o.noInput).length,
    successRate: n ? (c.PERFECT + c.GOOD) / n : null, perfectRate: n ? c.PERFECT / n : null, missRate: n ? c.MISS / n : null,
    holdN: holds.length, holdOk: holds.filter((o) => o.hold.ok).length, holdRate: holds.length ? holds.filter((o) => o.hold.ok).length / holds.length : null,
  };
}

// ---------- 複数の記録の比較 ----------
/**
 * records: 比較する記録（2 件以上）。baseId: 改善量の基準（省略時は最も古い記録）。
 * 戻り値: { recs（日時順・色と記号つき）, base, ref（基準の譜面のノーツ）, rows（ノーツごと）, summary（記録ごと）, extras }
 */
export function compareMany(records, baseId = null) {
  const uniq = [...new Map(records.map((r) => [r.id, r])).values()];
  const recs = uniq.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((r, k) => ({ rec: r, ...styleOf(k), k }));
  const base = recs.find((x) => x.rec.id === baseId) || recs[0];
  const ref = base.rec.notes.filter((n) => n.result !== 'SKIP').slice().sort((a, b) => a.time - b.time || BUTTONS.indexOf(a.button) - BUTTONS.indexOf(b.button));
  const rows = ref.map((rn) => {
    const cells = recs.map((x) => ({ id: x.rec.id, ...matchNote(rn, x.rec) }));
    const baseCell = cells.find((c) => c.id === base.rec.id);
    for (const c of cells) {
      c.change = c.id === base.rec.id ? { kind: 'base', ms: null, label: '基準' } : c.status === 'ok' ? noteChange(baseCell.obs, c.obs) : { kind: 'na', ms: null, label: c.why };
      c.holdChange = rn.hold ? (c.id === base.rec.id ? { kind: 'base', label: '基準' } : c.status === 'ok' ? holdChange(baseCell.obs, c.obs) : { kind: 'na', label: c.why }) : null;
    }
    return { note: rn, cells, hasMiss: cells.some((c) => c.status === 'ok' && c.obs.result === 'MISS'),
      improved: cells.some((c) => c.change.kind === 'up'), worsened: cells.some((c) => c.change.kind === 'down') };
  });
  // 記録ごと・技ごとの集計（基準の譜面と対応したノーツだけ）
  const summary = recs.map((x) => {
    const ok = rows.map((row) => row.cells.find((c) => c.id === x.rec.id)).filter((c) => c.status === 'ok');
    const all = pool(ok.map((c) => c.obs));
    const byCmd = Object.fromEntries(BUTTONS.map((b) => [b, pool(ok.filter((c) => c.obs.button === b).map((c) => c.obs))]));
    const kinds = rows.map((row) => row.cells.find((c) => c.id === x.rec.id).change.kind);
    const byCmdChange = Object.fromEntries(BUTTONS.map((b) => [b, {
      up: rows.filter((row) => row.note.button === b && row.cells.find((c) => c.id === x.rec.id).change.kind === 'up').length,
      down: rows.filter((row) => row.note.button === b && row.cells.find((c) => c.id === x.rec.id).change.kind === 'down').length,
    }]));
    return {
      id: x.rec.id, ...all, byCmd, byCmdChange, score: x.rec.summary?.score ?? null,
      up: kinds.filter((k) => k === 'up').length, down: kinds.filter((k) => k === 'down').length, same: kinds.filter((k) => k === 'same').length,
      changed: rows.filter((row) => row.cells.find((c) => c.id === x.rec.id).status === 'changed').length,
      missing: rows.filter((row) => row.cells.find((c) => c.id === x.rec.id).status === 'missing').length,
      extra: x.rec.notes.filter((n) => !ref.some((rn) => rn.id === n.id)).length,
      conditions: x.rec === base.rec ? [] : conditionDiffs(x.rec, base.rec),
      maeImprove: x.rec === base.rec ? null : (summaryMae(base.rec, rows) != null && all.mae != null ? r1(summaryMae(base.rec, rows) - all.mae) : null),
    };
  });
  return { recs, base, ref, rows, summary };
}
function summaryMae(rec, rows) {
  const ok = rows.map((row) => row.cells.find((c) => c.id === rec.id)).filter((c) => c.status === 'ok');
  return pool(ok.map((c) => c.obs)).mae;
}

// ---------- 期間平均の比較 ----------
/** 'YYYY-MM-DD'（現地時間）→ その日の 0 時（現地時間）の Date */
export function localDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}
export const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, k) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + k);
/** 期間 [開始日 0 時, 終了日の翌日 0 時)（現地時間。終了日当日を含む） */
export function periodRange(from, to) {
  const a = localDay(from), b = localDay(to);
  if (!a || !b) return null;
  if (b < a) return null;
  return { from, to, start: a.getTime(), end: addDays(b, 1).getTime() };
}
export const inPeriod = (rec, p) => { const t = Date.parse(rec.at); return t >= p.start && t < p.end; };

/** 期間の選択肢（現地時間。週は月曜はじまり） */
export const PERIOD_PRESETS = Object.freeze([
  ['last7', '直近 7 日間とその前の 7 日間'], ['week', '前週と今週（月曜はじまり）'], ['month', '前月と今月'], ['last30', '直近 30 日間とその前の 30 日間'],
]);
export function presetPeriods(key, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (key === 'week') {
    const mon = addDays(today, -((today.getDay() + 6) % 7));
    return { A: [ymd(addDays(mon, -7)), ymd(addDays(mon, -1))], B: [ymd(mon), ymd(addDays(mon, 6))] };
  }
  if (key === 'month') {
    const first = new Date(today.getFullYear(), today.getMonth(), 1);
    const prevFirst = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    return { A: [ymd(prevFirst), ymd(addDays(first, -1))], B: [ymd(first), ymd(new Date(today.getFullYear(), today.getMonth() + 1, 0))] };
  }
  const n = key === 'last30' ? 30 : 7;
  return { A: [ymd(addDays(today, -(2 * n - 1))), ymd(addDays(today, -n))], B: [ymd(addDays(today, -(n - 1))), ymd(today)] };
}

/** 集計条件のまとまり（同じ譜面・判定幅・再生速度・入力補正）。キーと説明 */
const COND_KEYS = ['perfectWindowMs', 'goodWindowMs', 'missWindowMs', 'holdStartWindowMs', 'holdReleaseWindowMs', 'inputOffsetMs'];
export const condKey = (r) => [r.chart.hash, ...COND_KEYS.map((k) => r.settings[k]), r.rate].join('|');
export function condLabel(r) {
  const s = r.settings;
  return `譜面 ${r.chart.title || ''}（識別 ${r.chart.hash}）・判定幅 P±${s.perfectWindowMs}/G±${s.goodWindowMs}/M±${s.missWindowMs}・息 ±${s.holdStartWindowMs}/早離し ${s.holdReleaseWindowMs}ms・入力補正 ${s.inputOffsetMs}ms・速度 ${r.rate}×`;
}

/** 同じプレイの重複（JSON から取り込んだ複製など）を除く: ID と内容（日時・譜面・スコア・入力）の両方で判定 */
export function dedupe(records) {
  const ids = new Set(), keys = new Set(), out = [], dup = [];
  for (const r of records) {
    const key = [r.at, r.startedAt, r.mode, r.kind, condKey(r), r.summary?.score, r.notes.map((n) => n.input?.time ?? '-').join(',')].join('|');
    if (ids.has(r.id) || keys.has(key)) { dup.push(r); continue; }
    ids.add(r.id); keys.add(key); out.push(r);
  }
  return { records: out, duplicates: dup };
}

/**
 * 期間平均の比較。opts: { A: [from, to], B: [from, to], cond: condKey（基準の条件）, ref: 基準の記録（譜面のノーツ）,
 *   includeAuto, includePractice, includeAborted, mixCharts（譜面が違う記録もノーツ単位で照合） }
 */
export function comparePeriods(history, opts) {
  const pA = periodRange(...opts.A), pB = periodRange(...opts.B);
  if (!pA || !pB) return { error: '期間の日付が正しくありません（開始日 ≦ 終了日）' };
  const { records: all, duplicates } = dedupe(history);
  const ref = opts.ref;
  const refNotes = ref.notes.filter((n) => n.result !== 'SKIP').slice().sort((a, b) => a.time - b.time);
  const sameSettings = (r) => COND_KEYS.every((k) => r.settings[k] === ref.settings[k]) && r.rate === ref.rate;
  const reasons = {};
  const why = (r) => {
    if (r.mode === 'auto' && !opts.includeAuto) return 'AUTO';
    if (r.kind === 'practice' && !opts.includePractice) return '練習';
    if (r.kind === 'aborted' && !opts.includeAborted) return '途中終了';
    if (!sameSettings(r)) return '判定幅・速度・入力補正が違う';
    if (r.chart.hash !== ref.chart.hash && !opts.mixCharts) return '譜面が違う';
    return null;
  };
  const pick = (p) => {
    const inP = all.filter((r) => inPeriod(r, p));
    const used = [];
    for (const r of inP) { const w = why(r); if (w) reasons[w] = (reasons[w] || 0) + 1; else used.push(r); }
    return used.sort((a, b) => (a.at < b.at ? -1 : 1));
  };
  const recA = pick(pA), recB = pick(pB);
  const overlap = recA.filter((r) => recB.includes(r)).map((r) => r.id);
  const excludedNotes = [];
  const agg = (recs) => {
    const perNote = new Map(refNotes.map((n) => [n.id, []]));
    let scoreSum = 0;
    for (const r of recs) {
      let pts = 0;
      for (const rn of refNotes) {
        const m = matchNote(rn, r);
        if (m.status !== 'ok') { excludedNotes.push({ record: r.id, note: rn.id, reason: m.why }); continue; }
        perNote.get(rn.id).push(m.obs);
        pts += r.notes.find((x) => x.id === rn.id).points || 0;
      }
      scoreSum += pts;
    }
    const obs = [...perNote.values()].flat();
    return {
      plays: recs.length, ids: recs.map((r) => r.id), avgScore: recs.length ? Math.round(scoreSum / recs.length) : null,
      all: pool(obs),
      byCmd: Object.fromEntries(BUTTONS.map((b) => [b, pool(obs.filter((o) => o.button === b))])),
      perNote: Object.fromEntries([...perNote].map(([id, l]) => [id, pool(l)])),
    };
  };
  const A = agg(recA), B = agg(recB);
  const diff = (a, b) => periodDiff(a, b);
  return {
    periods: { A: pA, B: pB }, A, B, overlap, duplicates: duplicates.map((r) => r.id), excludedRecords: reasons,
    excludedNotes: dedupNotes(excludedNotes), refNotes: refNotes.map((n) => ({ id: n.id, time: n.time, button: n.button, hold: !!n.hold })),
    all: diff(A.all, B.all), score: { a: A.avgScore, b: B.avgScore, diff: A.avgScore != null && B.avgScore != null ? B.avgScore - A.avgScore : null },
    byCmd: Object.fromEntries(BUTTONS.map((b) => [b, diff(A.byCmd[b], B.byCmd[b])])),
    notes: refNotes.map((n) => ({ id: n.id, time: n.time, button: n.button, hold: !!n.hold, ...diff(A.perNote[n.id], B.perNote[n.id]) })),
  };
}
function dedupNotes(list) {
  const m = new Map();
  for (const x of list) { const k = `${x.note}|${x.reason}`; const v = m.get(k) || { note: x.note, reason: x.reason, records: 0 }; v.records++; m.set(k, v); }
  return [...m.values()];
}

/** 期間 A（基準）→ 期間 B の差。maeImprove = A − B（プラスが改善）、率はポイント（B − A） */
export function periodDiff(a, b) {
  const has = (x) => x && x.n > 0;
  const imp = has(a) && has(b) && a.mae != null && b.mae != null ? r1(a.mae - b.mae) : null;
  const pctOf = (x, y) => (x == null || y == null ? null : Math.round((y - x) * 1000) / 10);
  return {
    a, b,
    maeImprove: imp,
    maeImprovePct: imp == null || !a.mae ? null : Math.round((imp / a.mae) * 1000) / 10, // 基準が 0 なら計算しない
    sdImprove: has(a) && has(b) && a.sd != null && b.sd != null ? r1(a.sd - b.sd) : null,
    meanShift: has(a) && has(b) && a.mean != null && b.mean != null ? r1(b.mean - a.mean) : null,
    successPt: has(a) && has(b) ? pctOf(a.successRate, b.successRate) : null,
    perfectPt: has(a) && has(b) ? pctOf(a.perfectRate, b.perfectRate) : null,
    missPt: has(a) && has(b) ? pctOf(a.missRate, b.missRate) : null,
    holdPt: has(a) && has(b) ? pctOf(a.holdRate, b.holdRate) : null,
    status: !has(a) || !has(b) ? 'na' : imp == null ? 'na' : imp > 0.05 ? 'up' : imp < -0.05 ? 'down' : 'same',
  };
}

/** 書き出し（CSV）: 期間平均の比較のノーツ別の表と全体 */
export function periodCsv(res, condText) {
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [];
  lines.push(['# 期間平均の比較', `A=${res.periods.A.from}〜${res.periods.A.to}`, `B=${res.periods.B.from}〜${res.periods.B.to}`, condText].map(q).join(','));
  lines.push(['区分', 'ノーツID', '時刻', 'コマンド', 'A 平均絶対誤差ms', 'B 平均絶対誤差ms', '改善量ms(A-B)', '改善率%', 'A 平均符号付きms', 'B 平均符号付きms', 'A ばらつきms', 'B ばらつきms',
    'A 成功率%', 'B 成功率%', 'A 誤差の件数', 'B 誤差の件数', 'A MISS', 'B MISS', 'A ノーツ数', 'B ノーツ数', 'A 保持成功率%', 'B 保持成功率%'].map(q).join(','));
  const row = (kind, id, time, cmd, d) => [kind, id, time, cmd, d.a?.mae, d.b?.mae, d.maeImprove, d.maeImprovePct, d.a?.mean, d.b?.mean, d.a?.sd, d.b?.sd,
    d.a?.successRate == null ? null : (d.a.successRate * 100).toFixed(1), d.b?.successRate == null ? null : (d.b.successRate * 100).toFixed(1),
    d.a?.timed, d.b?.timed, d.a?.miss, d.b?.miss, d.a?.n, d.b?.n,
    d.a?.holdRate == null ? null : (d.a.holdRate * 100).toFixed(1), d.b?.holdRate == null ? null : (d.b.holdRate * 100).toFixed(1)].map(q).join(',');
  lines.push(row('全体', '', '', '', res.all));
  for (const b of BUTTONS) lines.push(row('技', '', '', CMD[b], res.byCmd[b]));
  for (const n of res.notes) lines.push(row('ノーツ', n.id, n.time.toFixed(3), CMD[n.button], n));
  return `﻿${lines.join('\r\n')}\r\n`;
}
