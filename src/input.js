// 入力: キーボード / タッチ・マウス / ゲームパッド → 論理ボタン(A/B/X/Y) → 譜面コマンド。
// 割り当ては controls.js の一元表のみを参照する。判定処理は持たず、
// {cmd, button, perfMs, source, id} を onCommand に渡すだけ。

import { KEYBOARD, PadProfiles, describePad, invertProfile } from './controls.js';

let seq = 0;
const nextId = (src) => `${src}:${++seq}`;

export class InputRouter {
  /**
   * @param {ReturnType<import('./controls.js').buildControlMap>} controlMap
   * @param {(ev:{cmd:string, button:string, perfMs:number, source:string, id:string})=>void} onCommand
   * @param {{storage?:Storage, keyboard?:object, getGamepads?:()=>Gamepad[]}} opts
   */
  constructor(controlMap, onCommand, opts = {}) {
    this.map = controlMap;
    this.onCommand = onCommand;
    this.keyboard = opts.keyboard || KEYBOARD;
    this.getGamepads = opts.getGamepads || (() => (navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : []));
    this.profiles = new PadProfiles(opts.storage ?? safeStorage());
    this.enabled = true;
    this.keysDown = new Set();
    this.padPrev = new Map(); // gamepad.index → boolean[]
    this.pointerButtons = new Map(); // pointerId → button
    this.lastPointerAt = {};
    this.held = new Map(); // button → Set(source)  画面表示用
    this.onHeldChange = null;
    this.onPadsChange = null;
    this.gamepads = [];
    this.capture = null; // キャリブレーション中は入力をこちらへ
    this._handlers = [];
  }

  /** 論理ボタンの押下（全入力経路の合流点） */
  press(button, perfMs, source) {
    this._setHeld(button, source, true);
    if (!this.enabled) return;
    const cmd = this.map.commandFor(button);
    if (!cmd) return;
    this.onCommand({ cmd, button, perfMs, source, id: nextId(source) });
  }

  release(button, source) { this._setHeld(button, source, false); }

  _setHeld(button, source, down) {
    let s = this.held.get(button);
    if (!s) this.held.set(button, (s = new Set()));
    const before = s.size > 0;
    if (down) s.add(source); else s.delete(source);
    if (before !== s.size > 0) this.onHeldChange?.(button, s.size > 0);
  }

  isHeld(button) { return (this.held.get(button)?.size || 0) > 0; }

  _listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._handlers.push(() => target.removeEventListener(type, fn, opts));
  }

  attachKeyboard(target = window) {
    this._listen(target, 'keydown', (e) => {
      const button = this.keyboard[e.code];
      if (!button || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target?.closest?.('input, select, textarea')) return;
      e.preventDefault();
      // 押しっぱなしのオートリピートと、離さずの再押下を無視
      if (e.repeat || this.keysDown.has(e.code)) return;
      this.keysDown.add(e.code);
      this.press(button, e.timeStamp, 'keyboard');
    });
    this._listen(target, 'keyup', (e) => {
      const button = this.keyboard[e.code];
      this.keysDown.delete(e.code);
      if (button && ![...this.keysDown].some((c) => this.keyboard[c] === button)) this.release(button, 'keyboard');
    });
    this._listen(window, 'blur', () => this.releaseAll());
  }

  /** 画面のボタン。pointerdown のみで発火し、後続の click / 互換マウスイベントは無視する。 */
  attachButtons(elements) {
    for (const [button, el] of Object.entries(elements)) {
      this._listen(el, 'pointerdown', (e) => {
        e.preventDefault();
        if (this.pointerButtons.has(e.pointerId)) return;
        // タッチ→互換マウスイベントの二重発火対策（同じボタン 40ms 以内の重複は無視）
        if (e.timeStamp - (this.lastPointerAt[button] ?? -1e9) < 40) return;
        this.lastPointerAt[button] = e.timeStamp;
        this.pointerButtons.set(e.pointerId, button);
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        this.press(button, e.timeStamp, e.pointerType === 'mouse' ? 'mouse' : 'touch');
      });
      const up = (e) => {
        if (this.pointerButtons.get(e.pointerId) !== button) return;
        this.pointerButtons.delete(e.pointerId);
        if (![...this.pointerButtons.values()].includes(button)) {
          this.release(button, 'touch');
          this.release(button, 'mouse');
        }
      };
      this._listen(el, 'pointerup', up);
      this._listen(el, 'pointercancel', up);
      this._listen(el, 'lostpointercapture', up);
      this._listen(el, 'click', (e) => e.preventDefault());
      this._listen(el, 'contextmenu', (e) => e.preventDefault());
    }
  }

  /**
   * ゲームパッドは毎フレームポーリングし、押下の立ち上がりのみを入力にする（保持は無視）。
   * Gamepad API はボタンごとの押下時刻を持たないため、ポーリング時刻を入力時刻とする（最大1フレームの遅れ）。
   */
  pollGamepads(perfMs = performance.now()) {
    const pads = this.getGamepads();
    const seen = new Set();
    const info = [];
    for (const p of pads) {
      if (!p || p.connected === false) continue;
      seen.add(p.index);
      const profile = this.profiles.get(p.id, p.mapping);
      const inv = invertProfile(profile);
      const prev = this.padPrev.get(p.index);
      const cur = p.buttons.map((b) => (typeof b === 'object' ? b.pressed || b.value > 0.5 : b > 0.5));
      if (this.capture) {
        cur.forEach((down, i) => { if (down && prev && !prev[i]) this.capture({ pad: p, index: i }); });
      } else if (prev) {
        // 接続直後のフレームは基準取りのみ（押しっぱなしで接続しても入力にしない）
        cur.forEach((down, i) => {
          const btn = inv.get(i);
          if (!btn) return;
          if (down && !prev[i]) this.press(btn, perfMs, `gamepad${p.index}`);
          else if (!down && prev[i]) this.release(btn, `gamepad${p.index}`);
        });
      }
      this.padPrev.set(p.index, cur);
      info.push({
        index: p.index, id: p.id, mapping: p.mapping, profile: profile.name,
        ...describePad(p.id, p.mapping),
        pressedIdx: cur.map((d, i) => (d ? i : -1)).filter((i) => i >= 0),
        pressedButtons: cur.map((d, i) => (d ? inv.get(i) : null)).filter(Boolean),
      });
    }
    // 切断されたパッドの押下状態を解除
    for (const idx of [...this.padPrev.keys()]) {
      if (!seen.has(idx)) {
        this.padPrev.delete(idx);
        for (const b of ['A', 'B', 'X', 'Y']) this.release(b, `gamepad${idx}`);
      }
    }
    const sig = (g) => `${g.index}|${g.id}|${g.profile}|${g.pressedButtons.join('')}|${g.pressedIdx.join(',')}`;
    const changed = info.length !== this.gamepads.length || info.some((g, i) => sig(g) !== sig(this.gamepads[i] || { pressedButtons: [], pressedIdx: [] }));
    this.gamepads = info;
    if (changed) this.onPadsChange?.(info);
    return info;
  }

  /** 一時停止・再開時に、押しっぱなしの状態を「押下済み」として扱い直す。 */
  resetHeld() {
    this.keysDown.clear();
    for (const p of this.getGamepads()) {
      if (p) this.padPrev.set(p.index, p.buttons.map((b) => (typeof b === 'object' ? b.pressed || b.value > 0.5 : b > 0.5)));
    }
  }

  releaseAll() {
    this.keysDown.clear();
    for (const [b, s] of this.held) for (const src of [...s]) this.release(b, src);
  }

  detach() { this._handlers.forEach((off) => off()); this._handlers = []; }
}

function safeStorage() {
  try { return window.localStorage; } catch { return null; }
}
