// POV / 正解動作ガイド: 3D 姿勢データ（MediaPipe Pose の worldLandmarks 33 点）の読み込み・検証・欠損補間・同期と、
// 人工的な DEMO 動作。Three.js に依存しない（node のテストでも動く）。
//
// 座標の約束（このモジュールの出力）: 単位はメートル、Y が上、演者の正面が +Z のとき演者の左が +X（右手系）。
// MediaPipe の worldLandmarks（腰の中点が原点・y が下・z が奥）は X=x, Y=-y, Z=-z に変換する。
// 原データ（読み込んだ文字列と解析結果）は書き換えない。処理結果は別の配列に作る。

export const JOINTS = [
  'nose', 'left_eye_inner', 'left_eye', 'left_eye_outer', 'right_eye_inner', 'right_eye', 'right_eye_outer',
  'left_ear', 'right_ear', 'mouth_left', 'mouth_right', 'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_pinky', 'right_pinky', 'left_index', 'right_index', 'left_thumb', 'right_thumb',
  'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle', 'left_heel', 'right_heel',
  'left_foot_index', 'right_foot_index',
];
export const N = 33;
export const INTERVAL = 0.2;        // セーパイの連番画像の間隔（秒）
export const FRAME_COUNT = 412;     // frame_0000〜0411（0〜82.2 秒）
export const J = Object.fromEntries(JOINTS.map((n, i) => [n, i]));
export const DEMO_LABEL = 'DEMO / 人工的な動作、空手の正解ではありません';
/** 骨格の線（関節の対） */
export const BONES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [15, 17], [15, 19], [15, 21], [17, 19], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 29], [27, 31], [29, 31], [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
  [0, 2], [0, 5], [2, 7], [5, 8], [9, 10],
];
/** 体の主要な関節（見失いの判定に使う） */
export const KEY_JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
/** 無いと体を組み立てられない関節 */
const ESSENTIAL = [11, 12, 13, 14, 15, 16, 23, 24];
// 左右の対（反転用）
const MIRROR = JOINTS.map((n) => J[n.startsWith('left_') ? n.replace('left_', 'right_') : n.startsWith('right_') ? n.replace('right_', 'left_') : n]);

export const FLAG = { INTERP: 1, LOWCONF: 2, RESAMPLED: 4, DERIVED: 8, OUTSIDE: 16 };

// ---- 小さなベクトル計算 ----
export const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  mid: (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
  horiz: (a) => [a[0], 0, a[2]],
};
const { sub, add, mul, dot, cross, len, norm, lerp, mid, horiz } = v3;
export const UP = [0, 1, 0];
const median = (xs) => { const a = xs.filter(Number.isFinite).sort((p, q) => p - q); if (!a.length) return NaN; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const quantile = (xs, q) => { const a = xs.filter(Number.isFinite).sort((p, r) => p - r); return a.length ? a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))] : NaN; };
export const wrapDeg = (d) => ((d + 540) % 360) - 180;
export const yawOf = (f) => Math.atan2(f[0], f[2]) * 180 / Math.PI; // +Z が 0°、+X（演者の左）向きが +90°

// =====================================================================
// 読み込み（CSV / JSON）→ サンプル列 { t, vals: Float64Array(33*4)（x,y,z,信頼度。欠損は NaN） }
// =====================================================================

/** 文字列を解析する。戻り値 { samples, meta:{format, coordinateSystem, interval}, errors, warnings }（原データは変更しない） */
export function parsePoseText(text, name = '') {
  const errors = [], warnings = [];
  const s = String(text ?? '').replace(/^﻿/, '');
  if (!s.trim()) return { samples: [], meta: {}, errors: ['ファイルが空です'], warnings };
  const looksJson = /^\s*[[{]/.test(s) || /\.json$/i.test(name);
  try {
    return looksJson ? parseJson(JSON.parse(s), errors, warnings) : parseCsv(s, errors, warnings);
  } catch (e) {
    return { samples: [], meta: {}, errors: [`${looksJson ? 'JSON' : 'CSV'} を読めません: ${e.message}`], warnings };
  }
}

function emptyVals() { const v = new Float64Array(N * 4); v.fill(NaN); return v; }
const num = (x) => (x === '' || x == null ? NaN : Number(x));
const rt = (x) => Math.round(x * 1e6) / 1e6; // 時刻はマイクロ秒に丸める（フレーム番号 × 間隔の誤差を残さない）

function jointIndex(key) {
  if (key == null) return -1;
  const k = String(key).trim().toLowerCase();
  if (/^\d+$/.test(k)) { const i = Number(k); return i >= 0 && i < N ? i : -1; }
  return J[k.replace(/[\s-]/g, '_')] ?? -1;
}
function timeColumns(h) {
  const find = (...ns) => { for (const n of ns) { const i = h.indexOf(n); if (i >= 0) return i; } return -1; };
  return { t: find('time', 't', 'time_s', 'seconds', 'sec'), ms: find('timestamp_ms', 'time_ms', 'ms'), frame: find('frame', 'frame_index', 'index') };
}

function parseCsv(text, errors, warnings) {
  const lines = text.split(/\r?\n/);
  let interval = INTERVAL, coordinateSystem = 'mediapipe-world';
  const body = [];
  for (const line of lines) {
    const c = line.trim();
    if (!c) continue;
    if (c.startsWith('#')) { // 任意の指定: "# interval=0.2" "# coordinateSystem=y-up"
      const m1 = c.match(/interval\s*=\s*([\d.]+)/i); if (m1) interval = Number(m1[1]);
      const m2 = c.match(/coordinate[_ ]?system\s*=\s*([\w-]+)/i); if (m2) coordinateSystem = m2[1].toLowerCase();
      continue;
    }
    body.push(c);
  }
  if (body.length < 2) { errors.push('CSV に見出し行とデータ行がありません'); return { samples: [], meta: {}, errors, warnings }; }
  const delim = body[0].includes('\t') ? '\t' : body[0].split(';').length > body[0].split(',').length ? ';' : ',';
  const h = body[0].split(delim).map((x) => x.trim().toLowerCase().replace(/^"|"$/g, ''));
  const tc = timeColumns(h);
  if (tc.t < 0 && tc.ms < 0 && tc.frame < 0) { errors.push('時刻の列（time・timestamp_ms・frame のいずれか）がありません'); return { samples: [], meta: {}, errors, warnings }; }
  const timeOf = (r) => rt(tc.t >= 0 ? num(r[tc.t]) : tc.ms >= 0 ? num(r[tc.ms]) / 1000 : num(r[tc.frame]) * interval);
  const frameOf = (r) => (tc.frame >= 0 ? num(r[tc.frame]) : NaN);
  const byKey = new Map();
  const get = (t, fr) => { const key = Number.isFinite(t) ? t.toFixed(6) : `f${fr}`; let s = byKey.get(key); if (!s) { s = { t, frame: fr, vals: emptyVals(), dup: 0 }; byKey.set(key, s); } return s; };
  const jc = ['joint', 'joint_id', 'landmark', 'landmark_id', 'id', 'name'].map((n) => h.indexOf(n)).find((i) => i >= 0) ?? -1;
  const col = (...ns) => ns.map((n) => h.indexOf(n)).find((i) => i >= 0) ?? -1;
  let bad = 0;
  if (jc >= 0) { // 縦長: 1 行 = 1 関節
    const cx = col('x'), cy = col('y'), cz = col('z'), cv = col('visibility', 'confidence', 'presence', 'score', 'v');
    if (cx < 0 || cy < 0 || cz < 0) { errors.push('x・y・z の列がありません'); return { samples: [], meta: {}, errors, warnings }; }
    if (cv < 0) warnings.push('信頼度の列（visibility / confidence）がありません。すべて 1 として扱います');
    for (let r = 1; r < body.length; r++) {
      const row = body[r].split(delim).map((x) => x.trim().replace(/^"|"$/g, ''));
      const j = jointIndex(row[jc]);
      const t = timeOf(row);
      if (j < 0 || !Number.isFinite(t)) { bad++; continue; }
      const s = get(t, frameOf(row));
      if (Number.isFinite(s.vals[j * 4])) s.dup++;
      s.vals.set([num(row[cx]), num(row[cy]), num(row[cz]), cv >= 0 ? num(row[cv]) : 1], j * 4);
    }
  } else { // 横長: 1 行 = 1 フレーム（x0,y0,z0,v0… または nose_x,nose_y…）
    const map = [];
    h.forEach((name, i) => {
      let m = name.match(/^(x|y|z|v|visibility|confidence)_?(\d+)$/);
      let j = m ? Number(m[2]) : -1, a = m ? m[1] : null;
      if (!m) { m = name.match(/^(.+)_(x|y|z|v|visibility|confidence)$/); if (m) { j = J[m[1]] ?? -1; a = m[2]; } }
      if (j >= 0 && j < N && a) map.push([i, j, { x: 0, y: 1, z: 2 }[a] ?? 3]);
    });
    if (map.length < 3 * 8) { errors.push('関節の列が見つかりません（縦長は joint,x,y,z 列、横長は x0,y0,z0… または nose_x… の列）'); return { samples: [], meta: {}, errors, warnings }; }
    if (!map.some((m) => m[2] === 3)) warnings.push('信頼度の列がありません。すべて 1 として扱います');
    for (let r = 1; r < body.length; r++) {
      const row = body[r].split(delim).map((x) => x.trim());
      const t = timeOf(row);
      if (!Number.isFinite(t)) { bad++; continue; }
      const s = get(t, frameOf(row));
      for (const [i, j, a] of map) s.vals[j * 4 + a] = num(row[i]);
      if (!map.some((m) => m[2] === 3)) for (let j = 0; j < N; j++) if (Number.isFinite(s.vals[j * 4])) s.vals[j * 4 + 3] = 1;
    }
  }
  if (bad) warnings.push(`読めない行 ${bad} 行を飛ばしました（関節名・時刻が不正）`);
  const samples = [...byKey.values()];
  const dups = samples.reduce((a, s) => a + s.dup, 0);
  if (dups) warnings.push(`同じ時刻・関節の行が ${dups} 件重複しています（後の行を使いました）`);
  samples.forEach((s) => delete s.dup);
  return { samples, meta: { format: jc >= 0 ? 'csv-long' : 'csv-wide', coordinateSystem, interval }, errors, warnings };
}

function lmArray(x) {
  // [[x,y,z,v]…] / [{x,y,z,visibility}…] / { landmark:[…] }（MediaPipe の書き出し）
  if (x && !Array.isArray(x) && Array.isArray(x.landmark)) x = x.landmark;
  if (!Array.isArray(x)) return null;
  if (x.length && Array.isArray(x[0]) && x[0].length && typeof x[0][0] === 'object') x = x[0]; // 複数人の配列 → 1 人目
  const v = emptyVals();
  x.slice(0, N).forEach((p, j) => {
    if (Array.isArray(p)) v.set([num(p[0]), num(p[1]), num(p[2]), p.length > 3 ? num(p[3]) : 1], j * 4);
    else if (p && typeof p === 'object') v.set([num(p.x), num(p.y), num(p.z), num(p.visibility ?? p.confidence ?? p.presence ?? 1)], j * 4);
  });
  return { v, count: x.length };
}

function parseJson(doc, errors, warnings) {
  let interval = INTERVAL, coordinateSystem = 'mediapipe-world', format = 'json';
  let frames = doc;
  if (!Array.isArray(doc)) {
    if (doc.interval) interval = Number(doc.interval);
    if (doc.coordinateSystem) coordinateSystem = String(doc.coordinateSystem).toLowerCase();
    if (doc.format) format = String(doc.format);
    frames = doc.frames ?? doc.results ?? doc.data;
  }
  if (!Array.isArray(frames)) { errors.push('frames の配列がありません'); return { samples: [], meta: {}, errors, warnings }; }
  const samples = [];
  let multi = 0, badCount = 0, imageOnly = 0;
  frames.forEach((f, k) => {
    if (!f || typeof f !== 'object') return;
    const fr = num(f.frame ?? f.frame_index ?? f.index);
    let t = num(f.t ?? f.time ?? f.time_s);
    if (!Number.isFinite(t) && f.timestamp_ms != null) t = num(f.timestamp_ms) / 1000;
    if (!Number.isFinite(t)) t = Number.isFinite(fr) ? fr * interval : k * interval;
    t = rt(t);
    const src = f.worldLandmarks ?? f.world_landmarks ?? f.pose_world_landmarks ?? f.landmarks3d ?? (f.coordinateSystem || doc.coordinateSystem || doc.format ? f.landmarks : null);
    if (src == null && f.landmarks) imageOnly++;
    if (Array.isArray(src) && Array.isArray(src[0]) && typeof src[0][0] === 'object' && src.length > 1) multi++;
    const r = lmArray(src);
    if (!r) return;
    if (r.count !== N) badCount++;
    samples.push({ t, frame: fr, vals: r.v });
  });
  if (imageOnly) errors.push(`${imageOnly} フレームは画像座標（landmarks）だけで 3D の worldLandmarks がありません`);
  if (multi) warnings.push(`${multi} フレームに複数人の結果がありました（1 人目を使いました）`);
  if (badCount) warnings.push(`${badCount} フレームは関節が 33 点ではありません（足りない関節は欠損として補間）`);
  return { samples, meta: { format, coordinateSystem, interval }, errors, warnings };
}

// =====================================================================
// 検証・座標変換・欠損補間・同期（0.2 秒の格子）
// =====================================================================

/**
 * 解析結果から表示用のデータを作る（原データは変更しない）。
 * opts: { mirror, confThreshold(0.5), interpolateLowConf(false), timeOffset(0), grid: 'seipai'|'data' }
 * 戻り値 { ok, frames:[{t, p:Float32Array(99), v:Float32Array(33), flags:Uint8Array(33), lost, outside, src}], lengths, report:{errors,warnings,info,stats} }
 */
export function processPose(parsed, opts = {}) {
  const o = { mirror: false, confThreshold: 0.5, interpolateLowConf: false, timeOffset: 0, grid: 'seipai', ...opts };
  const errors = [...(parsed.errors || [])], warnings = [...(parsed.warnings || [])], info = [];
  const coord = parsed.meta?.coordinateSystem || 'mediapipe-world';
  if (!['mediapipe-world', 'y-up'].includes(coord)) errors.push(`coordinateSystem「${coord}」は扱えません（mediapipe-world か y-up）`);
  let samples = (parsed.samples || []).filter((s) => Number.isFinite(s.t)).map((s) => ({ t: s.t + o.timeOffset, vals: s.vals }));
  if (samples.length < 2 && !errors.length) errors.push(`フレームが ${samples.length} 個しかありません（2 個以上必要）`);
  if (errors.length) return { ok: false, frames: [], report: { errors, warnings, info, stats: {} } };

  // 時刻: 並び・重複
  const sorted = samples.every((s, i) => i === 0 || s.t > samples[i - 1].t);
  if (!sorted) { samples = [...samples].sort((a, b) => a.t - b.t); warnings.push('時刻が順に並んでいなかったので並べ替えました'); }
  for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i].t - samples[i - 1].t) < 1e-6) { errors.push(`同じ時刻 ${samples[i].t.toFixed(3)} 秒のフレームが重複しています`); break; }
  const dts = samples.slice(1).map((s, i) => s.t - samples[i].t);
  const dt = median(dts);
  const span = [samples[0].t, samples[samples.length - 1].t];

  // 座標の単位・種類の検査
  const conv = coord === 'mediapipe-world' ? (x, y, z) => [x, -y, -z] : (x, y, z) => [x, y, z];
  const shW = median(samples.map((s) => { const a = s.vals, i = 11 * 4, k = 12 * 4; return Math.hypot(a[i] - a[k], a[i + 1] - a[k + 1], a[i + 2] - a[k + 2]); }));
  const hipC = median(samples.map((s) => { const a = s.vals; return Math.hypot((a[92] + a[96]) / 2, (a[93] + a[97]) / 2); }));
  const all01 = samples.every((s) => { for (let j = 0; j < N; j++) { const x = s.vals[j * 4], y = s.vals[j * 4 + 1]; if (Number.isFinite(x) && (x < -0.05 || x > 1.05 || y < -0.05 || y > 1.05)) return false; } return true; });
  if (coord === 'mediapipe-world' && all01 && hipC > 0.2) errors.push('画像の正規化座標（0〜1）のようです。MediaPipe の worldLandmarks（メートル・腰が原点）を使ってください');
  else if (!(shW > 0.15 && shW < 0.8)) {
    if (shW > 15) errors.push(`肩幅が ${shW.toFixed(1)} です。単位がメートルではない（mm・cm・ピクセル）ようです`);
    else warnings.push(`肩幅の中央値が ${Number.isFinite(shW) ? shW.toFixed(2) : '不明'} m で、人の体として不自然です（座標系・単位を確認してください）`);
  }
  if (errors.length) return { ok: false, frames: [], report: { errors, warnings, info, stats: { shoulderWidth: shW } } };

  // 3D に変換・欠損と低信頼度の印
  const T = samples.length;
  const P = samples.map((s) => {
    const p = new Float64Array(N * 3), v = new Float64Array(N), miss = new Uint8Array(N);
    for (let j = 0; j < N; j++) {
      const a = s.vals, x = a[j * 4], y = a[j * 4 + 1], z = a[j * 4 + 2];
      let c = a[j * 4 + 3];
      if (!Number.isFinite(c)) c = 1;
      if (![x, y, z].every(Number.isFinite) || Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > 3) { miss[j] = 1; v[j] = 0; p.set([NaN, NaN, NaN], j * 3); continue; }
      p.set(conv(x, y, z), j * 3); v[j] = Math.min(1, Math.max(0, c));
    }
    return { p, v, miss };
  });
  let outOfRange = 0, missing = 0, lowconf = 0;
  for (const f of P) for (let j = 0; j < N; j++) { if (f.miss[j]) missing++; else if (f.v[j] < o.confThreshold) lowconf++; }
  for (const s of samples) for (let j = 0; j < N; j++) { const a = s.vals; if ([a[j * 4], a[j * 4 + 1], a[j * 4 + 2]].every(Number.isFinite) && Math.max(Math.abs(a[j * 4]), Math.abs(a[j * 4 + 1]), Math.abs(a[j * 4 + 2])) > 3) outOfRange++; }
  if (outOfRange) warnings.push(`腰から 3 m を超える値 ${outOfRange} 点は欠損として扱いました`);

  // 関節ごとの時間方向の線形補間（欠損と、指定時は低信頼度）
  const flags = P.map(() => new Uint8Array(N));
  const never = [];
  for (let j = 0; j < N; j++) {
    const good = [];
    for (let k = 0; k < T; k++) {
      const bad = P[k].miss[j] || (o.interpolateLowConf && P[k].v[j] < o.confThreshold);
      if (!P[k].miss[j] && P[k].v[j] < o.confThreshold) flags[k][j] |= FLAG.LOWCONF;
      if (!bad) good.push(k);
    }
    if (!good.length) { never.push(j); continue; }
    for (let k = 0; k < T; k++) {
      const isGood = !(P[k].miss[j] || (o.interpolateLowConf && P[k].v[j] < o.confThreshold));
      if (isGood) continue;
      let a = -1, b = -1; // 前後の有効なフレーム
      for (let q = k - 1; q >= 0; q--) if (!(P[q].miss[j] || (o.interpolateLowConf && P[q].v[j] < o.confThreshold))) { a = q; break; }
      for (let q = k + 1; q < T; q++) if (!(P[q].miss[j] || (o.interpolateLowConf && P[q].v[j] < o.confThreshold))) { b = q; break; }
      const pa = a >= 0 ? P[a].p.subarray(j * 3, j * 3 + 3) : null, pb = b >= 0 ? P[b].p.subarray(j * 3, j * 3 + 3) : null;
      let val;
      if (pa && pb) { const u = (samples[k].t - samples[a].t) / (samples[b].t - samples[a].t); val = lerp([...pa], [...pb], u); }
      else val = [...(pa || pb)];
      P[k].p.set(val, j * 3);
      flags[k][j] |= FLAG.INTERP;
    }
  }
  const neverEssential = never.filter((j) => ESSENTIAL.includes(j));
  if (neverEssential.length) {
    errors.push(`体を組み立てる関節がすべてのフレームで欠けています: ${neverEssential.map((j) => JOINTS[j]).join('、')}`);
    return { ok: false, frames: [], report: { errors, warnings, info, stats: {} } };
  }
  if (never.length) {
    warnings.push(`一度も値がない関節 ${never.map((j) => JOINTS[j]).join('、')} は周りの関節から推定しました（実測ではありません）`);
    for (let k = 0; k < T; k++) deriveMissing(P[k].p, never, flags[k]);
  }

  // 同期: セーパイの 412 コマ（0.2 秒刻み）の格子に合わせる。データの時刻が格子に乗っていればそのまま使う
  const grid = [];
  if (o.grid === 'seipai') for (let k = 0; k < FRAME_COUNT; k++) grid.push(Math.round(k * INTERVAL * 1000) / 1000);
  else for (const s of samples) grid.push(s.t);
  const onGrid = Math.abs(dt - INTERVAL) < 1e-3 && samples.every((s) => Math.abs(s.t / INTERVAL - Math.round(s.t / INTERVAL)) < 0.005);
  if (o.grid === 'seipai' && !onGrid) warnings.push(`データの間隔は約 ${(dt * 1000).toFixed(1)} ms（0.2 秒刻みではない）。0.2 秒の格子に線形補間で合わせました`);
  if (o.grid === 'seipai' && T !== FRAME_COUNT) warnings.push(`フレーム数は ${T}（セーパイの連番画像は ${FRAME_COUNT} コマ）`);
  const frames = [];
  let si = 0, outside = 0;
  for (const tg of grid) {
    const p = new Float32Array(N * 3), v = new Float32Array(N), fl = new Uint8Array(N);
    let out = false, src;
    if (tg < span[0] - 1e-6 || tg > span[1] + 1e-6) { // データの範囲外 → 端のフレームを置くが、見失いとして示す
      const e = tg < span[0] ? 0 : T - 1;
      p.set(P[e].p); v.set(P[e].v); for (let j = 0; j < N; j++) fl[j] = flags[e][j] | FLAG.OUTSIDE;
      out = true; outside++; src = e;
    } else {
      while (si < T - 2 && samples[si + 1].t <= tg + 1e-9) si++;
      const a = si, b = Math.min(si + 1, T - 1);
      const ta = samples[a].t, tb = samples[b].t;
      if (Math.abs(tg - ta) < 1e-6 || a === b) { p.set(P[a].p); v.set(P[a].v); fl.set(flags[a]); src = a; }
      else if (Math.abs(tg - tb) < 1e-6) { p.set(P[b].p); v.set(P[b].v); fl.set(flags[b]); src = b; }
      else {
        const u = (tg - ta) / (tb - ta);
        for (let i = 0; i < N * 3; i++) p[i] = P[a].p[i] + (P[b].p[i] - P[a].p[i]) * u;
        for (let j = 0; j < N; j++) { v[j] = Math.min(P[a].v[j], P[b].v[j]); fl[j] = flags[a][j] | flags[b][j] | FLAG.RESAMPLED; }
        src = u < 0.5 ? a : b;
      }
    }
    frames.push({ t: tg, p, v, flags: fl, outside: out, src });
  }
  if (outside) warnings.push(`データの時間範囲（${span[0].toFixed(2)}〜${span[1].toFixed(2)} 秒）の外の ${outside} コマは端の姿勢を表示し、見失いとして示します`);

  // 左右反転（表示用。原データは変えない）
  if (o.mirror) for (const f of frames) mirrorFrame(f);
  // 床: 足の点の低い方の 5 パーセンタイルを床（Y=0）にする（worldLandmarks は腰が原点で、移動量を持たない）
  const footY = frames.filter((f) => !f.outside).map((f) => Math.min(...[27, 28, 29, 30, 31, 32].map((j) => f.p[j * 3 + 1])));
  const floor = quantile(footY, 0.05);
  for (const f of frames) for (let j = 0; j < N; j++) f.p[j * 3 + 1] -= floor;
  // 見失いの判定
  let lostN = 0;
  for (const f of frames) {
    const weak = KEY_JOINTS.filter((j) => f.flags[j] & (FLAG.INTERP | FLAG.LOWCONF)).length;
    f.lost = f.outside || weak >= 4;
    f.weak = weak;
    if (f.lost) lostN++;
  }
  const lengths = segmentLengths(frames);
  info.push(`${T} フレーム（${span[0].toFixed(2)}〜${span[1].toFixed(2)} 秒、間隔の中央値 ${(dt * 1000).toFixed(1)} ms）→ 表示 ${frames.length} コマ`);
  info.push(`欠損 ${missing} 点を補間、低信頼度（< ${o.confThreshold}）${lowconf} 点${o.interpolateLowConf ? 'を補間' : 'は値を使い警告表示'}、見失い ${lostN} コマ`);
  info.push(`肩幅の中央値 ${(shW * 100).toFixed(1)} cm・床の高さ補正 ${(-floor * 100).toFixed(1)} cm`);
  return {
    ok: !errors.length, frames, lengths,
    report: { errors, warnings, info, stats: { samples: T, frames: frames.length, dtMs: dt * 1000, span, missing, lowconf, lost: lostN, shoulderWidth: shW, floor, onGrid } },
  };
}

function mirrorFrame(f) {
  const p = Float32Array.from(f.p), v = Float32Array.from(f.v), fl = Uint8Array.from(f.flags);
  for (let j = 0; j < N; j++) {
    const m = MIRROR[j];
    f.p[j * 3] = -p[m * 3]; f.p[j * 3 + 1] = p[m * 3 + 1]; f.p[j * 3 + 2] = p[m * 3 + 2];
    f.v[j] = v[m]; f.flags[j] = fl[m];
  }
}

/** 一度も値がない顔・手・足の点を、周りの関節から作る（DERIVED の印） */
function deriveMissing(p, list, fl) {
  const g = (j) => [p[j * 3], p[j * 3 + 1], p[j * 3 + 2]];
  const set = (j, a) => { p.set(a, j * 3); fl[j] |= FLAG.DERIVED; };
  const shM = mid(g(11), g(12));
  const left = norm(sub(g(11), g(12))), fwd = norm(cross(left, UP));
  for (const j of list) {
    if (j <= 10) { // 顔: 肩の中点の上
      const head = add(shM, [0, 0.2, 0]);
      const off = { 0: [0, 0, 0.1], 1: [0.015, 0.03, 0.08], 2: [0.03, 0.03, 0.08], 3: [0.045, 0.03, 0.07], 4: [-0.015, 0.03, 0.08], 5: [-0.03, 0.03, 0.08], 6: [-0.045, 0.03, 0.07], 7: [0.075, 0, 0], 8: [-0.075, 0, 0], 9: [0.025, -0.04, 0.08], 10: [-0.025, -0.04, 0.08] }[j];
      set(j, add(head, add(add(mul(left, off[0]), mul(UP, off[1])), mul(fwd, off[2]))));
    } else if (j >= 17 && j <= 22) { // 手: 前腕の延長
      const L = j % 2 === 1, w = g(L ? 15 : 16), e = g(L ? 13 : 14);
      set(j, add(w, mul(norm(sub(w, e)), j <= 18 ? 0.07 : j <= 20 ? 0.08 : 0.04)));
    } else if (j >= 29) { // 足: 足首の前後
      const L = j % 2 === 1, a = g(L ? 27 : 28);
      set(j, add(a, j <= 30 ? [-fwd[0] * 0.05, -0.06, -fwd[2] * 0.05] : [fwd[0] * 0.17, -0.07, fwd[2] * 0.17]));
    }
  }
}

// =====================================================================
// 体の部位の長さ・向き（視点の推定と診断）
// =====================================================================
export const P3 = (f, j) => [f.p[j * 3], f.p[j * 3 + 1], f.p[j * 3 + 2]];
export const SEGMENTS = {
  upperarmL: [11, 13], upperarmR: [12, 14], forearmL: [13, 15], forearmR: [14, 16],
  thighL: [23, 25], thighR: [24, 26], shinL: [25, 27], shinR: [26, 28], footL: [27, 31], footR: [28, 32],
};
export function segmentLengths(frames) {
  const ok = frames.filter((f) => !f.outside);
  const L = {};
  for (const [k, [a, b]] of Object.entries(SEGMENTS)) L[k] = median(ok.map((f) => len(sub(P3(f, a), P3(f, b)))));
  L.handL = median(ok.map((f) => len(sub(mid(P3(f, 17), P3(f, 19)), P3(f, 15)))));
  L.handR = median(ok.map((f) => len(sub(mid(P3(f, 18), P3(f, 20)), P3(f, 16)))));
  L.shoulderW = median(ok.map((f) => len(sub(P3(f, 11), P3(f, 12)))));
  L.hipW = median(ok.map((f) => len(sub(P3(f, 23), P3(f, 24)))));
  L.torso = median(ok.map((f) => len(sub(mid(P3(f, 11), P3(f, 12)), mid(P3(f, 23), P3(f, 24))))));
  L.neck = median(ok.map((f) => len(sub(mid(P3(f, 7), P3(f, 8)), mid(P3(f, 11), P3(f, 12))))));
  return L;
}

/**
 * 各コマの体と頭の向き（視点の推定）。頭の向きは左右の耳の軸と、耳の中点→鼻の向きの 2 つで求め、食い違えば「反転の疑い」。
 * 戻り値: [{ eye, bodyFwd, bodyYaw, headFwd, headYaw, pitch, pitchRaw, headConf, flip, jump, headBodyDeg, issues:[] }]
 */
export function analyzeFrames(frames, { conf = 0.5 } = {}) {
  const out = frames.map((f) => {
    const g = (j) => P3(f, j);
    const left = norm(add(horiz(sub(g(11), g(12))), horiz(sub(g(23), g(24)))));
    const bodyFwd = norm(cross(left, UP));
    const earM = mid(g(7), g(8)), eyeM = mid(g(2), g(5));
    const earAxis = horiz(sub(g(7), g(8)));
    const fwdEar = norm(cross(norm(earAxis), UP));
    const nv = sub(g(0), earM);
    const fwdNose = norm(horiz(nv));
    const headConf = Math.min(f.v[0], f.v[7], f.v[8]);
    const agree = dot(fwdEar, fwdNose);
    const issues = [];
    let headFwd, flip = false;
    if (len(earAxis) < 0.03 || len(horiz(nv)) < 0.02) { headFwd = bodyFwd; issues.push('頭の向きの点が近すぎる（胴体の向きを使用）'); }
    else if (agree < 0) { headFwd = bodyFwd; flip = true; issues.push('耳の左右と鼻の向きが逆（反転の疑い。胴体の向きを使用）'); }
    else headFwd = norm(add(fwdEar, fwdNose));
    if (headConf < conf) issues.push(`頭の点の信頼度が低い（${headConf.toFixed(2)}）`);
    const pitchRaw = Math.atan2(nv[1], Math.max(1e-6, len(horiz(nv)))) * 180 / Math.PI;
    const eyesOk = f.v[2] >= conf && f.v[5] >= conf && !(f.flags[2] & FLAG.DERIVED) && !(f.flags[5] & FLAG.DERIVED);
    const eye = eyesOk ? eyeM : add(earM, mul(headFwd, 0.08));
    return { eye, earM, bodyFwd, bodyYaw: yawOf(bodyFwd), headFwd, headYaw: yawOf(headFwd), pitchRaw, headConf, flip, issues, lost: f.lost };
  });
  // 首の傾きの基準（演者のふだんの耳→鼻の角度）を中央値で取り、それとの差を上下の角度にする
  const base = median(out.filter((a) => !a.flip && !a.lost).map((a) => a.pitchRaw));
  const pitchBase = Number.isFinite(base) ? base : 0;
  out.forEach((a, k) => {
    a.pitch = Math.max(-60, Math.min(60, a.pitchRaw - pitchBase));
    a.headBodyDeg = wrapDeg(a.headYaw - a.bodyYaw);
    if (Math.abs(a.headBodyDeg) > 70) a.issues.push(`頭と胴体の向きの差が ${Math.round(a.headBodyDeg)}°`);
    a.jump = k > 0 ? wrapDeg(a.headYaw - out[k - 1].headYaw) : 0;
    if (Math.abs(a.jump) > 60) a.issues.push(`前のコマから頭の向きが ${Math.round(a.jump)}° 急変`);
  });
  out.pitchBase = pitchBase;
  return out;
}

/** t 秒の姿勢（コマの間を線形補間。step=true なら 0.2 秒刻みのコマそのもの）。{ p, k, u, frame } */
export function poseAt(frames, t, step = false) {
  const n = frames.length;
  const x = Math.max(0, Math.min(n - 1, t / INTERVAL));
  const k = Math.floor(x + 1e-9), u = step ? 0 : x - k;
  const a = frames[k], b = frames[Math.min(n - 1, k + 1)];
  if (u < 1e-6) return { p: a.p, k, u: 0, frame: a };
  const p = new Float32Array(a.p.length);
  for (let i = 0; i < p.length; i++) p[i] = a.p[i] + (b.p[i] - a.p[i]) * u;
  return { p, k, u, frame: u < 0.5 ? a : b };
}

// =====================================================================
// DEMO（人工的な動作。空手の正解ではない）: 運動学で作った 33 点を MediaPipe の worldLandmarks と同じ形で出す
// =====================================================================
function ik2(root, target, l1, l2, pole) {
  let d = sub(target, root);
  let dl = Math.max(1e-4, Math.min(len(d), l1 + l2 - 1e-4));
  const dir = norm(d);
  const a = (l1 * l1 - l2 * l2 + dl * dl) / (2 * dl);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  let pp = sub(pole, mul(dir, dot(pole, dir)));
  if (len(pp) < 1e-6) pp = [0, 0, 1];
  pp = norm(pp);
  const mid_ = add(add(root, mul(dir, a)), mul(pp, h));
  return { mid: mid_, end: add(root, mul(dir, dl)) };
}
const smooth = (x) => x * x * (3 - 2 * x);
const P = (x, y, z) => [x, y, z];
// 体の座標（X=左・Y=上・Z=前）での手首の位置と手の甲の向き。L は演者の左手（+X 側）
const ARMS = {
  ready: { L: [P(0.13, 1.0, 0.22), P(0, -0.2, 1)], R: [P(-0.13, 1.0, 0.22), P(0, -0.2, 1)] },
  punchR: { L: [P(0.17, 1.02, -0.02), P(0, -1, 0)], R: [P(-0.02, 1.36, 0.62), P(0, 1, 0)] },
  punchL: { L: [P(0.02, 1.36, 0.62), P(0, 1, 0)], R: [P(-0.17, 1.02, -0.02), P(0, -1, 0)] },
  blockL: { L: [P(0.06, 1.7, 0.3), P(0, 0.2, -1)], R: [P(-0.17, 1.02, -0.02), P(0, -1, 0)] },
  blockR: { L: [P(0.17, 1.02, -0.02), P(0, -1, 0)], R: [P(-0.06, 1.7, 0.3), P(0, 0.2, -1)] },
  openL: { L: [P(0.08, 1.3, 0.45), P(-1, 0, 0)], R: [P(-0.12, 1.1, 0.25), P(0, -0.3, 1)] },
  guard: { L: [P(0.12, 1.28, 0.38), P(0, 0.3, -1)], R: [P(-0.14, 1.12, 0.22), P(0, 0.3, -1)] },
};
const LEGS = {
  stand: { L: P(0.14, 0.08, 0.03), R: P(-0.14, 0.08, 0.03), drop: 0 },
  frontL: { L: P(0.13, 0.08, 0.38), R: P(-0.13, 0.08, -0.38), drop: 0.09 },
  frontR: { L: P(0.13, 0.08, -0.38), R: P(-0.13, 0.08, 0.38), drop: 0.09 },
  kickR: { L: P(0.12, 0.08, 0.0), R: P(-0.05, 0.85, 0.62), drop: 0.02, kick: 'R' },
};
// 2 秒ごとの姿勢の並び（腕・脚・体の向き°）
const DEMO_SEQ = [];
(() => {
  const arms = ['ready', 'punchR', 'punchL', 'punchR', 'blockL', 'blockR', 'guard', 'openL', 'ready', 'guard'];
  const legs = ['stand', 'frontL', 'frontL', 'frontR', 'frontL', 'frontR', 'stand', 'stand', 'kickR', 'stand'];
  const yaws = [0, 0, 0, 0, 0, 0, 0, 90, 90, 90, 90, 90, 90, 90, 180, 180, 180, 180, 180, 180, 180, 270, 270, 270, 270, 270, 270, 270, 360, 360, 360, 360, 360, 360, 360, 360, 360, 360, 360, 360, 360, 360];
  for (let i = 0; i < 42; i++) DEMO_SEQ.push({ t: i * 2, arms: i === 0 || i >= 40 ? 'ready' : arms[i % arms.length], legs: i === 0 || i >= 40 ? 'stand' : legs[i % legs.length], yaw: yaws[i] });
})();

/** 体の座標での 33 点（Y=上・Z=前・X=左。腰の中点の高さ 0.95 m） */
function demoBody(t) {
  const i = Math.min(DEMO_SEQ.length - 2, Math.floor(t / 2));
  const a = DEMO_SEQ[i], b = DEMO_SEQ[i + 1];
  const u = smooth(Math.min(1, Math.max(0, (t - a.t) / 0.7))); // 各区間の最初の 0.7 秒で次の姿勢へ
  const prev = i > 0 ? DEMO_SEQ[i - 1] : a;
  const arm = (side) => { const A = ARMS[prev.arms][side], B = ARMS[a.arms][side]; return [lerp(A[0], B[0], u), norm(lerp(A[1], B[1], u))]; };
  const LA = LEGS[prev.legs], LB = LEGS[a.legs];
  const leg = (side) => lerp(LA[side], LB[side], u);
  const drop = LA.drop + (LB.drop - LA.drop) * u;
  const breath = Math.sin(t * 2 * Math.PI / 4) * 0.006;
  const yaw = prev.yaw + (a.yaw - prev.yaw) * u;
  const headLead = (a.yaw - prev.yaw) * Math.min(1, smooth(Math.min(1, (t - a.t) / 0.4))) - (a.yaw - prev.yaw) * u; // 頭が少し先に向く
  const hipY = 0.95 - drop;
  const p = new Array(N);
  p[23] = P(0.09, hipY, 0); p[24] = P(-0.09, hipY, 0);
  p[11] = P(0.18, 1.42 - drop + breath, 0.0); p[12] = P(-0.18, 1.42 - drop + breath, 0.0);
  for (const [side, s, sh, el, wr, pk, ix, th] of [['L', 1, 11, 13, 15, 17, 19, 21], ['R', -1, 12, 14, 16, 18, 20, 22]]) {
    const [w, dorsal] = arm(side);
    const target = add(w, [0, -drop, 0]);
    const k = ik2(p[sh], target, 0.29, 0.26, P(s * 0.4, -1, -0.4));
    p[el] = k.mid; p[wr] = k.end;
    const f = norm(sub(p[wr], p[el]));
    const z = norm(sub(dorsal, mul(f, dot(dorsal, f))));
    const thumbSide = mul(norm(cross(f, z)), s); // 左手は cross(f, 甲) が親指側
    p[ix] = add(add(p[wr], mul(f, 0.085)), mul(thumbSide, 0.03));
    p[pk] = add(add(p[wr], mul(f, 0.075)), mul(thumbSide, -0.035));
    p[th] = add(add(add(p[wr], mul(f, 0.045)), mul(thumbSide, 0.045)), mul(z, -0.02));
  }
  for (const [side, s, hp, kn, an, he, ft] of [['L', 1, 23, 25, 27, 29, 31], ['R', -1, 24, 26, 28, 30, 32]]) {
    const target = leg(side);
    const k = ik2(p[hp], target, 0.43, 0.42, P(s * 0.15, 0, 1));
    p[kn] = k.mid; p[an] = k.end;
    const kicking = (LB.kick === side && u > 0.3) || (LA.kick === side && u < 0.7);
    const toeDir = kicking ? norm(sub(p[an], p[kn])) : norm(P(s * 0.25, 0, 1));
    p[he] = add(p[an], kicking ? mul(toeDir, -0.06) : P(0, -0.05, -0.05));
    p[ft] = add(p[an], kicking ? add(mul(toeDir, 0.06), P(0, 0.12, 0.08)) : add(mul(toeDir, 0.17), P(0, -0.07, 0)));
  }
  // 頭（体の向きに対する頭の向き headLead°。目線はわずかに下）
  const hr = headLead * Math.PI / 180, hc = Math.cos(hr), hs = Math.sin(hr);
  const rot = (v) => [v[0] * hc + v[2] * hs, v[1], -v[0] * hs + v[2] * hc];
  const ear = P(0, 1.6 - drop + breath, 0.0);
  const face = { 0: [0, -0.02, 0.1], 1: [0.015, 0.012, 0.085], 2: [0.032, 0.012, 0.08], 3: [0.048, 0.012, 0.07], 4: [-0.015, 0.012, 0.085], 5: [-0.032, 0.012, 0.08], 6: [-0.048, 0.012, 0.07], 7: [0.075, 0, 0], 8: [-0.075, 0, 0], 9: [0.025, -0.05, 0.085], 10: [-0.025, -0.05, 0.085] };
  for (const [j, o] of Object.entries(face)) p[j] = add(ear, rot(o));
  return { p, yaw };
}

/** DEMO のサンプル列（MediaPipe の worldLandmarks と同じ形: 腰が原点・y が下・z が奥）。parsePoseText の結果と同じ形で返す */
export function makeDemoParsed() {
  const samples = [];
  for (let k = 0; k < FRAME_COUNT; k++) {
    const t = Math.round(k * INTERVAL * 1000) / 1000;
    const { p, yaw } = demoBody(t);
    const r = yaw * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    const hip = mid(p[23], p[24]);
    const vals = emptyVals();
    for (let j = 0; j < N; j++) {
      const q = sub(p[j], hip);
      const X = q[0] * c + q[2] * s, Z = -q[0] * s + q[2] * c;
      vals.set([X, -q[1], -Z, 0.98], j * 4);
    }
    samples.push({ t, frame: k, vals });
  }
  return { samples, meta: { format: 'demo', coordinateSystem: 'mediapipe-world', interval: INTERVAL }, errors: [], warnings: [], demo: true };
}

/** サンプル列を縦長の CSV に（入力形式の見本・テスト用） */
export function samplesToCsv(samples, { comment = '' } = {}) {
  const lines = [];
  if (comment) lines.push(`# ${comment}`);
  lines.push('# coordinateSystem=mediapipe-world', 'time,frame,joint,name,x,y,z,visibility');
  for (const s of samples) for (let j = 0; j < N; j++) {
    const a = s.vals;
    const f = (x) => (Number.isFinite(x) ? +x.toFixed(5) : '');
    lines.push([s.t.toFixed(3), s.frame ?? '', j, JOINTS[j], f(a[j * 4]), f(a[j * 4 + 1]), f(a[j * 4 + 2]), f(a[j * 4 + 3])].join(','));
  }
  return lines.join('\n') + '\n';
}
