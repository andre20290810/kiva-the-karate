// 入力ログの再現（純粋ロジック・DOM 非依存。ブラウザのリプレイ・公式デモの作成・サーバーの検証で共通）。
// ログは判定処理（Judge）への呼び出しそのもの: 押下・解除・長押しの取り消しを、呼ばれた順に記録する。
//   [種類, ボタン, 判定に使った時刻（入力補正の後）, 補正前の時刻, その直前に判定を進めた時刻, 入力方法, 入力元]
// 再現では「直前に判定を進めた時刻」まで update してから同じ呼び出しをするので、描画の間隔に関係なく同じ判定・コンボ・スコアになる。
// 入力補正は記録した「判定に使った時刻」をそのまま使う（二重に補正しない）。同じ時刻の入力も記録した順に処理する。

import { Judge } from './judge.js';
import { buildRecord } from './score.js';

/** 判定ロジックの版（判定の結果が変わる変更をしたら上げる。版が違う記録は再計算しない） */
export const JUDGE_VERSION = 2;
export const LOG_VERSION = 1;
export const REPLAY_MISSING = 'この履歴はリプレイに必要な記録がありません';

/** 譜面のノーツの写し（判定に関わる値だけ） */
export const snapshotNotes = (notes) => notes.map((n) => {
  const o = { id: n.id, time: n.time, button: n.button, input: n.input };
  if (n.input === 'hold') o.duration = n.duration;
  return o;
});

/** 記録がリプレイできるか: { ok, reason } */
export function replayable(rec) {
  const r = rec?.replay;
  if (!r || !Array.isArray(r.events) || !Array.isArray(r.notes) || r.startT == null) return { ok: false, reason: REPLAY_MISSING };
  if (r.v !== LOG_VERSION) return { ok: false, reason: `入力ログの形式（v${r.v}）に対応していません` };
  if (r.judgeVersion !== JUDGE_VERSION) return { ok: false, reason: `この履歴は判定ロジックの版 ${r.judgeVersion ?? '不明'} で記録されています（今は版 ${JUDGE_VERSION}）。別の結果に再計算しないため、再現しません` };
  return { ok: true, reason: '' };
}

/**
 * 1 つのログの呼び出しを判定へ渡す（k: 何番目か。入力 ID の重複防止用）
 * e = [kind, button, time, raw, at, device, source]
 */
export function applyEvent(judge, e, k, prefix = 'rp') {
  const [kind, button, time, raw, at, device, source] = e;
  if (at != null) judge.update(at);
  if (kind === 'd') return judge.press(button, time, { id: `${prefix}:${k}`, raw, device, source });
  if (kind === 'u') return judge.release(button, time, { raw, device, source });
  if (kind === 'c') { judge.cancelHolds(); return null; }
  return null;
}

/**
 * ログを判定へ通す。until: この時刻（補正前の時刻 = 再生の時間軸）までの入力を処理する（省略 = 全部）。
 * 戻り値: { judge, next }（next = まだ処理していない最初のログの番号）
 */
export function simulate({ notes, settings, startT, events, until = Infinity, endT = null, onJudge = null, prefix = 'rp' }) {
  const judge = new Judge(notes, settings);
  if (onJudge) judge.on(onJudge);
  judge.resetFrom(startT);
  let k = 0;
  for (; k < events.length; k++) {
    const e = events[k];
    if (eventClock(e) > until) break;
    applyEvent(judge, e, k, prefix);
  }
  // 時刻を進める。次の入力がある場合は、その入力の直前に判定を進めた時刻を越えない（越えると判定の順番が変わる）
  const next = events[k];
  const to = until === Infinity ? (endT ?? judge.lastUpdate) : Math.min(until, next?.[4] ?? until);
  if (to != null) judge.update(to);
  return { judge, next: k };
}

/** ログの入力が起きた再生の時刻（補正前の時刻。取り消しは直前に判定を進めた時刻） */
export const eventClock = (e) => (e[0] === 'c' ? (e[4] ?? 0) : e[3]);

/** 記録をログから作り直す（保存した判定条件・譜面の写し・開始と終了の時刻で） */
export function rebuildRecord(rec) {
  const r = rec.replay;
  const { judge } = simulate({ notes: r.notes, settings: rec.settings, startT: r.startT, events: r.events, endT: r.endT });
  return buildRecord(judge, {
    chart: { title: rec.chart.title, gameVersion: rec.chart.gameVersion, notes: r.notes },
    settings: rec.settings, rate: rec.rate, mode: rec.mode, kind: rec.kind, practiceReasons: rec.practiceReasons,
    bgm: rec.bgm, startedAt: rec.startedAt, endedAt: rec.at, chartSource: rec.chart.source, startT: r.startT, endT: r.endT,
    duration: rec.chart.duration, id: rec.id,
  });
}

/**
 * 保存された判定・スコア・コンボ・誤差と、ログから計算し直した結果が一致するか。
 * 戻り値: { ok, reason, diffs: [文字列] }
 */
export function verifyRecord(rec) {
  const can = replayable(rec);
  if (!can.ok) return { ok: false, reason: can.reason, diffs: [] };
  let fresh;
  try { fresh = rebuildRecord(rec); } catch (e) { return { ok: false, reason: `ログを判定できません: ${e.message}`, diffs: [] }; }
  const diffs = [];
  const pick = (n) => JSON.stringify({ r: n.result, p: n.points, reason: n.reason, i: n.input ? [n.input.time, n.input.button, n.input.deltaMs] : null,
    h: n.hold ? [n.hold.pressedAt, n.hold.releasedAt, n.hold.status, n.hold.completedAt] : null });
  const a = new Map(rec.notes.map((n) => [n.id, n])), b = new Map(fresh.notes.map((n) => [n.id, n]));
  if (a.size !== b.size) diffs.push(`ノーツ数 ${a.size} ≠ ${b.size}`);
  for (const [id, n] of b) { const m = a.get(id); if (!m) diffs.push(`${id}: 記録にない`); else if (pick(m) !== pick(n)) diffs.push(`${id}: 記録 ${pick(m)} ≠ 計算 ${pick(n)}`); }
  const ex = (l) => JSON.stringify((l || []).map((x) => [x.time, x.button]));
  if (ex(rec.extras) !== ex(fresh.extras)) diffs.push('余分な入力が一致しない');
  for (const k of ['score', 'maxCombo', 'perfect', 'good', 'miss', 'timed', 'maeMs', 'meanMs', 'sdMs']) {
    if (rec.summary?.[k] !== fresh.summary[k]) diffs.push(`${k}: 記録 ${rec.summary?.[k]} ≠ 計算 ${fresh.summary[k]}`);
  }
  if (rec.judge?.maxCombo !== fresh.judge.maxCombo) diffs.push('最大コンボが一致しない');
  return { ok: diffs.length === 0, reason: diffs.length ? '保存された結果と入力ログから計算した結果が一致しません' : '', diffs, fresh };
}
