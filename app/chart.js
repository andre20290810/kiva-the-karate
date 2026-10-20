// 譜面 JSON（schemaVersion 1）の検証・正規化・書き出し。DOM に依存しない純粋ロジック。
// 時間はすべて「連続画像の開始 = 0 秒」の同じ時間軸の秒数。形式の説明は README「譜面 JSON」。

export const SCHEMA_VERSION = 1;
export const BUTTONS = ['Y', 'X', 'A', 'B'];

// ボタン → 使える action・入力方式・既定の表示名とエフェクト
export const BUTTON_INFO = Object.freeze({
  Y: { meaning: '呼吸', input: 'hold', actions: ['breathe'], defaultAction: 'breathe', preset: 'breath' },
  X: { meaning: '構え', input: 'tap', actions: ['stance'], defaultAction: 'stance', preset: 'stance' },
  A: { meaning: '打撃', input: 'tap', actions: ['punch', 'kick', 'strike'], defaultAction: 'punch', preset: 'strike' },
  B: { meaning: '旋回', input: 'tap', actions: ['turn'], defaultAction: 'turn', preset: 'turn' },
});
export const ACTION_LABEL = Object.freeze({
  breathe: '呼吸', stance: '構え', punch: '正拳突き', kick: '蹴り', strike: '打撃', turn: '旋回',
});
export const EFFECT_PRESETS = ['breath', 'stance', 'strike', 'turn'];

export const DEFAULT_SETTINGS = Object.freeze({
  inputOffsetMs: 0,        // + にすると入力を遅い側へ補正（入力時刻からこの分を引いて判定）
  perfectWindowMs: 60,
  goodWindowMs: 120,
  missWindowMs: 180,       // これより外の入力はどのノーツにも当てない（空振り）
  holdReleaseWindowMs: 150, // 長押しの終了より この分 早く離しても成功
  leadInSeconds: 2,        // 開始前の待ち時間（この間は 0 秒のコマを表示）
  laneLeadSeconds: 2.4,    // レーンの右端から判定位置まで流れる時間（縦横で同じ）
});
export const DEFAULT_DISPLAY = Object.freeze({
  subjectAnchor: { x: 0.5, y: 0.5 },
  referenceHeightRatio: 0.55,
  frameOverrides: {},
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * 譜面 JSON を検証する。現在の編集内容は変更しない。
 * @returns {{errors:string[], warnings:string[]}}
 */
/** 譜面の対象バージョン（gameVersion が無い従来の JSON は ver1） */
export const chartVersion = (chart) => (chart && chart.gameVersion != null ? chart.gameVersion : 'v1');
const VERSION_LABEL = (v) => String(v).replace(/^v/, 'ver');

export function validateChart(chart, { frameCount, durationSeconds, gameVersion } = {}) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  if (!chart || typeof chart !== 'object' || Array.isArray(chart)) return { errors: ['JSON の中身がオブジェクトではありません'], warnings };
  if (chart.schemaVersion !== SCHEMA_VERSION) {
    err(`schemaVersion が ${JSON.stringify(chart.schemaVersion)} です（対応しているのは ${SCHEMA_VERSION}）`);
    return { errors, warnings };
  }
  if (chart.gameVersion != null && !/^v\d+$/.test(String(chart.gameVersion))) err(`gameVersion が ${JSON.stringify(chart.gameVersion)} です（"v1" や "v2"）`);
  else if (gameVersion != null && chartVersion(chart) !== gameVersion) {
    err(`この JSON は ${VERSION_LABEL(chartVersion(chart))} 用の譜面です（今は ${VERSION_LABEL(gameVersion)}）。${VERSION_LABEL(chartVersion(chart))} に切り替えてから読み込んでください`);
    return { errors, warnings };
  }
  const src = chart.source || {};
  const dur = durationSeconds ?? src.durationSeconds;
  if (!isNum(dur) || dur <= 0) err('source.durationSeconds（全体の長さ・秒）がありません');
  if (frameCount != null && src.frameCount != null && src.frameCount !== frameCount) {
    err(`この譜面は ${src.frameCount} 枚の連続画像用です（読み込み済みの画像は ${frameCount} 枚）`);
  }
  if (!Array.isArray(chart.notes)) { err('notes（ノーツの配列）がありません'); return { errors, warnings }; }
  const seqIds = new Set();
  for (const s of chart.sequences || []) {
    if (!s || typeof s.id !== 'string' || !s.id) { err('sequences に id のない項目があります'); continue; }
    if (seqIds.has(s.id)) err(`連続コマンド ID「${s.id}」が重複しています`);
    seqIds.add(s.id);
  }
  const asrc = chart.audio?.src;
  if (asrc != null && !(typeof asrc === 'string' || (Array.isArray(asrc) && asrc.length && asrc.every((x) => typeof x === 'string' && x)))) {
    err('audio.src は音声ファイルのパス（文字列）か、その配列（先頭から順に試す）です');
  }
  const st = { ...DEFAULT_SETTINGS, ...(chart.settings || {}) };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (!isNum(st[k])) err(`settings.${k} が数値ではありません`);
  if (!(st.perfectWindowMs > 0 && st.perfectWindowMs <= st.goodWindowMs && st.goodWindowMs <= st.missWindowMs)) {
    err('判定幅は 0 < PERFECT ≤ GOOD ≤ 許容限界 の順にしてください');
  }
  if (st.laneLeadSeconds < 0.5) err('settings.laneLeadSeconds は 0.5 秒以上にしてください');
  const ids = new Set();
  chart.notes.forEach((n, k) => {
    const at = `ノーツ ${n?.id ?? `#${k + 1}`}`;
    if (!n || typeof n !== 'object') { err(`${at}: 形式が不正です`); return; }
    if (typeof n.id !== 'string' || !n.id) err(`${at}: id がありません`);
    else if (ids.has(n.id)) err(`${at}: id が重複しています`);
    ids.add(n.id);
    const info = BUTTON_INFO[n.button];
    if (!info) { err(`${at}: button は Y / X / A / B のいずれかです（${JSON.stringify(n.button)}）`); return; }
    if (!info.actions.includes(n.action)) err(`${at}: ${n.button} には action「${n.action}」を使えません（使えるもの: ${info.actions.join(', ')}）`);
    if (n.input !== info.input) err(`${at}: ${n.button} の入力方式は ${info.input} です（${n.input}）`);
    if (!isNum(n.time) || n.time < 0 || (isNum(dur) && n.time > dur)) err(`${at}: time ${n.time} が範囲外です（0〜${dur} 秒）`);
    if (n.input === 'hold') {
      if (!isNum(n.duration) || n.duration < 0.2) err(`${at}: 長押し時間 duration は 0.2 秒以上の数値にしてください`);
      else if (isNum(dur) && n.time + n.duration > dur + 1e-6) err(`${at}: 長押しが全体の長さを超えています`);
    } else if (n.duration != null && n.duration !== 0) {
      err(`${at}: 単押しノーツに duration は指定できません`);
    }
    if (n.sequenceId != null && !seqIds.has(n.sequenceId)) err(`${at}: 連続コマンド「${n.sequenceId}」が sequences にありません`);
    const e = n.effect;
    if (e != null) {
      if (typeof e !== 'object') err(`${at}: effect の形式が不正です`);
      else {
        if (e.preset != null && !EFFECT_PRESETS.includes(e.preset)) err(`${at}: 未知のエフェクト ${e.preset}`);
        if (e.anchor != null && !(isNum(e.anchor.x) && isNum(e.anchor.y) && e.anchor.x >= 0 && e.anchor.x <= 1 && e.anchor.y >= 0 && e.anchor.y <= 1)) err(`${at}: effect.anchor は 0〜1 の x, y です`);
        if (e.direction != null && !(isNum(e.direction.x) && isNum(e.direction.y) && Math.hypot(e.direction.x, e.direction.y) > 1e-6)) err(`${at}: effect.direction は 0 でない x, y です`);
        if (e.intensity != null && !(isNum(e.intensity) && e.intensity >= 0 && e.intensity <= 2)) err(`${at}: effect.intensity は 0〜2 です`);
      }
    }
  });
  // 同じボタンのノーツの重なり
  const sorted = chart.notes.filter((n) => n && BUTTON_INFO[n.button] && isNum(n.time)).sort((a, b) => a.time - b.time);
  for (let i = 1; i < sorted.length; i++) {
    for (let j = i - 1; j >= 0 && sorted[i].time - sorted[j].time < 30; j--) {
      const a = sorted[j], b = sorted[i];
      if (a.button !== b.button) continue;
      const end = a.time + (a.input === 'hold' ? a.duration || 0 : 0);
      if (b.time <= end + 1e-6) err(`ノーツ ${b.id}: 同じ ${b.button} の長押し ${a.id} と重なっています`);
      else if (b.time - a.time < 0.12) warnings.push(`ノーツ ${a.id} と ${b.id} が 0.12 秒未満の間隔です（同じボタン）`);
      break;
    }
  }
  const ov = chart.display?.frameOverrides;
  if (ov != null) {
    if (typeof ov !== 'object' || Array.isArray(ov)) err('display.frameOverrides の形式が不正です');
    else for (const [k, v] of Object.entries(ov)) {
      const i = Number(k);
      if (!Number.isInteger(i) || i < 0 || (frameCount != null && i >= frameCount)) err(`frameOverrides: フレーム番号 ${k} が範囲外です`);
      if (!v || !['dx', 'dy', 'scale'].every((p) => v[p] == null || isNum(v[p]))) err(`frameOverrides[${k}]: dx, dy, scale は数値です`);
      else if (v.scale != null && !(v.scale > 0.2 && v.scale < 5)) err(`frameOverrides[${k}]: scale は 0.2〜5 です`);
    }
  }
  const d = chart.display || {};
  if (d.referenceHeightRatio != null && !(isNum(d.referenceHeightRatio) && d.referenceHeightRatio > 0.1 && d.referenceHeightRatio <= 1)) err('display.referenceHeightRatio は 0.1〜1 です');
  return { errors, warnings };
}

/** 検証済みの譜面を、欠けた既定値を補った新しいオブジェクトにする（元は変更しない）。 */
export function normalizeChart(chart) {
  const c = structuredClone(chart);
  c.gameVersion = chartVersion(chart);
  c.settings = { ...DEFAULT_SETTINGS, ...(c.settings || {}) };
  c.display = {
    ...DEFAULT_DISPLAY, ...(c.display || {}),
    subjectAnchor: { ...DEFAULT_DISPLAY.subjectAnchor, ...(c.display?.subjectAnchor || {}) },
    frameOverrides: { ...(c.display?.frameOverrides || {}) },
  };
  c.audio = { src: null, startAtTimelineSeconds: 0, ...(c.audio || {}) };
  c.sequences = (c.sequences || []).map((s) => ({ id: s.id, label: s.label ?? s.id }));
  c.notes = c.notes.map((n) => {
    const out = {
      id: n.id, time: round(n.time, 4), button: n.button, action: n.action, input: n.input,
      label: n.label ?? ACTION_LABEL[n.action] ?? n.action, sequenceId: n.sequenceId ?? null,
    };
    if (n.input === 'hold') out.duration = round(n.duration, 4);
    if (n.effect) out.effect = structuredClone(n.effect);
    return out;
  }).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  c.memo = Array.isArray(c.memo) ? c.memo.map(String) : [];
  return c;
}

/** 書き出し用（一時的なプレイ状態を含めない・キーの順番を固定）。 */
export function exportChart(chart) {
  const c = normalizeChart(chart);
  const out = {
    schemaVersion: SCHEMA_VERSION,
    gameVersion: c.gameVersion,
    title: c.title ?? 'セーパイ',
    source: c.source,
    audio: c.audio,
    settings: c.settings,
    display: c.display,
    sequences: c.sequences,
    notes: c.notes.map((n) => {
      const o = { id: n.id, time: n.time, button: n.button, action: n.action, input: n.input };
      if (n.input === 'hold') o.duration = n.duration;
      o.label = n.label;
      o.sequenceId = n.sequenceId;
      if (n.effect) o.effect = n.effect;
      return o;
    }),
    memo: c.memo,
  };
  if (c.editorNotes) out.editorNotes = c.editorNotes;
  return JSON.stringify(out, null, 2) + '\n';
}

/** JSON テキストを読み込む。失敗時は {ok:false, errors}（呼び出し側の現在の譜面はそのまま）。 */
export function parseChartText(text, ctx = {}) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return { ok: false, errors: [`JSON として読めません: ${e.message}`], warnings: [] }; }
  const { errors, warnings } = validateChart(obj, ctx);
  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, chart: normalizeChart(obj), warnings };
}

/** 重複しない新しいノーツ ID（既存の最大番号 + 1） */
export function newNoteId(notes) {
  let max = 0;
  for (const n of notes) { const m = /^n(\d+)$/.exec(n.id); if (m) max = Math.max(max, Number(m[1])); }
  let k = max + 1;
  const ids = new Set(notes.map((n) => n.id));
  while (ids.has(`n${String(k).padStart(3, '0')}`)) k++;
  return `n${String(k).padStart(3, '0')}`;
}

/** 新しいノーツの既定値 */
export function makeNote(notes, button, time, extra = {}) {
  const info = BUTTON_INFO[button];
  const action = extra.action && info.actions.includes(extra.action) ? extra.action : info.defaultAction;
  const n = { id: newNoteId(notes), time: round(time, 4), button, action, input: info.input, label: ACTION_LABEL[action], sequenceId: null, ...extra };
  n.action = action;
  n.input = info.input;
  if (info.input === 'hold') n.duration = extra.duration ?? 2.0;
  else delete n.duration;
  return n;
}
