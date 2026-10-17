// 音声再生位置を唯一の基準時刻とするクロック。
// AudioContext.currentTime（音声ハードウェア時計）から再生位置を求めるので、
// フレーム数の加算や setInterval には依存しない。

export class AudioClock {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.gain = null;
    this.state = 'idle'; // idle | playing | paused | ended
    this.offset = 0;      // 再生開始時点の曲内位置（秒）
    this.startCtxTime = 0;
    this.volume = 0.8;
    this.onended = null;
    this._endTimer = null;
  }

  /** AudioContext を作成（ユーザー操作前は suspended のまま。デコードは可能） */
  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('このブラウザは Web Audio API に対応していません');
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** ユーザー操作（開始ボタン）の中で呼び、ブラウザの自動再生制限を解除する。 */
  async unlock() {
    this.ensureContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  async load(arrayBuffer) {
    this.ensureContext();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
    return this.buffer;
  }

  get duration() { return this.buffer ? this.buffer.duration : 0; }

  setVolume(v) {
    this.volume = v;
    if (this.gain) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  play(from = this.offset) {
    if (!this.buffer) throw new Error('音声が読み込まれていません');
    this._stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    // 少し先の時刻に予約して、開始時刻を正確に確定させる
    const when = this.ctx.currentTime + 0.03;
    src.start(when, Math.max(0, Math.min(from, this.buffer.duration)));
    this.source = src;
    this.offset = from;
    this.startCtxTime = when;
    this.state = 'playing';
    src.onended = () => {
      if (this.source === src && this.state === 'playing') {
        this.offset = this.buffer.duration;
        this.state = 'ended';
        this.onended?.();
      }
    };
  }

  pause() {
    if (this.state !== 'playing') return;
    // 音声は「予約済みの再生位置 now()」で止め、再開もそこから続ける（音の欠け・重複なし）。
    // 一方、画面と判定が使う「聞こえている位置」は出力遅延の分だけ手前なので、それを別に保持する。
    // （以前は停止中に now() を返していたため、停止した瞬間に表示が遅延分だけ先へ進んでいた）
    const audible = this.songTimeAtPerf(performance.now());
    this.offset = this.now();
    this.pausedAudible = Math.max(0, Math.min(audible, this.offset));
    this.state = 'paused';
    this._stopSource();
  }

  resume() {
    if (this.state === 'paused') this.play(this.offset);
  }

  restart() {
    this._stopSource();
    this.offset = 0;
    this.pausedAudible = 0;
    this.state = 'idle';
  }

  _stopSource() {
    if (this.source) {
      const s = this.source;
      this.source = null;
      try { s.onended = null; s.stop(); } catch { /* already stopped */ }
      s.disconnect();
    }
  }

  /** 現在の曲内再生位置（秒）。再生開始予約前は負にならないよう offset を返す。 */
  now() {
    if (this.state !== 'playing') return this.offset;
    const t = this.offset + (this.ctx.currentTime - this.startCtxTime);
    return Math.max(this.offset, Math.min(t, this.buffer.duration));
  }

  /**
   * performance.now() 基準のイベント時刻を曲内時刻に変換する。
   * 入力イベントの event.timeStamp を使い、描画フレームの遅れを判定に混ぜない。
   */
  songTimeAtPerf(perfMs) {
    if (this.state === 'paused') return this.pausedAudible ?? this.offset;
    if (this.state !== 'playing') return this.offset;
    let ctxTime;
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime > 0) {
      ctxTime = ts.contextTime + (perfMs - ts.performanceTime) / 1000;
    } else {
      ctxTime = this.ctx.currentTime - (performance.now() - perfMs) / 1000;
    }
    return this.offset + (ctxTime - this.startCtxTime);
  }

  /** 画面・判定・VFX が共通に使う「聞こえている」曲時刻（停止中は停止した位置で固定） */
  position() { return this.songTimeAtPerf(performance.now()); }

  /** 出力遅延（スピーカーへ届くまで）。判定補正に使う。 */
  get outputLatency() {
    if (!this.ctx) return 0;
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
  }
}
