// 共通の再生時計。画像・レーン・判定・音声はすべてこの時刻（時間軸の秒）を使う。
// - 音声があるとき: AudioContext の時計（実際に聞こえている位置）が基準。速度変更は playbackRate
// - 音声がないとき / 未許可のとき: performance.now() が基準
// 描画フレーム数や setInterval の積算では時刻を決めない。

export class TimelineClock {
  constructor({ duration }) {
    this.duration = duration;
    this.ctx = null;
    this.buffer = null;
    this.gain = null;
    this.audioStart = 0; // 音声の 0 秒が置かれる時間軸の位置
    this.state = 'stopped'; // stopped | playing | paused
    this.rate = 1;
    this.anchorT = 0;       // 基準時点の時間軸位置
    this.anchorBase = 0;    // 基準時点の時計値（秒。音声あり: ctx 時刻 / なし: perf 秒）
    this.source = null;
    this.volume = 0.8;
  }

  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  async loadAudio(arrayBuffer, startAtTimelineSeconds = 0) {
    const ctx = this.ensureContext();
    if (!ctx) throw new Error('このブラウザは Web Audio API に対応していません');
    this.buffer = await ctx.decodeAudioData(arrayBuffer);
    this.audioStart = startAtTimelineSeconds;
  }

  /** ユーザー操作の中で呼ぶ（自動再生制限の解除） */
  async unlock() {
    const ctx = this.ensureContext();
    if (ctx && ctx.state === 'suspended') await ctx.resume();
  }

  get usesAudio() { return !!(this.buffer && this.ctx && this.ctx.state === 'running'); }

  setVolume(v) {
    this.volume = v;
    if (this.gain) {
      const p = this.gain.gain, now = this.ctx.currentTime;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.setTargetAtTime(v, now, 0.01);
    }
  }

  /** 基準の時計値（秒）。perfMs は performance.now() 基準のイベント時刻 */
  _base(perfMs = performance.now()) {
    if (!this._audioMode) return perfMs / 1000;
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime > 0) return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
    return this.ctx.currentTime - (performance.now() - perfMs) / 1000;
  }

  /** 時間軸の位置（秒）。perfMs を渡すとその時点の位置（入力イベントの timeStamp 用） */
  position(perfMs = performance.now()) {
    if (this.state !== 'playing') return this.anchorT;
    const t = this.anchorT + (this._base(perfMs) - this.anchorBase) * this.rate;
    return Math.min(t, this.duration);
  }

  play(from = this.anchorT) {
    this._stopSource();
    this._audioMode = this.usesAudio;
    if (this._audioMode) {
      const when = this.ctx.currentTime + 0.04;
      this.anchorBase = when;
      this._schedule(from, when);
    } else {
      this.anchorBase = performance.now() / 1000;
    }
    this.anchorT = from;
    this.state = 'playing';
  }

  _schedule(from, when) {
    const b = this.buffer;
    const audioPos = from - this.audioStart;
    if (audioPos >= b.duration) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = this.rate;
    src.connect(this.gain);
    if (audioPos >= 0) src.start(when, audioPos);
    else src.start(when + -audioPos / this.rate, 0); // 先頭の待ち時間（リードイン）の後に鳴らす
    this.source = src;
  }

  pause() {
    if (this.state !== 'playing') return;
    this.anchorT = this.position();
    this._stopSource();
    this.state = 'paused';
  }

  seek(t) {
    const to = Math.max(-30, Math.min(t, this.duration));
    if (this.state === 'playing') this.play(to);
    else { this.anchorT = to; }
  }

  setRate(r) {
    if (r === this.rate) return;
    if (this.state === 'playing') { const t = this.position(); this.rate = r; this.play(t); }
    else this.rate = r;
  }

  stop(at = 0) {
    this._stopSource();
    this.state = 'stopped';
    this.anchorT = at;
  }

  _stopSource() {
    if (!this.source) return;
    const s = this.source;
    this.source = null;
    try { s.stop(); } catch { /* 既に停止 */ }
    s.disconnect();
  }
}
