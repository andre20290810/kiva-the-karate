// 人物にかかる視覚エフェクトの一覧（番号は固定。並び順や名称を変えても、譜面に保存した番号の意味は変わらない）。
// 譜面のノーツの effect に保存する項目（すべて省略可。省略は「既定」）:
//   id        エフェクト番号（下の EFFECTS）。省略時は従来の preset、どちらも無ければコマンドの既定
//   origin    発生位置の基準: auto（エフェクトの既定）| torso | head | left_wrist | right_wrist | left_ankle | right_ankle | point（anchor）
//   anchor    origin = point のときの位置（元画像の 0〜1）。従来の打撃点もこれ
//   offset    画面上の位置調整 {x, y}（直立時の身長に対する比。+x 右、+y 下）
//   angle     向き（度。0 = 右、90 = 下）。方向を持つエフェクトだけ。従来の direction（ベクトル）も読める
//   size      大きさの倍率、intensity 強さ（0〜2）、duration 持続時間（秒）
// 番号 5（背後にまとう炎）は 2026-10-21 に廃止。保存済みの設定・JSON の 5 は、息なら 1、ほかは 0 に置き換える（migrateEffect）。
// 5 は欠番のまま再利用しない。
// DOM に依存しない（譜面の検証・テストでも使う）。

export const EFFECTS = Object.freeze([
  { id: 0, key: 'none', name: 'エフェクトなし', directional: false, duration: 0, origin: 'torso', desc: '人物には何も出さない（判定位置の文字の火は出る）' },
  { id: 1, key: 'breath', name: '呼吸の気', directional: false, duration: 0.7, origin: 'torso', desc: '人物の内側だけを巡る気の流れ・光の帯・粒子（輪郭の外には出ない）' },
  { id: 2, key: 'stance', name: '構えの発光', directional: false, duration: 0.6, origin: 'torso', desc: '輪郭の光、体の上を走る光、胸元の閃光' },
  { id: 3, key: 'strike', name: '打撃のエネルギー', directional: true, duration: 0.55, origin: 'auto', desc: '拳・足から攻撃方向へ伸びる光と火花、直前のコマの残像' },
  { id: 4, key: 'turn', name: '旋回の残像と風', directional: true, duration: 0.75, origin: 'torso', desc: '直前のコマの残像と、体を巻く空気（向きは左右）' },
]);
export const EFFECT_BY_ID = new Map(EFFECTS.map((e) => [e.id, e]));
/** 従来の preset（文字列）→ 番号 */
export const PRESET_ID = Object.freeze({ breath: 1, stance: 2, strike: 3, turn: 4, none: 0 });
/** コマンド（ボタン）ごとの既定のエフェクト */
export const DEFAULT_EFFECT_ID = Object.freeze({ Y: 1, X: 2, A: 3, B: 4 });
/** 廃止した番号（読み込み時に置き換える） */
export const RETIRED_EFFECT_IDS = Object.freeze([5]);

export const ORIGINS = Object.freeze([
  { key: 'auto', name: 'エフェクトの既定' },
  { key: 'torso', name: '胴体' },
  { key: 'head', name: '頭' },
  { key: 'left_wrist', name: '左の拳（画面の向きでなく本人の左）' },
  { key: 'right_wrist', name: '右の拳' },
  { key: 'left_ankle', name: '左足' },
  { key: 'right_ankle', name: '右足' },
  { key: 'point', name: '画面で指定した位置' },
]);
const ORIGIN_KEYS = new Set(ORIGINS.map((o) => o.key));

/** 調整できる値の範囲（編集画面のスライダーと検証で共通） */
export const RANGES = Object.freeze({
  size: [0.3, 3], intensity: [0, 2], duration: [0.1, 4], offset: [-1, 1],
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const inR = (v, [a, b]) => isNum(v) && v >= a && v <= b;

/** 従来の譜面の「未編集」の効果（preset がコマンドの既定のまま、強さ 1、ほかの指定なし） */
function untouched(note, legacyPreset) {
  const e = note.effect;
  if (!e) return true;
  if (e.id != null) return false;
  const keys = Object.keys(e).filter((k) => !(k === 'preset' && e.preset === legacyPreset) && !(k === 'intensity' && (e.intensity == null || e.intensity === 1)));
  return keys.length === 0;
}

const LEGACY_PRESET = { Y: 'breath', X: 'stance', A: 'strike', B: 'turn' };

/**
 * 廃止した番号 5（背後にまとう炎）の置き換え: 息のノーツは 1（呼吸の気）、ほかは 0（なし）。
 * 炎だけの項目（height・width）は外し、時刻・コマンド・位置・強さなどほかの値はそのまま。新しい effect を返す（元は変えない）
 */
export function migrateEffect(note) {
  const e = note.effect;
  if (!e || !(e.id === 5 || e.preset === 'backFire')) return e;
  const out = { ...e, id: note.button === 'Y' ? 1 : 0 };
  delete out.preset; delete out.height; delete out.width;
  return out;
}

/** ノーツのエフェクト番号（保存値 → 従来の preset → コマンドの既定） */
export function effectIdOf(note) {
  const e = migrateEffect(note) || {};
  if (e.id != null) return e.id;
  if (untouched(note, LEGACY_PRESET[note.button])) return DEFAULT_EFFECT_ID[note.button] ?? 0;
  return PRESET_ID[e.preset] ?? DEFAULT_EFFECT_ID[note.button] ?? 0;
}

/** 角度（度）。angle が無ければ従来の direction から */
export function angleOf(e) {
  if (isNum(e?.angle)) return e.angle;
  if (e?.direction && (e.direction.x || e.direction.y)) return Math.round(Math.atan2(e.direction.y, e.direction.x) * 180 / Math.PI);
  return null;
}

/** 描画に使う値をそろえる（既定値を補う。保存値は変えない） */
export function resolveEffect(note) {
  const id = effectIdOf(note);
  const def = EFFECT_BY_ID.get(id) || EFFECTS[0];
  const e = migrateEffect(note) || {};
  const ang = def.directional ? angleOf(e) : null;
  return {
    id, key: def.key, def,
    origin: ORIGIN_KEYS.has(e.origin) ? e.origin : (e.anchor && def.key === 'strike' ? 'point' : 'auto'),
    anchor: e.anchor || null,
    offset: { x: e.offset?.x ?? 0, y: e.offset?.y ?? 0 },
    angle: ang,
    direction: ang != null ? { x: Math.cos(ang * Math.PI / 180), y: Math.sin(ang * Math.PI / 180) } : null,
    size: e.size ?? 1,
    intensity: e.intensity ?? 1,
    duration: e.duration ?? def.duration,
  };
}

/** 種類を変えたときの effect: 方向・位置など前の種類の指定を残さない（強さ・大きさ・持続時間も既定へ） */
export function effectForId(id, keep = {}) {
  const out = { id };
  if (keep.anchor && EFFECT_BY_ID.get(id)?.key === 'strike') { out.origin = 'point'; out.anchor = keep.anchor; if (keep.angle != null) out.angle = keep.angle; }
  return out;
}

/** effect の検証（譜面の検証から呼ぶ）。エラー文の配列 */
export function validateEffect(e, at) {
  const errs = [];
  if (typeof e !== 'object' || Array.isArray(e)) return [`${at}: effect の形式が不正です`];
  // 廃止した番号・preset は読み込める（normalizeChart で置き換える）
  if (e.id != null && !EFFECT_BY_ID.has(e.id) && !RETIRED_EFFECT_IDS.includes(e.id)) errs.push(`${at}: 未知のエフェクト番号 ${JSON.stringify(e.id)}`);
  if (e.preset != null && !(e.preset in PRESET_ID) && e.preset !== 'backFire') errs.push(`${at}: 未知のエフェクト ${e.preset}`);
  if (e.origin != null && !ORIGIN_KEYS.has(e.origin)) errs.push(`${at}: effect.origin「${e.origin}」は使えません`);
  if (e.anchor != null && !(isNum(e.anchor.x) && isNum(e.anchor.y) && e.anchor.x >= 0 && e.anchor.x <= 1 && e.anchor.y >= 0 && e.anchor.y <= 1)) errs.push(`${at}: effect.anchor は 0〜1 の x, y です`);
  if (e.direction != null && !(isNum(e.direction.x) && isNum(e.direction.y) && Math.hypot(e.direction.x, e.direction.y) > 1e-6)) errs.push(`${at}: effect.direction は 0 でない x, y です`);
  if (e.offset != null && !(inR(e.offset.x, RANGES.offset) && inR(e.offset.y, RANGES.offset))) errs.push(`${at}: effect.offset は -1〜1 の x, y です`);
  if (e.angle != null && !(isNum(e.angle) && e.angle >= -360 && e.angle <= 360)) errs.push(`${at}: effect.angle は -360〜360 度です`);
  for (const k of ['size', 'intensity', 'duration']) {
    if (e[k] != null && !inR(e[k], RANGES[k])) errs.push(`${at}: effect.${k} は ${RANGES[k][0]}〜${RANGES[k][1]} です`);
  }
  return errs;
}
