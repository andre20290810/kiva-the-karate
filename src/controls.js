// 操作割り当ての一元管理（純粋ロジック・DOM非依存）。
// 「論理ボタン（A/B/X/Y＝ひし形の位置）」⇔「譜面のコマンド」⇔「キー／ゲームパッド番号」を
// ここだけで決め、画面のボタン・譜面レーンの表示・入力判定はすべてこの表を参照する。
//
// ボタン名は Xbox 配置の“位置”を表す:   Y=上 / X=左 / B=右 / A=下
// （Nintendo 配置のコントローラーでも、物理的に下のボタンが A として扱われる）

export const FACE_BUTTONS = ['Y', 'X', 'B', 'A'];

export const FACE = Object.freeze({
  Y: { pos: 'up', color: '#ffc531', glow: '255,197,49', dir: [0, -1] },
  X: { pos: 'left', color: '#2f8dff', glow: '47,141,255', dir: [-1, 0] },
  B: { pos: 'right', color: '#ff3b55', glow: '255,59,85', dir: [1, 0] },
  A: { pos: 'down', color: '#2fdc7c', glow: '47,220,124', dir: [0, 1] },
});

// 譜面の commands[i] に button 指定がない場合の既定順
export const DEFAULT_BUTTON_ORDER = ['A', 'B', 'X', 'Y'];

export const KEYBOARD = Object.freeze({
  ArrowUp: 'Y', ArrowLeft: 'X', ArrowRight: 'B', ArrowDown: 'A',
  KeyI: 'Y', KeyJ: 'X', KeyL: 'B', KeyK: 'A',
  KeyW: 'Y', KeyA: 'X', KeyD: 'B', KeyS: 'A',
});

// Standard Gamepad（W3C）: 0=下 1=右 2=左 3=上 / 十字キー 12=上 13=下 14=左 15=右
export const STANDARD_PROFILE = Object.freeze({
  name: 'standard', buttons: { A: [0, 13], B: [1, 15], X: [2, 14], Y: [3, 12] },
});

/** 接続デバイスの種類を推定（表示用） */
export function describePad(id = '', mapping = '') {
  const s = id.toLowerCase();
  let vendor = 'ゲームパッド';
  if (s.includes('gamesir')) vendor = 'GameSir';
  else if (s.includes('xbox') || s.includes('xinput') || s.includes('045e')) vendor = 'Xbox 互換 (XInput)';
  else if (s.includes('054c') || s.includes('dualsense') || s.includes('dualshock')) vendor = 'PlayStation 系';
  else if (s.includes('057e') || s.includes('pro controller')) vendor = 'Nintendo 系';
  return { vendor, standard: mapping === 'standard' };
}

/**
 * 譜面のコマンド一覧から割り当て表を作る。
 * @param {Array<{id:string,label?:string,button?:string}>} commands
 */
export function buildControlMap(commands) {
  if (!Array.isArray(commands) || commands.length !== 4) throw new Error('commands は4種類必要です');
  const used = new Set();
  const byCommand = new Map();
  const byButton = new Map();
  commands.forEach((c, i) => {
    const button = c.button || DEFAULT_BUTTON_ORDER[i];
    if (!FACE[button]) throw new Error(`未知のボタン ${button}（A/B/X/Y のいずれか）`);
    if (used.has(button)) throw new Error(`ボタン ${button} が複数のコマンドに割り当てられています`);
    used.add(button);
    const entry = { cmd: c.id, button, label: c.label || c.id, name: c.name || c.label || c.id, lane: i, ...FACE[button] };
    byCommand.set(c.id, entry);
    byButton.set(button, entry);
  });
  return {
    byCommand, byButton,
    commandFor: (button) => byButton.get(button)?.cmd ?? null,
    buttonFor: (cmd) => byCommand.get(cmd)?.button ?? null,
    entries: FACE_BUTTONS.map((b) => byButton.get(b)),
  };
}

/** ゲームパッドのボタン番号 → 論理ボタン の逆引き表を作る */
export function invertProfile(profile) {
  const m = new Map();
  for (const [btn, idxs] of Object.entries(profile.buttons)) for (const i of [].concat(idxs)) m.set(i, btn);
  return m;
}

/**
 * キャリブレーション結果の保存・読込（localStorage 互換の storage を渡す）。
 * 実機ごと（Gamepad.id ごと）に記録する。
 */
export class PadProfiles {
  constructor(storage, key = 'kiva.padProfiles.v1') {
    this.storage = storage;
    this.key = key;
    try { this.saved = JSON.parse(storage?.getItem(key) || '{}'); } catch { this.saved = {}; }
  }

  get(id, mapping) {
    if (this.saved[id]) return { name: 'calibrated', buttons: this.saved[id] };
    // 標準配置でない場合も、まずは標準番号で試す（GameSir の XInput/Android モードは通常 standard）
    return { ...STANDARD_PROFILE, name: mapping === 'standard' ? 'standard' : 'standard(推定)' };
  }

  set(id, buttons) {
    for (const b of FACE_BUTTONS) if (!Number.isInteger(buttons[b])) throw new Error(`${b} の番号がありません`);
    const vals = FACE_BUTTONS.map((b) => buttons[b]);
    if (new Set(vals).size !== 4) throw new Error('同じボタン番号が重複しています');
    this.saved[id] = { ...buttons };
    try { this.storage?.setItem(this.key, JSON.stringify(this.saved)); } catch { /* 保存不可でも動作は継続 */ }
  }

  clear(id) {
    delete this.saved[id];
    try { this.storage?.setItem(this.key, JSON.stringify(this.saved)); } catch { /* ignore */ }
  }
}
