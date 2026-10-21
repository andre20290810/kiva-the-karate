// 成功時の効果音（Web Audio で合成。音声ファイル不要）。再生時計と同じ AudioContext・効果音の系統（音量・ミュート）で鳴らす。
// コマンドごとの音（2026-10-21 の仕様）:
// - Y 呼吸「息」: 炎が燃え盛る音。長押し中は炎のうなり＋はぜる音が進み具合で大きく明るくなり、完了で炎が一気に燃え上がる。
//                 離す・一時停止・シーク・リトライで必ず止める（ループ音源を止めるのでタイマーに頼らない）
// - X 構え「構」: 鋭く響く金属音（打った瞬間の硬い音＋非整数倍の倍音が響いて消える）
// - A 打撃・蹴り「撃」: 銃撃音のような短く強い破裂音（破裂＋胴鳴り＋歪ませた低音＋短い残響）。蹴りは少し重く長い
// - B 旋回「旋」: 空気を切り裂く鋭い風切り音（回る向きに左右へ流れる）
// PERFECT は明瞭、GOOD は同じ音を約 3 dB 控えめに。連続打撃では前の音の余韻を切る（濁らない）。打撃などの瞬間だけ BGM を少し下げる。
// 効果音の音量の初期値は 0（設定で上げる）。音量が 0 でも play() は最も強い瞬間（AudioContext の時刻）を返し、画面の演出はそれに合わせる。

const LEAD = 0.004; // 予約の余裕（秒）
/** 効果音の系統に入れるときの倍率（ゲームと録音ツールで共通）。打撃がリミッターにかからない大きさ（PERFECT と GOOD の差が残る） */
export const SFX_MIX_GAIN = 0.5;
// 音の最も強い瞬間（短い窓の音量の最大）までの補正。録音で測った値（tools/sfx/analyse.py）
const PEAK_AFTER_IMPACT = { shot: 0.0075, kick: 0.0075, metal: 0.0076, turn: 0.005, breath: 0.007 };

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
    this._fire = null; // 炎の音の素材（うなり・はぜる音。AudioContext ごとに 1 回作る）
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

  /** 炎の素材: うなり（ゆらぐ低いノイズ）とはぜる音（まばらな短い破裂）。4 秒をループ */
  _fireBufs(c) {
    if (this._fire && this._fire.ctx === c) return this._fire;
    const sr = c.sampleRate, n = sr * 4;
    let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const roar = c.createBuffer(1, n, sr), r = roar.getChannelData(0);
    let b = 0, flick = 0;
    for (let i = 0; i < n; i++) {
      b = 0.985 * b + 0.15 * (rnd() * 2 - 1);                // 低いうなり
      if (i % 480 === 0) flick = 0.6 + 0.4 * rnd();           // 10 ms ごとのゆらぎ
      const env = 0.8 + 0.2 * Math.sin((i / sr) * 2 * Math.PI * 1.5);
      r[i] = b * flick * env * 0.5;
    }
    const crk = c.createBuffer(1, n, sr), k = crk.getChannelData(0);
    let t = 0;
    while (t < n) {
      t += Math.floor(sr * (0.012 + 0.07 * rnd()));          // 毎秒 20 回ほど はぜる
      const len = Math.floor(sr * (0.0015 + 0.005 * rnd())), amp = 0.25 + 0.75 * rnd() ** 2;
      for (let j = 0; j < len && t + j < n; j++) k[t + j] += (rnd() * 2 - 1) * amp * Math.exp(-j / (len * 0.3));
    }
    const fade = Math.floor(sr * 0.02); // ループのつなぎ目
    for (const d of [r, k]) for (let i = 0; i < fade; i++) { const g = i / fade; d[i] *= g; d[n - 1 - i] *= g; }
    return (this._fire = { ctx: c, roar, crk });
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
    if (kind === 'strike' || kind === 'punch') return this._shot(c, w, k, P, false);
    if (kind === 'kick') return this._shot(c, w, k, P, true);
    if (kind === 'stance') return this._metal(c, w, k, P);
    if (kind === 'turn') return this._turn(c, w, k, P, o.pan ?? 1);
    if (kind === 'breath') return this._fireBurst(c, w, k, P);
    return null;
  }

  /** 撃: 銃撃音のような短く強い破裂音 */
  _shot(c, w, k, P, heavy) {
    const I = w + 0.002;
    this._chokeAt(I);
    const out = this._out(c, heavy ? 0.48 : 0.55);
    const layers = [
      // 破裂（広い帯域の鋭い立ち上がり）
      this._noiseLayer(c, out, { at: I, attack: 0.0003, decay: heavy ? 0.03 : 0.022, peak: 3.0 * k, filters: [{ type: 'highpass', f0: 900, q: 0.5 }] }),
      // 胴鳴り（中域）
      this._noiseLayer(c, out, { at: I + 0.0005, attack: 0.001, decay: heavy ? 0.1 : 0.07, peak: 1.1 * k, filters: [{ type: 'lowpass', f0: 2200, q: 0.6 }, { type: 'highpass', f0: 180 }] }),
      // 低音（歪ませて倍音を足す。スマホでも重さが分かる）
      this._thump(c, out, { at: I + 0.001, f0: heavy ? 95 : 120, f1: heavy ? 38 : 45, glide: 0.09, peak: (heavy ? 0.45 : 0.32) * k, decay: heavy ? 0.2 : 0.14, drive: 4.5, lp: 1800 }),
      // 短い残響（屋内で鳴った感じ）
      this._noiseLayer(c, out, { at: I + 0.008, attack: 0.004, decay: P ? 0.32 : 0.2, peak: 0.16 * k, filters: [{ type: 'bandpass', f0: 1100, f2: 500, q: 0.5 }] }),
    ];
    if (P) layers.push(this._noiseLayer(c, out, { at: I + 0.055, attack: 0.0005, decay: 0.03, peak: 0.22, filters: [{ type: 'bandpass', f0: 1800, q: 0.8 }] })); // 跳ね返り
    this._choke.push(...layers);
    this._duck(c, I, heavy ? 5 : 4, 0.08);
    return I + PEAK_AFTER_IMPACT[heavy ? 'kick' : 'shot'];
  }

  /** 構: 鋭く響く金属音 */
  _metal(c, w, k, P) {
    const I = w + 0.002;
    for (const g of this._metalVoices || []) { try { g.gain.cancelScheduledValues(I - 0.01); g.gain.setTargetAtTime(0.0001, I - 0.01, 0.01); } catch { /* 済み */ } }
    const out = this._out(c, 0.85);
    this._metalVoices = [out];
    // 打った瞬間の硬い音
    this._noiseLayer(c, out, { at: I, attack: 0.0003, decay: 0.012, peak: 0.9 * k, filters: [{ type: 'highpass', f0: 2500, q: 0.7 }] });
    // 響き: 非整数倍の倍音（高いほど早く消える）。わずかにずらした 2 本でうなりを付ける
    const f0 = 1180;
    const parts = [[1, 0.5, 0.9], [1.004, 0.28, 0.9], [2.32, 0.35, 0.55], [3.17, 0.22, 0.4], [4.53, 0.16, 0.28], [6.06, 0.1, 0.18]];
    for (const [ratio, amp, dec] of parts) {
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f0 * ratio;
      const g = c.createGain();
      this._env(g.gain, I, amp * k, 0.001, (P ? dec : dec * 0.7));
      o.connect(g).connect(out);
      o.start(I - 0.001); o.stop(I + dec + 0.05);
    }
    this._duck(c, I, 3, 0.12);
    return I + PEAK_AFTER_IMPACT.metal;
  }

  /** 旋: 空気を切り裂く鋭い風切り音（回る向きに流れる） */
  _turn(c, w, k, P, dir) {
    const C = w + 0.07, end = w + 0.18, d = dir < 0 ? -1 : 1;
    const out = this._out(c, 1.9, true);
    const pan = this._lastPan;
    if (pan) { pan.pan.setValueAtTime(-0.8 * d, w); pan.pan.linearRampToValueAtTime(0.8 * d, end); }
    this._noiseLayer(c, out, { at: C - 0.065, attack: 0.065, decay: 0.11, peak: 1.6 * k, from: w,
      filters: [{ type: 'bandpass', f0: 700, f1: 3800, f2: 1200, q: 3 }] });
    this._noiseLayer(c, out, { at: C - 0.03, attack: 0.03, decay: 0.09, peak: 0.35 * k, from: w, filters: [{ type: 'highpass', f0: 4500, q: 0.7 }] });
    this._noiseLayer(c, out, { at: C - 0.05, attack: 0.05, decay: 0.08, peak: 0.5 * k, from: w, filters: [{ type: 'bandpass', f0: 350, f1: 900, f2: 400, q: 1.2 }] });
    this._duck(c, C, 3, 0.12);
    return C + PEAK_AFTER_IMPACT.turn;
  }

  /** 息（完了）: 炎が一気に燃え上がって収まる */
  _fireBurst(c, w, k, P) {
    const C = w + 0.04;
    const F = this._fireBufs(c);
    const out = this._out(c, 1.6);
    for (const [buf, filt, peak, dec] of [[F.roar, { type: 'lowpass', f: 1800 }, 1.6, P ? 0.55 : 0.4], [F.crk, { type: 'bandpass', f: 2600 }, 0.9, P ? 0.5 : 0.35]]) {
      const src = c.createBufferSource(); src.buffer = buf;
      const f = c.createBiquadFilter(); f.type = filt.type; f.frequency.value = filt.f; f.Q.value = 0.7;
      const g = c.createGain();
      this._env(g.gain, C - 0.035, peak * k, 0.035, dec);
      src.connect(f).connect(g).connect(out);
      src.start(w, 1.3, dec + 0.1);
    }
    // 燃え上がる「ごう」という音（帯域が上がる）
    this._noiseLayer(c, out, { at: C - 0.03, attack: 0.03, decay: 0.3, peak: 0.6 * k, filters: [{ type: 'bandpass', f0: 250, f1: 900, f2: 300, q: 0.9 }] });
    this._duck(c, C, 3, 0.2);
    return C + PEAK_AFTER_IMPACT.breath;
  }

  /** MISS: 短く鈍い音（電子音にしない） */
  miss() {
    const c = this.ctx;
    if (!this.enabled || !c) return;
    const at = c.currentTime + LEAD, out = this._out(c, 1);
    this._noiseLayer(c, out, { at, attack: 0.002, decay: 0.05, peak: 0.2, filters: [{ type: 'lowpass', f0: 240, q: 0.7 }] });
  }

  // ---------- 呼吸（長押し）: 炎が燃え盛る音 ----------
  breathStart() {
    const c = this.ctx;
    if (!this.enabled || !c || this.breathNode) return;
    const t = c.currentTime + LEAD;
    const F = this._fireBufs(c);
    const out = this._out(c, 1.6);
    const roar = c.createBufferSource(); roar.buffer = F.roar; roar.loop = true;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 0.6;
    const gR = c.createGain(); gR.gain.value = 0.0001; gR.gain.setValueAtTime(0.0001, t); gR.gain.linearRampToValueAtTime(0.22, t + 0.35);
    roar.connect(lp).connect(gR).connect(out);
    const crk = c.createBufferSource(); crk.buffer = F.crk; crk.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 0.8;
    const gC = c.createGain(); gC.gain.value = 0.0001; gC.gain.setValueAtTime(0.0001, t); gC.gain.linearRampToValueAtTime(0.09, t + 0.4);
    crk.connect(bp).connect(gC).connect(out);
    roar.start(t, 0.2); crk.start(t, 0.7);
    this.breathNode = { srcs: [roar, crk], lp, gR, gC, out };
  }

  /** 長押しの進み具合（0〜1）: 炎が大きく明るく、はぜる音が増える（滑らかに） */
  breathUpdate(progress) {
    const b = this.breathNode, c = this.ctx;
    if (!b || !c) return;
    const p = Math.max(0, Math.min(1, progress)), t = c.currentTime;
    if (Math.abs(p - (b.p ?? -1)) < 0.02) return;
    b.p = p;
    b.lp.frequency.setTargetAtTime(700 + 1100 * p, t, 0.15);
    b.gR.gain.setTargetAtTime(0.22 + 0.2 * p, t, 0.15);
    b.gC.gain.setTargetAtTime(0.09 + 0.16 * p, t, 0.15);
  }

  /** 長押しの終わり（離す・完了・一時停止・シーク・リトライ）: すぐ消して音源を止める（鳴り続けない） */
  breathStop() {
    const b = this.breathNode;
    if (!b) return;
    this.breathNode = null;
    const c = this.ctx || this.clock.ctx;
    try {
      const t = c.currentTime;
      for (const g of [b.gR, b.gC]) { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0.0001, t, 0.03); }
      for (const s of b.srcs) s.stop(t + 0.2);
      setTimeout(() => { try { b.out.disconnect(); } catch { /* 済み */ } }, 350);
    } catch { /* AudioContext が閉じている */ }
  }

  get breathActive() { return !!this.breathNode; }
}
