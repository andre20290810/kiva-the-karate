// 入力: キーボード / タッチ・マウス / ゲームパッド を同じ4種の論理コマンドへ変換する。
// 判定処理は持たず、{cmd, perfMs, source, id} を onCommand に渡すだけ。

export const DEFAULT_BINDINGS = {
  keyboard: {
    // 物理キー（event.code）→ レーン番号
    KeyD: 0, KeyF: 1, KeyJ: 2, KeyK: 3,
    ArrowLeft: 0, ArrowDown: 1, ArrowUp: 2, ArrowRight: 3,
  },
  // Standard Gamepad の buttons[] 番号 → レーン番号
  // 0:A(下) 1:B(右) 2:X(左) 3:Y(上) / 14:十字左 13:十字下 12:十字上 15:十字右
  gamepad: { 2: 0, 0: 1, 3: 2, 1: 3, 14: 0, 13: 1, 12: 2, 15: 3 },
};

let seq = 0;
const nextId = (src) => `${src}:${++seq}`;

export class InputRouter {
  /**
   * @param {string[]} commands レーン番号 → 論理コマンドID（譜面で定義）
   * @param {(ev:{cmd:string, perfMs:number, source:string, id:string, lane:number})=>void} onCommand
   */
  constructor(commands, onCommand, bindings = DEFAULT_BINDINGS) {
    this.commands = commands;
    this.onCommand = onCommand;
    this.bindings = bindings;
    this.enabled = true;
    this.keysDown = new Set();
    this.padPrev = new Map(); // gamepad.index → boolean[]
    this.pointerLanes = new Map(); // pointerId → lane
    this.lastPointerAt = new Array(commands.length).fill(-1e9);
    this.gamepads = [];
    this._handlers = [];
  }

  emit(lane, perfMs, source) {
    if (!this.enabled || lane == null || !this.commands[lane]) return;
    this.onCommand({ cmd: this.commands[lane], lane, perfMs, source, id: nextId(source) });
  }

  _listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._handlers.push(() => target.removeEventListener(type, fn, opts));
  }

  attachKeyboard(target = window) {
    this._listen(target, 'keydown', (e) => {
      const lane = this.bindings.keyboard[e.code];
      if (lane == null) return;
      e.preventDefault();
      // 押しっぱなしのオートリピートと、離さずの再押下を無視
      if (e.repeat || this.keysDown.has(e.code)) return;
      this.keysDown.add(e.code);
      this.emit(lane, e.timeStamp, 'keyboard');
    });
    this._listen(target, 'keyup', (e) => this.keysDown.delete(e.code));
    this._listen(window, 'blur', () => this.keysDown.clear());
  }

  /** タッチボタン。pointerdown のみで発火し、後続の click / mousedown は無視する。 */
  attachButtons(buttons) {
    buttons.forEach((btn, lane) => {
      this._listen(btn, 'pointerdown', (e) => {
        e.preventDefault();
        if (this.pointerLanes.has(e.pointerId)) return;
        // 同一ボタンへのタッチ→互換マウスイベントの二重発火対策（40ms以内の重複は無視）
        if (e.timeStamp - this.lastPointerAt[lane] < 40) return;
        this.lastPointerAt[lane] = e.timeStamp;
        this.pointerLanes.set(e.pointerId, lane);
        btn.classList.add('pressed');
        try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        this.emit(lane, e.timeStamp, e.pointerType === 'mouse' ? 'mouse' : 'touch');
      });
      const up = (e) => {
        if (this.pointerLanes.get(e.pointerId) === lane) this.pointerLanes.delete(e.pointerId);
        btn.classList.remove('pressed');
      };
      this._listen(btn, 'pointerup', up);
      this._listen(btn, 'pointercancel', up);
      this._listen(btn, 'click', (e) => e.preventDefault());
      this._listen(btn, 'contextmenu', (e) => e.preventDefault());
    });
  }

  /**
   * ゲームパッドは毎フレームポーリングし、押下の立ち上がりのみを入力にする（保持は無視）。
   * Gamepad API はボタンごとの押下時刻を持たないため、ポーリング時刻を入力時刻とする
   * （最大1フレーム≒16ms の遅れ。表示に明記）。
   */
  pollGamepads(perfMs = performance.now()) {
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    this.gamepads = pads.map((p) => ({
      index: p.index, id: p.id, mapping: p.mapping, connected: p.connected,
      pressed: p.buttons.map((b, i) => (b.pressed ? i : -1)).filter((i) => i >= 0),
    }));
    for (const p of pads) {
      const prev = this.padPrev.get(p.index) || [];
      const cur = p.buttons.map((b) => b.pressed);
      cur.forEach((down, i) => {
        if (down && !prev[i]) this.emit(this.bindings.gamepad[i], perfMs, 'gamepad');
      });
      this.padPrev.set(p.index, cur);
    }
  }

  /** 一時停止・再開時に、押しっぱなしの状態を「押下済み」として扱い直す。 */
  resetHeld() {
    this.keysDown.clear();
    for (const p of (navigator.getGamepads ? [...navigator.getGamepads()] : []).filter(Boolean)) {
      this.padPrev.set(p.index, p.buttons.map((b) => b.pressed));
    }
  }

  detach() { this._handlers.forEach((off) => off()); this._handlers = []; }
}
