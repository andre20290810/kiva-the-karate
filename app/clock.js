// 共通の再生時計。画像・レーン・判定・音声はすべてこの時刻（時間軸の秒）を使う。
// - 音声があるとき: AudioContext の時計（実際に聞こえている位置）が基準。速度変更は playbackRate
// - 音声がないとき / 未許可のとき: performance.now() が基準
// 描画フレーム数や setInterval の積算では時刻を決めない。

const IS_IOS = typeof navigator !== 'undefined' && (/iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

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
      // 出力に音声信号が乗っているかの確認用（表示だけに使う。音は変えない）
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.gain.connect(this.analyser);
      this._probe = new Float32Array(this.analyser.fftSize);
      this.ctx.onstatechange = () => this.onStateChange?.(this.ctx.state);
    }
    return this.ctx;
  }

  async loadAudio(arrayBuffer, startAtTimelineSeconds = 0) {
    const ctx = this.ensureContext();
    if (!ctx) throw new Error('このブラウザは Web Audio API に対応していません');
    this.buffer = await ctx.decodeAudioData(arrayBuffer);
    this.audioStart = startAtTimelineSeconds;
  }

  /**
   * ユーザー操作（クリック・タップ）の中で呼ぶ。音を出せる状態になったら true。
   * - iPhone: Web Audio は既定で消音スイッチに従って無音になるため、音声セッションを「再生」にする
   *   （iOS 17 以降は navigator.audioSession、それより前は無音の audio 要素を鳴らして切り替える）
   * - AudioContext は suspended だけでなく interrupted（iOS の割り込み後）からも再開する
   */
  async unlock() {
    const ctx = this.ensureContext();
    if (!ctx) { this.lastError = 'Web Audio API に対応していません'; return false; }
    this.lastError = '';
    try {
      if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback';
    } catch (e) { this.lastError = `audioSession: ${e.message}`; }
    if (!navigator.audioSession && IS_IOS) this._keepAlive();
    if (ctx.state !== 'running') {
      try {
        await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
      } catch (e) { this.lastError = `resume: ${e.message}`; }
    }
    if (ctx.state !== 'running' && !this.lastError) this.lastError = `AudioContext が ${ctx.state} のまま`;
    return ctx.state === 'running';
  }

  /** iOS 16 以前: 無音の audio 要素を再生して、ページの音声を消音スイッチの影響外（再生カテゴリ）にする */
  _keepAlive() {
    if (!this._silent) {
      const rate = 8000, n = rate / 2, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
      const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
      w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
      v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
      v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
      this._silent = new Audio(URL.createObjectURL(new Blob([b], { type: 'audio/wav' })));
      this._silent.loop = true;
      this._silent.setAttribute('playsinline', '');
    }
    this._silent.play().catch((e) => { this.lastError = `audio 要素: ${e.message}`; });
  }

  /** 音楽の出力の大きさ（RMS、0〜1）。再生していない・音が無いと 0 */
  outputLevel() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this._probe);
    let sum = 0;
    for (let i = 0; i < this._probe.length; i++) sum += this._probe[i] * this._probe[i];
    return Math.sqrt(sum / this._probe.length);
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
