// 入力成功音・呼吸などの効果音（Web Audio で合成。音声ファイル不要）。
// 再生時計と同じ AudioContext・同じ出力経路で鳴らす。

export class Sfx {
  constructor(clock) {
    this.clock = clock;
    this.volume = 0.6;
    this.enabled = true;
    this._noise = null;
    this.breathNode = null;
  }

  get ctx() { return this.clock.ctx && this.clock.ctx.state === 'running' ? this.clock.ctx : null; }

  _noiseBuf() {
    if (this._noise) return this._noise;
    const c = this.ctx, n = c.sampleRate;
    const b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return (this._noise = b);
  }

  _out(gain) {
    const g = this.ctx.createGain();
    g.gain.value = gain * this.volume;
    g.connect(this.ctx.destination);
    return g;
  }

  _noiseBurst({ when, dur, type = 'bandpass', f0, f1, q = 1, gain = 0.5, attack = 0.005 }) {
    const c = this.ctx, src = c.createBufferSource();
    src.buffer = this._noiseBuf();
    const f = c.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, when);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, when + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(f).connect(g).connect(this._out(1));
    src.start(when, Math.random() * 0.5, dur + 0.05);
  }

  _tone({ when, dur, f0, f1, type = 'sine', gain = 0.4 }) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, when);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, when + dur);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g).connect(this._out(1));
    o.start(when); o.stop(when + dur + 0.02);
  }

  /** 成功音 kind: stance|strike|kick|turn|breath、grade: PERFECT|GOOD */
  play(kind, grade = 'PERFECT') {
    if (!this.enabled || !this.ctx) return;
    const w = this.ctx.currentTime + 0.005, k = grade === 'PERFECT' ? 1 : 0.7;
    if (kind === 'strike' || kind === 'kick') {
      this._noiseBurst({ when: w, dur: 0.16, f0: kind === 'kick' ? 900 : 1400, f1: 300, q: 0.8, gain: 0.55 * k });
      this._tone({ when: w, dur: 0.18, f0: 150, f1: 48, gain: 0.6 * k });
    } else if (kind === 'stance') {
      this._tone({ when: w, dur: 0.12, f0: 110, f1: 70, gain: 0.45 * k });
      this._noiseBurst({ when: w, dur: 0.07, type: 'highpass', f0: 3000, q: 0.5, gain: 0.22 * k });
    } else if (kind === 'turn') {
      this._noiseBurst({ when: w, dur: 0.38, f0: 400, f1: 2400, q: 2.5, gain: 0.35 * k, attack: 0.08 });
    } else if (kind === 'breath') {
      this._tone({ when: w, dur: 0.5, f0: 660, f1: 880, type: 'triangle', gain: 0.12 * k });
    }
  }

  miss() {
    if (!this.enabled || !this.ctx) return;
    this._tone({ when: this.ctx.currentTime + 0.005, dur: 0.12, f0: 180, f1: 120, type: 'triangle', gain: 0.12 });
  }

  /** 長押し中の息の音（呼気のノイズ）。start/stop は押下・解放に合わせる */
  breathStart() {
    if (!this.enabled || !this.ctx || this.breathNode) return;
    const c = this.ctx, src = c.createBufferSource();
    src.buffer = this._noiseBuf(); src.loop = true;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 0.7;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.09 * this.volume, c.currentTime + 0.4);
    src.connect(f).connect(g).connect(c.destination);
    src.start();
    this.breathNode = { src, g };
  }

  breathStop() {
    const b = this.breathNode;
    if (!b) return;
    this.breathNode = null;
    try {
      const c = this.ctx || this.clock.ctx;
      b.g.gain.cancelScheduledValues(c.currentTime);
      b.g.gain.setTargetAtTime(0.0001, c.currentTime, 0.06);
      b.src.stop(c.currentTime + 0.3);
    } catch { /* ignore */ }
  }
}
