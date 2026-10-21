// 成功時の効果音（Web Audio で合成。音声ファイル不要）。再生時計と同じ AudioContext・効果音の系統（音量・ミュート）で鳴らす。
// 1 つの音を複数の層（空気・衝撃・中低域の厚み・低音）で作り、立ち上がり・余韻・音量を技ごとに変える。
// - A 打撃: 空気を切る音 → 鋭い衝撃（高域の破裂）＋中域の厚み＋歪ませた低音（スマホのスピーカーでも倍音で重さが分かる）
//           蹴りは突きより低く・長く・重い。連続打撃では前の音の余韻を素早く切る（濁らない）
// - X 構え: 道着が張る乾いた音を 2 回＋短い低音と床の音
// - B 旋回: 左右に流れる風切り音（回る向き）、回り終わりに締めの音
// - Y 呼吸: 長押し中は息の音と低く控えめな響きが進み具合で滑らかに変わり、完了で短く収束する
// PERFECT は明瞭（上の層を足す）、GOOD は控えめ。BGM は打撃の瞬間だけ少し下げ（歌と効果音の両方が聞こえる）、すぐ戻す。
// play() は音の最も強い瞬間（AudioContext の時刻）を返す。画面の演出はこの時刻に合わせる。

const LEAD = 0.004; // 予約の余裕（秒）
/** 効果音の系統に入れるときの倍率（ゲームと録音ツールで共通）。打撃がリミッターにかからない大きさ（PERFECT と GOOD の差が残る） */
export const SFX_MIX_GAIN = 0.5;
// 音の最も強い瞬間（短い窓の音量の最大）は衝撃の開始より少し後（低音の層が育つまで）。録音で測った値（tools/sfx/analyse.py）
const PEAK_AFTER_IMPACT = { punch: 0.0075, kick: 0.008, stance: 0.013, turn: 0.004, breath: 0 };

export class Sfx {
  constructor(clock) {
    this.clock = clock;
    this.volume = 0.6;
    this.enabled = true;
    this.breathNode = null;
    this._noise = null;
    this._noiseCtx = null;
    this._curves = new Map();
    this._choke = []; // 打撃の余韻（新しい打撃で切る）
    this._seq = 0;    // ノイズの読み出し位置（毎回同じ音色・同じ大きさになるよう決まった順で）
  }

  get ctx() { return this.clock.ctx && this.clock.ctx.state === 'running' ? this.clock.ctx : null; }

  // ---------- 部品 ----------
  _noiseBuf(c) {
    if (this._noise && this._noiseCtx === c) return this._noise;
    const n = c.sampleRate * 2, b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this._noiseCtx = c;
    return (this._noise = b);
  }

  _curve(drive) {
    if (!this._curves.has(drive)) {
      const n = 1024, k = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; k[i] = Math.tanh(drive * x) / Math.tanh(drive); }
      this._curves.set(drive, k);
    }
    return this._curves.get(drive);
  }

  /** 1 つの音の出口（効果音の系統へ） */
  _out(c, level, pan = null) {
    const g = c.createGain();
    g.gain.value = level * this.volume;
    let head = g;
    if (pan != null && c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = 0; g.connect(p); head = p; this._lastPan = p; }
    head.connect(this.clock.sfxBus || c.destination);
    return g;
  }

  /** 音量の包絡: at から attack 秒で peak、そこから decay 秒で消える（指数） */
  _env(param, at, peak, attack, decay) {
    // 作った直後から無音にしておく（GainNode の初期値は 1。音源を早めに鳴らし始める層で、包絡の前に音が漏れないように）
    param.value = 0.0001;
    param.setValueAtTime(0.0001, 0);
    param.setValueAtTime(0.0001, Math.max(0, at - 0.0005));
    param.linearRampToValueAtTime(peak, at + attack);
    param.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  }

  /** ノイズの層。filters: [{type, f0, f1?, f2?, q}]（f1 は at+attack、f2 は終わり） */
  _noiseLayer(c, out, { at, attack, decay, peak, filters, from = at - 0.03 }) {
    const src = c.createBufferSource();
    src.buffer = this._noiseBuf(c);
    let node = src;
    for (const f of filters) {
      const bq = c.createBiquadFilter();
      bq.type = f.type; bq.Q.value = f.q ?? 0.7;
      bq.frequency.setValueAtTime(f.f0, Math.max(0, from));
      if (f.f1) bq.frequency.exponentialRampToValueAtTime(f.f1, at + attack);
      if (f.f2) bq.frequency.exponentialRampToValueAtTime(f.f2, at + attack + decay);
      node.connect(bq); node = bq;
    }
    const g = c.createGain();
    this._env(g.gain, at, peak, attack, decay);
    node.connect(g).connect(out);
    const start = Math.max(c.currentTime, from);
    src.start(start, ((this._seq++ % 7) * 0.211) % 1.5, at + attack + decay - start + 0.03);
    return g;
  }

  /** 低音の層: 音程が下がるサイン波を歪ませて倍音を足す（小さなスピーカーでも聞こえる） */
  _thump(c, out, { at, f0, f1, glide, peak, attack = 0.002, decay, drive = 3, lp = 1400 }) {
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, at);
    o.frequency.exponentialRampToValueAtTime(f1, at + glide);
    const ws = c.createWaveShaper(); ws.curve = this._curve(drive); ws.oversample = '2x';
    const pre = c.createGain();
    this._env(pre.gain, at, 1, attack, decay);
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; f.Q.value = 0.5;
    const g = c.createGain(); g.gain.value = peak;
    o.connect(pre).connect(ws).connect(f).connect(g).connect(out);
    o.start(Math.max(c.currentTime, at - 0.001)); o.stop(at + attack + decay + 0.03);
    return g;
  }

  /** BGM を少し下げてすぐ戻す（効果音と歌の両方が聞こえる） */
  _duck(c, at, db, hold) {
    const node = this.clock.bgmDuck;
    if (!node) return;
    const g = node.gain, low = 10 ** (-db / 20);
    g.cancelScheduledValues(at - 0.003);
    g.setTargetAtTime(low, at - 0.003, 0.004);
    g.setTargetAtTime(1, at + hold, 0.07);
  }

  /** 連続打撃: 前の打撃の余韻を新しい打撃の直前に素早く消す */
  _chokeAt(at) {
    for (const g of this._choke) {
      try { g.gain.cancelScheduledValues(at - 0.012); g.gain.setTargetAtTime(0.0001, at - 0.012, 0.006); } catch { /* 終了済み */ }
    }
    this._choke = [];
  }

  // ---------- 成功音 ----------
  /**
   * 成功音。kind: strike|kick|stance|turn|breath、grade: PERFECT|GOOD、o.pan: 旋回の向き（-1 左へ … 1 右へ）
   * @returns 音の最も強い瞬間の AudioContext 時刻（鳴らせないときは null）
   */
  play(kind, grade = 'PERFECT', o = {}) {
    const c = this.ctx;
    if (!this.enabled || !c) return null;
    const w = c.currentTime + LEAD;
    const P = grade === 'PERFECT', k = P ? 1 : 0.68;
    this._seq = 0; // 同じ技は毎回同じ音色（GOOD は同じ音を控えめに）
    if (kind === 'strike' || kind === 'punch') return this._punch(c, w, k, P);
    if (kind === 'kick') return this._kick(c, w, k, P);
    if (kind === 'stance') return this._stance(c, w, k, P);
    if (kind === 'turn') return this._turn(c, w, k, P, o.pan ?? 1);
    if (kind === 'breath') return this._breathEnd(c, w, k, P);
    return null;
  }

  _punch(c, w, k, P) {
    const I = w + 0.010; // 衝撃の瞬間（その前の 10 ms が空気を切る音の立ち上がり）
    this._chokeAt(I);
    const out = this._out(c, 1);
    const layers = [
      // 空気を切る音（衝撃の直前に最大、すぐ抜ける）
      this._noiseLayer(c, out, { at: I - 0.008, attack: 0.008, decay: 0.06, peak: 0.30 * k, from: w,
        filters: [{ type: 'bandpass', f0: 1300, f1: 3400, f2: 1600, q: 1.3 }] }),
      // 衝撃（高域の破裂。キレ）
      this._noiseLayer(c, out, { at: I, attack: 0.0006, decay: 0.032, peak: 1.5 * k, filters: [{ type: 'highpass', f0: 1900, q: 0.6 }] }),
      // 中域の厚み（スマホでも「当たった」重さ）
      this._noiseLayer(c, out, { at: I + 0.001, attack: 0.0015, decay: 0.075, peak: 1.4 * k, filters: [{ type: 'bandpass', f0: 650, q: 1.0 }] }),
      // 低音（歪ませて倍音を足す）
      this._thump(c, out, { at: I + 0.001, f0: 170, f1: 62, glide: 0.07, peak: 0.42 * k, decay: P ? 0.12 : 0.09, drive: 3 }),
    ];
    if (P) layers.push(this._noiseLayer(c, out, { at: I + 0.021, attack: 0.0008, decay: 0.018, peak: 0.32, filters: [{ type: 'bandpass', f0: 3900, q: 4 }] })); // 道着の張り
    this._choke.push(...layers);
    this._duck(c, I, 4, 0.06);
    return I + PEAK_AFTER_IMPACT.punch;
  }

  _kick(c, w, k, P) {
    const I = w + 0.022; // 蹴りは振りが長い（空気を切る音を長めに）
    this._chokeAt(I);
    const out = this._out(c, 1.25);
    const layers = [
      this._noiseLayer(c, out, { at: I - 0.02, attack: 0.02, decay: 0.12, peak: 0.34 * k, from: w,
        filters: [{ type: 'bandpass', f0: 650, f1: 2300, f2: 850, q: 1.1 }] }),
      this._noiseLayer(c, out, { at: I, attack: 0.0008, decay: 0.045, peak: 1.2 * k, filters: [{ type: 'highpass', f0: 1300, q: 0.6 }] }),
      this._noiseLayer(c, out, { at: I + 0.001, attack: 0.002, decay: 0.12, peak: 1.6 * k, filters: [{ type: 'bandpass', f0: 420, q: 0.9 }] }),
      this._thump(c, out, { at: I + 0.002, f0: 125, f1: 42, glide: 0.12, peak: 0.55 * k, decay: P ? 0.22 : 0.15, drive: 3.5, lp: 1000 }),
    ];
    if (P) layers.push(this._noiseLayer(c, out, { at: I + 0.03, attack: 0.001, decay: 0.022, peak: 0.3, filters: [{ type: 'bandpass', f0: 3300, q: 3.5 }] }));
    this._choke.push(...layers);
    this._duck(c, I, 5, 0.09);
    return I + PEAK_AFTER_IMPACT.kick;
  }

  _stance(c, w, k, P) {
    const I = w + 0.002;
    const out = this._out(c, 1.8);
    // 道着が張る乾いた音（2 回目は少し遅れて小さく）
    this._noiseLayer(c, out, { at: I, attack: 0.0005, decay: 0.022, peak: 1.6 * k, filters: [{ type: 'highpass', f0: 1200 }, { type: 'bandpass', f0: 2600, q: 2.2 }] });
    if (P) this._noiseLayer(c, out, { at: I + 0.026, attack: 0.0005, decay: 0.018, peak: 0.9, filters: [{ type: 'highpass', f0: 1500 }, { type: 'bandpass', f0: 3400, q: 2.4 }] });
    // 姿勢が決まる短い低音と床
    this._thump(c, out, { at: I + 0.002, f0: 130, f1: 70, glide: 0.05, peak: 0.28 * k, decay: 0.07, drive: 2.5 });
    this._noiseLayer(c, out, { at: I + 0.001, attack: 0.002, decay: 0.05, peak: 0.6 * k, filters: [{ type: 'bandpass', f0: 480, q: 1.2 }] });
    this._duck(c, I, 3, 0.05);
    return I + PEAK_AFTER_IMPACT.stance;
  }

  _turn(c, w, k, P, dir) {
    const C = w + 0.085, end = w + 0.22, d = dir < 0 ? -1 : 1;
    const out = this._out(c, 1.9, true);
    const pan = this._lastPan;
    if (pan) { pan.pan.setValueAtTime(-0.75 * d, w); pan.pan.linearRampToValueAtTime(0.75 * d, end); }
    // 体が回る風切り（中心の周波数が上がって下がる）＋空気の擦れ
    this._noiseLayer(c, out, { at: C - 0.08, attack: 0.08, decay: 0.15, peak: 1.5 * k, from: w,
      filters: [{ type: 'bandpass', f0: 380, f1: 1500, f2: 600, q: 1.8 }] });
    this._noiseLayer(c, out, { at: C - 0.06, attack: 0.06, decay: 0.12, peak: 0.22 * k, from: w, filters: [{ type: 'highpass', f0: 2600, q: 0.7 }] });
    // 回り終わりの締め
    const out2 = this._out(c, 1.9);
    this._noiseLayer(c, out2, { at: end, attack: 0.0006, decay: 0.02, peak: 0.09 * k, filters: [{ type: 'highpass', f0: 1400 }, { type: 'bandpass', f0: 3000, q: 2.5 }] });
    if (P) this._thump(c, out2, { at: end + 0.002, f0: 100, f1: 60, glide: 0.04, peak: 0.16, decay: 0.06, drive: 2 });
    this._duck(c, C, 3, 0.15);
    return C + PEAK_AFTER_IMPACT.turn;
  }

  /** 呼吸の完了: 低い響きが短く収束し、息を吐き切る */
  _breathEnd(c, w, k, P) {
    const C = w + 0.03;
    const out = this._out(c, 2.2);
    this._thump(c, out, { at: C - 0.025, attack: 0.025, f0: 98, f1: 62, glide: 0.25, peak: 0.1 * k, decay: P ? 0.3 : 0.2, drive: 1.6, lp: 700 });
    this._noiseLayer(c, out, { at: C - 0.01, attack: 0.012, decay: 0.2, peak: 0.45 * k, filters: [{ type: 'bandpass', f0: 950, f2: 420, q: 0.9 }] });
    this._duck(c, C, 2, 0.15);
    return C;
  }

  /** MISS: 短く鈍い音（電子音にしない） */
  miss() {
    const c = this.ctx;
    if (!this.enabled || !c) return;
    const at = c.currentTime + LEAD, out = this._out(c, 1);
    this._noiseLayer(c, out, { at, attack: 0.002, decay: 0.05, peak: 0.2, filters: [{ type: 'lowpass', f0: 240, q: 0.7 }] });
    this._thump(c, out, { at, f0: 85, f1: 70, glide: 0.04, peak: 0.12, decay: 0.05, drive: 1.2, lp: 400 });
  }

  // ---------- 呼吸（長押し） ----------
  /** 長押しの開始: 息の音（帯域ノイズ・ゆっくり揺れる）＋空気の擦れ＋低く控えめな響き。breathUpdate で進み具合を反映 */
  breathStart() {
    const c = this.ctx;
    if (!this.enabled || !c || this.breathNode) return;
    const t = c.currentTime + LEAD;
    const out = this._out(c, 1.6);
    const src = c.createBufferSource(); src.buffer = this._noiseBuf(c); src.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.8; bp.frequency.value = 520;
    const air = c.createGain(); air.gain.setValueAtTime(0.0001, t); air.gain.linearRampToValueAtTime(0.05, t + 0.5);
    const lfo = c.createOscillator(); lfo.frequency.value = 0.22; const lfoG = c.createGain(); lfoG.gain.value = 0.012;
    lfo.connect(lfoG).connect(air.gain);
    src.connect(bp).connect(air).connect(out);
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
    const hiss = c.createGain(); hiss.gain.setValueAtTime(0.0001, t); hiss.gain.linearRampToValueAtTime(0.008, t + 0.6);
    src.connect(hp).connect(hiss).connect(out);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
    const drone = c.createGain(); drone.gain.setValueAtTime(0.0001, t); drone.gain.linearRampToValueAtTime(0.02, t + 0.8);
    const oscs = [73.4, 110, 146.8].map((f, i) => {
      const o = c.createOscillator(); o.type = i === 2 ? 'triangle' : 'sine'; o.frequency.value = f;
      const g = c.createGain(); g.gain.value = [1, 0.6, 0.2][i];
      o.connect(g).connect(lp); o.start(t); return o;
    });
    lp.connect(drone).connect(out);
    src.start(t, Math.random()); lfo.start(t);
    this.breathNode = { src, lfo, oscs, bp, air, hiss, drone, out };
  }

  /** 長押しの進み具合（0〜1）: 息が明るく・少し大きく、響きが厚くなる（滑らかに） */
  breathUpdate(progress) {
    const b = this.breathNode, c = this.ctx;
    if (!b || !c) return;
    const p = Math.max(0, Math.min(1, progress)), t = c.currentTime;
    if (Math.abs(p - (b.p ?? -1)) < 0.02) return;
    b.p = p;
    b.bp.frequency.setTargetAtTime(520 + 650 * p, t, 0.15);
    b.air.gain.setTargetAtTime(0.05 + 0.025 * p, t, 0.15);
    b.drone.gain.setTargetAtTime(0.02 + 0.03 * p, t, 0.2);
    b.hiss.gain.setTargetAtTime(0.008 + 0.01 * p, t, 0.2);
  }

  /** 長押しの終わり（離す・完了・一時停止・シーク・リトライ）: すぐ消して音源を止める（鳴り続けない） */
  breathStop() {
    const b = this.breathNode;
    if (!b) return;
    this.breathNode = null;
    const c = this.ctx || this.clock.ctx;
    try {
      const t = c.currentTime;
      for (const g of [b.air, b.hiss, b.drone]) { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0.0001, t, 0.035); }
      const stop = t + 0.25;
      b.src.stop(stop); b.lfo.stop(stop); for (const o of b.oscs) o.stop(stop);
      setTimeout(() => { try { b.out.disconnect(); } catch { /* 済み */ } }, 400);
    } catch { /* AudioContext が閉じている */ }
  }

  get breathActive() { return !!this.breathNode; }
}
