// 入力: キーボード（Y/X/A/B キー）・画面ボタン（タッチ／マウス）・ゲームパッド → 押した／離した（論理ボタン）。
// 判定はしない。すべての経路が press / release に合流し、各押下に一意の ID を付ける。

export const BUTTON_ORDER = ['Y', 'X', 'A', 'B'];
export const KEYMAP = Object.freeze({ KeyY: 'Y', KeyX: 'X', KeyA: 'A', KeyB: 'B' });
// 標準ゲームパッド（Xbox 配置）: 0 = 下(A) 1 = 右(B) 2 = 左(X) 3 = 上(Y)。
// Nintendo 配置のコントローラーでも「位置」で対応する（右のボタンが B ではなく A と印字されている場合がある）。
export const PAD_INDEX = Object.freeze({ 0: 'A', 1: 'B', 2: 'X', 3: 'Y' });

let seq = 0;

export class Input {
  constructor() {
    this.onPress = null;   // (button, perfMs, {id, source})
    this.onRelease = null; // (button, perfMs, {source})
    this.down = new Map(); // button → Set(source)
    this.devices = new Map(); // button → 押したときの入力方法（離したときの記録用）
    this.keys = new Set();
    this.pointers = new Map(); // pointerId → button
    this.padPrev = new Map();
    this.enabled = true;
    this.offs = [];
  }

  _on(t, type, fn, opt) { t.addEventListener(type, fn, opt); this.offs.push(() => t.removeEventListener(type, fn, opt)); }

  isDown(b) { return (this.down.get(b)?.size || 0) > 0; }

  /** device: 記録用の入力方法（keyboard | touch | mouse | pen | gamepad） */
  _press(b, perfMs, source, device = source === 'key' ? 'keyboard' : source.startsWith('pad') ? 'gamepad' : 'mouse') {
    let s = this.down.get(b);
    if (!s) this.down.set(b, (s = new Set()));
    const was = s.size > 0;
    s.add(source);
    if (was || !this.enabled) return; // 別経路で既に押している（同じボタンの二重押下は 1 回）
    this.devices.set(b, device);
    this.onPress?.(b, perfMs, { id: `${source}:${++seq}`, source, device });
  }

  _release(b, perfMs, source) {
    const s = this.down.get(b);
    if (!s || !s.has(source)) return;
    s.delete(source);
    if (s.size === 0 && this.enabled) this.onRelease?.(b, perfMs, { source, device: this.devices.get(b) ?? source });
  }

  attachKeyboard(target = window) {
    const typing = (e) => e.target?.closest?.('input, select, textarea, [contenteditable="true"]');
    this._on(target, 'keydown', (e) => {
      const b = KEYMAP[e.code];
      if (!b || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      e.preventDefault();
      if (e.repeat || this.keys.has(e.code)) return; // 押しっぱなしの自動リピートは無視
      this.keys.add(e.code);
      this._press(b, e.timeStamp, 'key');
    });
    this._on(target, 'keyup', (e) => {
      const b = KEYMAP[e.code];
      if (!this.keys.delete(e.code) || !b) return;
      if (![...this.keys].some((c) => KEYMAP[c] === b)) this._release(b, e.timeStamp, 'key');
    });
    this._on(window, 'blur', () => this.releaseAll());
  }

  /** 画面のボタン（pointer イベントのみ。click は使わないので、タッチとクリックで二重にならない） */
  attachButtons(map) {
    for (const [b, el] of Object.entries(map)) {
      this._on(el, 'pointerdown', (e) => {
        e.preventDefault();
        if (this.pointers.has(e.pointerId)) return;
        this.pointers.set(e.pointerId, b);
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        this._press(b, e.timeStamp, 'pointer', e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse');
      });
      const up = (e) => {
        if (this.pointers.get(e.pointerId) !== b) return;
        this.pointers.delete(e.pointerId);
        if (![...this.pointers.values()].includes(b)) this._release(b, e.timeStamp, 'pointer');
      };
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) this._on(el, t, up);
      this._on(el, 'contextmenu', (e) => e.preventDefault());
    }
  }

  /** ゲームパッドは描画ごとに状態を読む（押下時刻はポーリング時刻） */
  pollGamepads(perfMs = performance.now()) {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    for (const p of pads) {
      const cur = p.buttons.map((x) => x.pressed || x.value > 0.5);
      const prev = this.padPrev.get(p.index);
      if (prev) for (const [i, b] of Object.entries(PAD_INDEX)) {
        if (cur[i] && !prev[i]) this._press(b, perfMs, `pad${p.index}`);
        else if (!cur[i] && prev[i]) this._release(b, perfMs, `pad${p.index}`);
      }
      this.padPrev.set(p.index, cur);
    }
    return pads.length;
  }

  releaseAll(perfMs = performance.now()) {
    this.keys.clear();
    this.pointers.clear();
    for (const [b, s] of this.down) for (const src of [...s]) this._release(b, perfMs, src);
  }

  detach() { this.offs.forEach((f) => f()); this.offs = []; }
}
