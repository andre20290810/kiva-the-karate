// 成績の記録・集計・比較（純粋ロジック・DOM 非依存）。
// ずれ（ms）= 入力時刻 − 正解時刻（マイナス = 早い、プラス = 遅い）。譜面の時間軸の ms（判定と同じ基準。再生速度 0.5 倍なら実時間は 2 倍）。
// 集計の対象は「入力があったノーツ」（PERFECT・GOOD・入力のある MISS）。入力のない MISS は件数だけ数え、ずれの集計から外す。
// 長押し（息）のずれは押し始めのずれ。離した時刻・保持時間は別に記録する。

export const RECORD_SCHEMA = 'kiva-score/1';
export const CMD = Object.freeze({ Y: '息', X: '構', A: '撃', B: '旋' });
export const DEVICE_LABEL = Object.freeze({ keyboard: 'キーボード', touch: 'タッチ', mouse: 'マウス', pen: 'ペン', gamepad: 'ゲームパッド', auto: 'AUTO' });
export const KIND_LABEL = Object.freeze({ full: '通しプレイ', aborted: '途中終了', practice: '練習' });
/** 比較の条件（同じなら同条件） */
export const CONDITION_KEYS = Object.freeze(['chartHash', 'perfectWindowMs', 'goodWindowMs', 'missWindowMs', 'holdStartWindowMs', 'holdReleaseWindowMs', 'inputOffsetMs', 'rate']);

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

/** 文字列の指紋（FNV-1a 32bit） */
export function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** 譜面の識別（判定に関わるノーツの内容: ID・時刻・ボタン・入力方式・長押し時間）。表示名・エフェクト・メモは含めない */
export function chartHash(chart) {
  const key = chart.notes.map((n) => [n.id, n.time, n.button, n.input, n.input === 'hold' ? n.duration : 0].join(':')).sort().join('|');
  return fingerprint(key);
}

/**
 * プレイの記録を作る。judge: 判定の状態、ctx: {chart, settings, rate, mode, kind, bgm, startedAt, endedAt, chartSource, startT, endT}
 * 記録はそのまま保存・書き出しできる値だけ（関数・循環参照なし）
 */
export function buildRecord(judge, ctx) {
  const s = ctx.settings;
  const notes = judge.notes.filter((n) => n.result && (ctx.includeSkip || n.result !== 'SKIP')).map((n) => {
    const o = { id: n.id, button: n.button, cmd: CMD[n.button], time: r3(n.time), result: n.result, reason: n.reason ?? null, points: n.points };
    o.input = n.hit ? { time: r3(n.hit.time), raw: r3(n.hit.raw), button: n.hit.button, device: n.hit.device, deltaMs: r1(n.hit.deltaMs), rawDeltaMs: r1(n.hit.rawDeltaMs) } : null;
    if (n.input === 'hold') {
      o.hold = {
        duration: r3(n.duration), requiredSec: r3(Math.max(0, n.duration - s.holdReleaseWindowMs / 1000)), end: r3(n.time + n.duration),
        pressedAt: n.hit ? r3(n.hit.time) : null,
        releasedAt: n.release ? r3(n.release.time) : null,               // ユーザーが実際に離した時刻（自動の完了時刻ではない）
        releaseDeltaMs: n.release ? r1(n.release.deltaMs) : null,        // 離した時刻 − 終了時刻
        heldSec: n.hit && n.release ? r3(n.release.time - n.hit.time) : null,
        completedAt: n.completedAt != null ? r3(n.completedAt) : null,   // 必要な時間を保持して成功が確定した時刻
        status: holdStatus(n),
      };
    }
    return o;
  });
  const extras = judge.strays.map((x) => ({ time: r3(x.time), raw: r3(x.raw), button: x.button, cmd: CMD[x.button], device: x.device }));
  const devices = [...new Set([...notes.map((n) => n.input?.device), ...extras.map((x) => x.device)].filter(Boolean))];
  const rec = {
    schema: RECORD_SCHEMA,
    id: ctx.id ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: ctx.endedAt ?? new Date().toISOString(),
    startedAt: ctx.startedAt ?? null,
    mode: ctx.mode,                 // manual | auto
    kind: ctx.kind,                 // full | aborted | practice
    practiceReasons: ctx.practiceReasons ?? [],
    devices,
    chart: { title: ctx.chart.title ?? '', gameVersion: ctx.chart.gameVersion, notes: ctx.chart.notes.length, hash: chartHash(ctx.chart), source: ctx.chartSource ?? null },
    settings: Object.fromEntries(['perfectWindowMs', 'goodWindowMs', 'missWindowMs', 'holdStartWindowMs', 'holdReleaseWindowMs', 'inputOffsetMs'].map((k) => [k, s[k]])),
    rate: ctx.rate,
    timeBase: 'timeline',            // ずれは譜面の時間軸の ms（判定と同じ基準）
    bgm: ctx.bgm ?? null,
    range: { from: r3(ctx.startT ?? null), to: r3(ctx.endT ?? null) },
    judge: { score: 0, maxCombo: judge.maxCombo },
    notes, extras,
  };
  rec.judge.score = notes.reduce((a, n) => a + (n.points || 0), 0);
  rec.summary = summarize(rec);
  return rec;
}

function holdStatus(n) {
  if (n.result === 'SKIP') return 'skipped';
  if (!n.hit) return 'not-pressed';
  if (n.reason === 'early-release') return 'early-release';
  if (n.result === 'MISS') return 'start-miss';
  if (n.reason === 'completed') return n.release ? 'completed-released' : 'completed-held';
  if (n.reason === 'released') return 'released-in-window';
  if (n.holding) return 'holding';
  return n.reason ?? 'unknown';
}

export const HOLD_STATUS_LABEL = Object.freeze({
  'completed-released': '保持して成功（その後に離した）', 'completed-held': '保持して成功（離す前に終了）', 'released-in-window': '終了の許容内で離して成功',
  'early-release': '早離し（途中解除）', 'start-miss': '押し始めが範囲外', 'not-pressed': '押していない', skipped: '対象外', holding: '保持中',
});

/** 集計（記録から計算する。記録の数値と表示が必ず一致する） */
export function summarize(rec) {
  const sel = (fn) => rec.notes.filter(fn);
  const counted = sel((n) => n.result !== 'SKIP');
  const stat = (list) => {
    const c = { PERFECT: 0, GOOD: 0, MISS: 0 };
    for (const n of list) if (c[n.result] != null) c[n.result]++;
    const withInput = list.filter((n) => n.input && n.input.deltaMs != null);
    const d = withInput.map((n) => n.input.deltaMs);
    const k = d.length;
    const mean = k ? d.reduce((a, v) => a + v, 0) / k : null;
    const mae = k ? d.reduce((a, v) => a + Math.abs(v), 0) / k : null;      // 絶対値の平均（早い・遅いを相殺しない）
    const sd = k ? Math.sqrt(d.reduce((a, v) => a + (v - mean) ** 2, 0) / k) : null; // 標準偏差（母分散）
    const total = list.length;
    return {
      total, perfect: c.PERFECT, good: c.GOOD, miss: c.MISS,
      missNoInput: list.filter((n) => n.result === 'MISS' && !n.input).length,
      missWithInput: list.filter((n) => n.result === 'MISS' && n.input).length,
      timed: k, successRate: total ? (c.PERFECT + c.GOOD) / total : null,
      maeMs: r1(mae), meanMs: r1(mean), sdMs: r1(sd),
      early: d.filter((v) => v < 0).length, late: d.filter((v) => v > 0).length,
    };
  };
  const all = stat(counted);
  const byCmd = {};
  for (const b of ['Y', 'X', 'A', 'B']) byCmd[b] = stat(counted.filter((n) => n.button === b));
  return { ...all, score: rec.judge.score, maxCombo: rec.judge.maxCombo, extras: rec.extras.length, skipped: rec.notes.length - counted.length, byCmd };
}

/** 条件の違い（同じ譜面・判定幅・速度・入力補正なら空） */
export function conditionDiffs(a, b) {
  const v = (r, k) => (k === 'chartHash' ? r.chart.hash : k === 'rate' ? r.rate : r.settings[k]);
  const NAME = { chartHash: '譜面', perfectWindowMs: 'PERFECT 幅', goodWindowMs: 'GOOD 幅', missWindowMs: '許容限界', holdStartWindowMs: '息の押し始め', holdReleaseWindowMs: '息の早離しの許容', inputOffsetMs: '入力補正', rate: '再生速度' };
  const out = [];
  for (const k of CONDITION_KEYS) if (v(a, k) !== v(b, k)) out.push({ key: k, name: NAME[k], a: v(a, k), b: v(b, k) });
  return out;
}
export const sameConditions = (a, b) => conditionDiffs(a, b).length === 0;

/** 比較の候補: 前回（同条件・同じ区分の手動）、同条件の自己ベスト（手動・通しプレイ）。AUTO は対象外 */
export function comparisonTargets(rec, history) {
  const others = history.filter((h) => h.id !== rec.id && h.mode === 'manual' && h.at <= rec.at);
  const same = others.filter((h) => sameConditions(h, rec));
  const byTime = (x, y) => (x.at < y.at ? 1 : -1);
  const previous = same.filter((h) => h.kind === rec.kind).sort(byTime)[0] || same.sort(byTime)[0] || null;
  const fulls = history.filter((h) => h.id !== rec.id && h.mode === 'manual' && h.kind === 'full' && sameConditions(h, rec));
  const best = fulls.sort((x, y) => (y.summary.score - x.summary.score) || ((x.summary.maeMs ?? 1e9) - (y.summary.maeMs ?? 1e9)))[0] || null;
  return { previous, best };
}

/** 2 つの記録の比較（cur − base）。maeImproveMs はプラスが改善（ずれが小さくなった） */
export function compareRecords(cur, base) {
  const d = (x, y) => (x == null || y == null ? null : r1(x - y));
  const rate = (x, y) => (x == null || y == null ? null : Math.round((x - y) * 1000) / 10); // ポイント
  const byCmd = {};
  for (const b of ['Y', 'X', 'A', 'B']) {
    const c = cur.summary.byCmd[b], p = base.summary.byCmd[b];
    byCmd[b] = { successRatePt: rate(c.successRate, p.successRate), maeImproveMs: d(p.maeMs, c.maeMs), meanShiftMs: d(c.meanMs, p.meanMs), cur: c, base: p };
  }
  const pairs = [];
  if (cur.chart.hash === base.chart.hash) {
    const bm = new Map(base.notes.map((n) => [n.id, n]));
    for (const n of cur.notes) {
      const o = bm.get(n.id);
      if (o) pairs.push({ id: n.id, button: n.button, cmd: n.cmd, time: n.time, cur: n.input?.deltaMs ?? null, base: o.input?.deltaMs ?? null, curResult: n.result, baseResult: o.result });
    }
  }
  return {
    conditions: conditionDiffs(cur, base), sameChart: cur.chart.hash === base.chart.hash,
    scoreDiff: cur.summary.score - base.summary.score,
    successRatePt: rate(cur.summary.successRate, base.summary.successRate),
    maeImproveMs: d(base.summary.maeMs, cur.summary.maeMs),
    meanShiftMs: d(cur.summary.meanMs, base.summary.meanMs),
    sdImproveMs: d(base.summary.sdMs, cur.summary.sdMs),
    byCmd, pairs,
  };
}

/** 成績 JSON の検証（譜面 JSON とは別物）。正しければ null、違えば理由 */
export function recordError(r) {
  if (!r || typeof r !== 'object') return '記録の形式が不正です';
  if (r.schema !== RECORD_SCHEMA) return r.schemaVersion != null && Array.isArray(r.notes) ? '譜面 JSON です（成績 JSON ではありません）' : `未知の形式です（${r.schema}）`;
  if (typeof r.id !== 'string' || typeof r.at !== 'string' || !['manual', 'auto'].includes(r.mode) || !['full', 'aborted', 'practice'].includes(r.kind)) return '記録の項目が不足しています';
  if (!Array.isArray(r.notes) || !Array.isArray(r.extras) || !r.settings || !r.chart?.hash) return '記録の項目が不足しています';
  return null;
}
