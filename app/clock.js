// 共通の再生時計。画像・レーン・判定・音声はすべてこの時刻（時間軸の秒）を使う。
// - 音声があるとき: AudioContext の時計（実際に聞こえている位置）が基準。速度変更は playbackRate
// - 音声がないとき / 未許可のとき: performance.now() が基準
// 描画フレーム数や setInterval の積算では時刻を決めない。
// 音声は複数のトラック（元動画の音声と BGM）を同じ AudioContext・同じ時間軸に並べて鳴らす（別々の時計は持たない）。
// mix: true のとき（BGM のあるバージョン）は 音声・BGM・効果音 をそれぞれの音量（ミュート可）→ リミッター → 出力 に通す。
// mix: false（ver1）は従来どおり 音声の音量 → 出力、効果音 → 出力。

const IS_IOS = typeof navigator !== 'undefined' && (/iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

export class TimelineClock {
  constructor({ duration, mix = false }) {
    this.duration = duration;
    this.mix = mix;
    this.bgm = null;        // {buffer, gain(倍率), fade(秒), label}。BGM は時間軸の 0 秒から鳴らし、終わり（duration）で消える
    this.levels = { voice: 0.8, bgm: 0.6, sfx: 0.6 };
    this.mutes = { voice: false, bgm: false, sfx: false };
    this.sources = [];
    this.ctx = null;
    this.buffer = null;
    this.gain = null;
    this.audioStart = 0; // 音声の 0 秒が置かれる時間軸の位置
    this.state = 'stopped'; // stopped | playing | paused
    this.rate = 1;
    this.anchorT = 0;       // 基準時点の時間軸位置
    this.anchorBase = 0;    // 基準時点の時計値（秒。音声あり: ctx 時刻 / なし: perf 秒）
    this.volume = 0.8;
  }

  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain(); // 元動画の音声
      if (this.mix) {
        // 3 系統を足してもクリップしないよう、最後にリミッター
        this.limiter = this.ctx.createDynamicsCompressor();
        this.limiter.threshold.value = -3; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
        this.limiter.attack.value = 0.001; this.limiter.release.value = 0.15;
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.85; // リミッターの手前で余裕を取る（打撃音の立ち上がりでも 1.0 を超えないように）
        this.master.connect(this.limiter).connect(this.ctx.destination);
        this.outAnalyser = this.ctx.createAnalyser(); // 最終出力の確認用（音割れの検査）
        this.outAnalyser.fftSize = 2048;
        this.limiter.connect(this.outAnalyser);
        this.bgmBus = this.ctx.createGain();
        this.bgmFade = this.ctx.createGain();
        this.bgmDuck = this.ctx.createGain(); // 効果音の瞬間だけ BGM を少し下げる（効果音側が操作）
        this.bgmFade.connect(this.bgmDuck).connect(this.bgmBus).connect(this.master);
        this.sfxBus = this.ctx.createGain();
        this.sfxBus.connect(this.master);
        this.gain.connect(this.master);
        this.bgmAnalyser = this.ctx.createAnalyser();
        this.bgmAnalyser.fftSize = 2048;
        this.bgmBus.connect(this.bgmAnalyser);
        this._applyLevels(true);
      } else {
        this.gain.gain.value = this.volume;
        this.gain.connect(this.ctx.destination);
      }
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

  get usesAudio() { return !!((this.buffer || this.bgm) && this.ctx && this.ctx.state === 'running'); }

  setVolume(v) {
    if (this.mix) { this.setLevel('voice', v); return; }
    this.volume = v;
    if (this.gain) {
      const p = this.gain.gain, now = this.ctx.currentTime;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.setTargetAtTime(v, now, 0.01);
    }
  }

  /** 系統ごとの音量（0〜1）とミュート。mix のときだけ */
  setLevel(name, v) { this.levels[name] = v; this._applyLevels(); }
  setMute(name, on) { this.mutes[name] = !!on; this._applyLevels(); }

  _applyLevels(now = false) {
    if (!this.ctx || !this.mix) return;
    const set = (node, v) => {
      const p = node.gain, t = this.ctx.currentTime;
      if (now) { p.value = v; return; }
      p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.setTargetAtTime(v, t, 0.015);
    };
    const eff = (k) => (this.mutes[k] ? 0 : this.levels[k]);
    set(this.gain, eff('voice'));
    set(this.bgmBus, eff('bgm') * (this.bgm?.gain ?? 1));
    set(this.sfxBus, eff('sfx'));
  }

  /** BGM を読み込む（時間軸の 0 秒 = 曲の先頭）。gain: 曲ごとの音量合わせ（倍率）、fade: 終わりのフェードアウト（秒） */
  async loadBgm(arrayBuffer, opts = {}) {
    const buffer = await this.decode(arrayBuffer);
    this.setBgm(buffer, opts);
    return buffer;
  }

  async decode(arrayBuffer) {
    const ctx = this.ensureContext();
    if (!ctx) throw new Error('このブラウザは Web Audio API に対応していません');
    return ctx.decodeAudioData(arrayBuffer);
  }

  /** 再生中は差し替えない（呼ぶ側で止めてから）。次の play() から鳴る */
  setBgm(buffer, { gain = 1, fade = 1.5, label = '' } = {}) {
    this.bgm = { buffer, gain, fade, label };
    this._applyLevels(true);
  }

  clearBgm() { this.bgm = null; }

  /** BGM の出力の大きさ（RMS） */
  bgmLevel() {
    if (!this.bgmAnalyser) return 0;
    const d = new Float32Array(this.bgmAnalyser.fftSize);
    this.bgmAnalyser.getFloatTimeDomainData(d);
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
    return Math.sqrt(sum / d.length);
  }

  /** 基準の時計値（秒）。perfMs は performance.now() 基準のイベント時刻 */
  _base(perfMs = performance.now()) {
    if (!this._audioMode) return perfMs / 1000;
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime > 0) return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
    return this.ctx.currentTime - (performance.now() - perfMs) / 1000;
  }

  /** AudioContext の時刻 ct に鳴る音が、時間軸の何秒に聞こえるか（効果音の最も強い瞬間に画面の演出を合わせる） */
  timelineAtCtx(ct) {
    if (this.state !== 'playing' || !this._audioMode) return null;
    return this.anchorT + (ct - this.anchorBase) * this.rate;
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
      if (this.buffer) this._schedule(from, when);
      if (this.bgm) this._scheduleBgm(from, when);
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
    this.sources.push(src);
  }

  /** BGM: 時間軸 0 秒 = 曲の先頭。演武の終わり（duration）に向けて fade 秒で消し、そこで止める */
  _scheduleBgm(from, when) {
    const { buffer, fade } = this.bgm;
    const end = Math.min(this.duration, buffer.duration);
    const g = this.bgmFade.gain;
    g.cancelScheduledValues(0);
    if (from >= end) { g.setValueAtTime(0, when); return; }
    const at = (t) => when + (t - from) / this.rate; // 時間軸の t 秒が鳴る ctx 時刻
    const fadeStart = end - fade;
    if (from < fadeStart) {
      g.setValueAtTime(1, when);
      g.setValueAtTime(1, at(fadeStart));
    } else {
      g.setValueAtTime(Math.max(0, (end - from) / fade), when);
    }
    g.linearRampToValueAtTime(0, at(end));
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = this.rate;
    src.connect(this.bgmFade);
    if (from >= 0) src.start(when, from);
    else src.start(at(0), 0);
    src.stop(at(end) + 0.05);
    this.sources.push(src);
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

  /** 鳴らしている音源（元動画の音声・BGM）をすべて止める。同じ音が二重に鳴らないよう、再生の前に必ず呼ぶ */
  _stopSource() {
    const list = this.sources;
    this.sources = [];
    for (const s of list) {
      try { s.stop(); } catch { /* 既に停止 */ }
      s.disconnect();
    }
  }

  /** 止めていない音源の数（確認用） */
  get activeSources() { return this.sources.length; }

  /** ページを離れる・バージョンを切り替える前: 音をすべて止める */
  shutdown() {
    this._stopSource();
    this.state = 'stopped';
    try { this.ctx?.close(); } catch { /* 閉じられない */ }
  }
}
