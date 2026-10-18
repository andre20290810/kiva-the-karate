// 成功エフェクト（Canvas 2D）。人物のアルファ（切り抜きの形）を使って、光・残像・歪みを人物に結び付ける。
// - Y 呼吸: 胴体の周りに立ち上る細かな光と、輪郭の空気の揺らぎ（長押しの進み具合で増える）
// - X 構え: 輪郭に沿う光（リムライト）、体の上を走る光、胸元の閃光
// - A 打撃: 拳・足の位置から攻撃方向へ伸びるエネルギー、直前のコマの残像、打撃点の局所的な歪み、火花
// - B 旋回: 直前の数コマのシルエットの残像、体を巻く空気のノイズ（体の前後に回り込む）
// 時刻は時間軸の秒（一時停止で止まり、シーク・リトライで clear() される）。粒子は年齢から計算するので溜まらない。

const TAU = Math.PI * 2;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const easeOut = (x) => 1 - (1 - x) ** 3;

function canvas(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(Math.max(1, w | 0), Math.max(1, h | 0)) : Object.assign(document.createElement('canvas'), { width: Math.max(1, w | 0), height: Math.max(1, h | 0) });
  return c;
}

// ---------- 手続き的に作るテクスチャ（起動時に 1 回） ----------
function valueNoise(size, cells, seed) {
  const g = (x, y) => hash(((x % cells) + cells) % cells * 57 + (((y % cells) + cells) % cells) * 131 + seed * 977);
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = (x / size) * cells, fy = (y / size) * cells;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const sx = (fx - x0) ** 2 * (3 - 2 * (fx - x0)), sy = (fy - y0) ** 2 * (3 - 2 * (fy - y0));
    const a = g(x0, y0), b = g(x0 + 1, y0), c = g(x0, y0 + 1), d = g(x0 + 1, y0 + 1);
    out[y * size + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  return out;
}

function noiseTexture(size = 256) {
  const n1 = valueNoise(size, 8, 1), n2 = valueNoise(size, 16, 2), n3 = valueNoise(size, 32, 3);
  const c = canvas(size, size), g = c.getContext('2d'), im = g.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = n1[i] * 0.55 + n2[i] * 0.3 + n3[i] * 0.15;
    const a = clamp01((v - 0.42) * 3.2) ** 1.6;
    im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = 255;
    im.data[i * 4 + 3] = a * 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}

/** 横向きのエネルギーの帯（左端が発生点、右へ細くなる。ノイズで筋と揺らぎ） */
function beamTexture(w = 512, h = 96) {
  const c = canvas(w, h), g = c.getContext('2d'), im = g.createImageData(w, h);
  const n = valueNoise(256, 24, 7);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / w, v = (y / h) * 2 - 1;
    const taper = (1 - u) ** 0.8 * Math.min(1, u * 14);
    const nn = n[((y * 3) % 256) * 256 + ((x * 2) % 256)];
    const width = 0.25 + 0.75 * taper * (0.6 + 0.6 * nn);
    const core = Math.exp(-((v / (width * 0.35 + 1e-3)) ** 2));
    const glow = Math.exp(-((v / (width + 1e-3)) ** 2) * 2.2) * 0.55;
    const streak = 0.7 + 0.6 * n[((y * 11) % 256) * 256 + ((x >> 1) % 256)];
    const a = clamp01((core + glow) * taper * streak);
    const i = (y * w + x) * 4;
    im.data[i] = 255; im.data[i + 1] = 255; im.data[i + 2] = 255; im.data[i + 3] = a * 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}

/** 閃光（ノイズで長さの違う放射状の光条 ＋ 芯） */
function flareTexture(size = 256) {
  const c = canvas(size, size), g = c.getContext('2d'), im = g.createImageData(size, size);
  const rays = 28, lens = Array.from({ length: rays }, (_, k) => 0.35 + 0.65 * hash(k * 3.1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x / size * 2 - 1, dy = y / size * 2 - 1, r = Math.hypot(dx, dy), th = (Math.atan2(dy, dx) / TAU + 1) % 1;
    const k = th * rays, k0 = Math.floor(k), f = k - k0;
    const len = lens[k0 % rays] * (1 - f) + lens[(k0 + 1) % rays] * f;
    const ray = Math.exp(-(((f - 0.5) * 2) ** 2) * 18) * clamp01(1 - r / len) ** 2;
    const core = Math.exp(-r * r * 30);
    const a = clamp01(core + ray * 0.8);
    const i = (y * size + x) * 4;
    im.data[i] = 255; im.data[i + 1] = 255; im.data[i + 2] = 255; im.data[i + 3] = a * 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}

function dotTexture(size = 64) {
  const c = canvas(size, size), g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  return c;
}

/** 白いテクスチャを色付けしたもの（加算合成用） */
function tinted(tex, color) {
  const c = canvas(tex.width, tex.height), g = c.getContext('2d');
  g.drawImage(tex, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

const DUR = { breath: 0.7, stance: 0.6, strike: 0.55, turn: 0.75 };

export class Effects {
  constructor() {
    this.list = [];
    this.strength = 1;
    this.low = false;
    this.noise = noiseTexture();
    const beam = beamTexture(), flare = flareTexture(), dot = dotTexture();
    this.tex = {
      beamHot: tinted(beam, '#fff6e0'), beamPunch: tinted(beam, '#ff8a2a'), beamKick: tinted(beam, '#48c8ff'),
      flareGold: tinted(flare, '#ffe2a0'), flareWhite: tinted(flare, '#ffffff'),
      dotGold: tinted(dot, '#ffcf6a'), dotCyan: tinted(dot, '#9fe8ff'), dotWhite: dot,
      noiseCyan: tinted(this.noise, '#8fdcff'), noiseWarm: tinted(this.noise, '#ffd9a0'),
    };
    this.sil = new Map(); // 色付きシルエットのキャッシュ（キー: コマ番号|色|幅）
    this.tmp = canvas(64, 64);
    this.tmp2 = canvas(64, 64);
    this.filterOk = (() => { try { const g = canvas(2, 2).getContext('2d'); g.filter = 'blur(2px)'; return g.filter === 'blur(2px)'; } catch { return false; } })();
    this.stats = { active: 0, drawn: 0 };
  }

  setQuality({ low, strength }) {
    if (low != null) this.low = !!low;
    if (strength != null) this.strength = Math.max(0, Math.min(1, strength));
  }

  clear() { this.list = []; this._trimCache(true); }

  /** 成功時に呼ぶ。kind: breath|stance|strike|turn */
  trigger(kind, o) {
    const gradeI = o.grade === 'PERFECT' ? 1 : 0.62;
    this.list.push({ kind, t0: o.t, dur: DUR[kind], gradeI: gradeI * (o.intensity ?? 1), ...o });
    if (this.list.length > 24) this.list.shift();
  }

  // ---------- シルエット ----------
  silhouette(index, bmp, w, h, color) {
    const key = `${index}|${color}|${w | 0}`;
    let c = this.sil.get(key);
    if (!c) {
      c = canvas(w, h);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0, c.width, c.height);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = color;
      g.fillRect(0, 0, c.width, c.height);
      this.sil.set(key, c);
      this._trimCache();
    }
    return c;
  }

  /** 輪郭だけ（4 方向にずらしたシルエットで削る） */
  rim(index, bmp, w, h, color, d = 2.5) {
    const key = `rim|${index}|${color}|${w | 0}`;
    let c = this.sil.get(key);
    if (!c) {
      const s = this.silhouette(index, bmp, w, h, color);
      c = canvas(w + 8, h + 8);
      const g = c.getContext('2d');
      const t = canvas(w + 8, h + 8), tg = t.getContext('2d');
      for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
        tg.globalCompositeOperation = 'source-over';
        tg.clearRect(0, 0, t.width, t.height);
        tg.drawImage(s, 4, 4);
        tg.globalCompositeOperation = 'destination-out';
        tg.drawImage(s, 4 + dx, 4 + dy);
        g.globalCompositeOperation = 'lighter';
        g.drawImage(t, 0, 0);
      }
      this.sil.set(key, c);
      this._trimCache();
    }
    return c;
  }

  _trimCache(all = false) {
    const max = all ? 0 : 24;
    while (this.sil.size > max) this.sil.delete(this.sil.keys().next().value);
  }

  // ---------- 描画 ----------
  /**
   * 人物を描く前（後ろに回る残像・旋回の奥側）
   * @param ctx 画面の 2D コンテキスト（CSS px 座標）
   * @param S  {t, store, frameIndex, transformFor(i), standH}
   */
  renderUnder(ctx, S) {
    this._expire(S.t);
    for (const e of this.list) {
      const p = (S.t - e.t0) / e.dur;
      if (p < 0) continue;
      if (e.kind === 'turn') this._turnTrail(ctx, S, e, p), this._swirl(ctx, S, e, p, 'back');
      if (e.kind === 'strike') this._afterimage(ctx, S, e, p);
    }
  }

  /** 人物を描いた後（光・歪み・粒子） */
  renderOver(ctx, S) {
    let drawn = 0;
    for (const e of this.list) {
      const p = (S.t - e.t0) / e.dur;
      if (p < 0) continue;
      drawn++;
      if (e.kind === 'stance') this._stance(ctx, S, e, p);
      else if (e.kind === 'strike') this._strike(ctx, S, e, p);
      else if (e.kind === 'turn') this._swirl(ctx, S, e, p, 'front');
      else if (e.kind === 'breath') this._breath(ctx, S, e.anchorFrame ?? S.frameIndex, 1, 1 - p, e.gradeI);
    }
    this.stats = { active: this.list.length, drawn, cache: this.sil.size };
  }

  /** 長押し中の呼吸（progress 0〜1）。判定前から控えめに出し、進み具合で増やす */
  renderHold(ctx, S, progress) {
    this._breath(ctx, S, S.frameIndex, progress, 1, 1);
  }

  _expire(t) {
    // 時刻が戻った（シーク）・寿命切れのものを捨てる
    this.list = this.list.filter((e) => t >= e.t0 - 0.05 && t <= e.t0 + e.dur);
  }

  _cur(S) {
    const g = S.store.get(S.frameIndex);
    if (!g) return null;
    const T = S.transformFor(g.index);
    const r = T.crop();
    return { bmp: g.bmp, index: g.index, T, r };
  }

  _breath(ctx, S, _fi, progress, fade, gradeI) {
    const cur = this._cur(S);
    if (!cur) return;
    const k = this.strength * fade * gradeI;
    if (k <= 0.01) return;
    const { T, r } = cur;
    const cx = T.ox, cy = T.oy, H = S.standH;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // 輪郭の空気の揺らぎ: 淡いシルエットを横帯ごとに波打たせる
    const sil = this.silhouette(cur.index, cur.bmp, r.w, r.h, '#bfefff');
    const bands = this.low ? 6 : 14, bh = r.h / bands;
    ctx.globalAlpha = (0.12 + 0.2 * progress) * k;
    if (this.filterOk && !this.low) ctx.filter = 'blur(3px)';
    for (let b = 0; b < bands; b++) {
      const off = Math.sin(b * 0.9 + S.t * 3.4) * (1.5 + 3 * progress) * (H / 400);
      ctx.drawImage(sil, 0, b * bh * sil.height / r.h, sil.width, bh * sil.height / r.h + 1, r.x + off, r.y + b * bh, r.w, bh + 1);
    }
    ctx.filter = 'none';
    // 胴体の周りの空気（ゆっくり上へ流れるノイズ）
    if (!this.low) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx, cy - H * 0.05, H * 0.24, H * 0.36, 0, 0, TAU);
      ctx.clip();
      ctx.globalAlpha = (0.1 + 0.22 * progress) * k;
      const n = this.tex.noiseCyan, sc = H / 300;
      const yoff = (S.t * 26) % (n.height * sc);
      for (let yy = -1; yy <= 1; yy++) ctx.drawImage(n, cx - n.width * sc / 2, cy - H * 0.45 + yy * n.height * sc - yoff, n.width * sc, n.height * sc);
      ctx.restore();
    }
    // 立ち上る細かな光
    const count = Math.round((this.low ? 6 : 10) + (this.low ? 10 : 30) * progress);
    for (let i = 0; i < count; i++) {
      const life = 1.7, ph = hash(i * 1.37) * life;
      const age = (S.t * 0.9 + ph) % life, u = age / life;
      const x = cx + (hash(i * 7.3) - 0.5) * H * 0.34 + Math.sin(u * 5 + i) * H * 0.012;
      const y = cy + H * 0.12 - u * H * 0.5;
      const a = Math.sin(Math.PI * u) * (0.5 + 0.5 * progress) * k * (0.6 + 0.4 * Math.sin(S.t * 9 + i * 2.1));
      const sz = H * (0.008 + 0.012 * hash(i * 2.9));
      ctx.globalAlpha = clamp01(a);
      ctx.drawImage(this.tex.dotCyan, x - sz, y - sz, sz * 2, sz * 2);
    }
    ctx.restore();
  }

  _stance(ctx, S, e, p) {
    const cur = this._cur(S);
    if (!cur) return;
    const k = this.strength * e.gradeI;
    const { r, T } = cur;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // 輪郭の光（決まった瞬間に強く、すぐ引く）
    const rim = this.rim(cur.index, cur.bmp, r.w, r.h, '#ffe7b0', Math.max(1.5, S.standH / 220));
    ctx.globalAlpha = clamp01((1 - p) ** 1.4 * 0.95 * k);
    if (this.filterOk && !this.low) ctx.filter = 'blur(1.2px)';
    ctx.drawImage(rim, r.x - 4, r.y - 4, r.w + 8, r.h + 8);
    ctx.filter = 'none';
    ctx.globalAlpha = clamp01((1 - p) ** 2 * 0.6 * k);
    ctx.drawImage(rim, r.x - 4, r.y - 4, r.w + 8, r.h + 8);
    // 体の上を上から下へ走る光（シルエットの内側だけ）
    if (p < 0.6) {
      const sil = this.silhouette(cur.index, cur.bmp, r.w, r.h, '#ffffff');
      const tw = Math.ceil(r.w), th = Math.ceil(r.h);
      if (this.tmp.width < tw || this.tmp.height < th) { this.tmp.width = Math.max(this.tmp.width, tw); this.tmp.height = Math.max(this.tmp.height, th); }
      const g = this.tmp.getContext('2d');
      g.globalCompositeOperation = 'source-over';
      g.clearRect(0, 0, this.tmp.width, this.tmp.height);
      const band = th * 0.16, y = -band + (th + band * 2) * easeOut(p / 0.6);
      const gr = g.createLinearGradient(0, y - band, 0, y + band);
      gr.addColorStop(0, 'rgba(255,235,190,0)');
      gr.addColorStop(0.5, 'rgba(255,245,220,0.9)');
      gr.addColorStop(1, 'rgba(255,235,190,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, tw, th);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(sil, 0, 0, tw, th);
      ctx.globalAlpha = clamp01(0.55 * k * (1 - p));
      ctx.drawImage(this.tmp, 0, 0, tw, th, r.x, r.y, tw, th);
    }
    // 胸元の閃光
    if (p < 0.4) {
      const q = p / 0.4, sz = S.standH * (0.18 + 0.22 * easeOut(q));
      const [fx, fy] = [T.ox, T.oy - S.standH * 0.12];
      ctx.globalAlpha = clamp01((1 - q) ** 1.5 * 0.85 * k);
      ctx.translate(fx, fy);
      ctx.rotate(e.t0 * 1.7);
      ctx.drawImage(this.tex.flareGold, -sz / 2, -sz / 2, sz, sz);
    }
    ctx.restore();
  }

  _strikeGeom(S, e) {
    // 打撃点: ノーツの effect.anchor（元画像 0〜1）をトリガー時のコマの変換で画面へ
    const fr = S.store.frames[e.frameIndex];
    const T = S.transformFor(e.frameIndex);
    const ax = (e.anchor?.x ?? 0.5) * S.store.m.width, ay = (e.anchor?.y ?? 0.45) * S.store.m.height;
    const [px, py] = T.toScreen(ax, ay);
    let dx = e.direction?.x ?? (ax - fr.anchor[0]), dy = e.direction?.y ?? (ay - fr.anchor[1]);
    const n = Math.hypot(dx, dy) || 1;
    return { px, py, dx: dx / n, dy: dy / n };
  }

  _afterimage(ctx, S, e, p) {
    if (p > 1) return;
    const n = this.low ? 1 : 2;
    ctx.save();
    for (let k = n; k >= 1; k--) {
      const i = e.frameIndex - k;
      const bmp = i >= 0 ? S.store.peek(i) : null;
      if (!bmp) continue;
      const T = S.transformFor(i), r = T.crop();
      const sil = this.silhouette(i, bmp, r.w, r.h, e.action === 'kick' ? '#5fc8ff' : '#ff9a4a');
      ctx.globalAlpha = clamp01((0.34 / k) * (1 - p) * this.strength * e.gradeI);
      ctx.drawImage(sil, r.x, r.y, r.w, r.h);
    }
    ctx.restore();
  }

  _strike(ctx, S, e, p) {
    const k = this.strength * e.gradeI;
    const { px, py, dx, dy } = this._strikeGeom(S, e);
    const H = S.standH, ang = Math.atan2(dy, dx);
    const kick = e.action === 'kick';
    // 打撃点の局所的な歪み（その時点の画面を少し拡大して戻す。低負荷では省略）
    if (!this.low && p < 0.55 && S.canvas) {
      const q = p / 0.55, R = H * (0.06 + 0.12 * easeOut(q)), dpr = S.dpr;
      const sz = Math.ceil(R * 2 * dpr);
      if (this.tmp2.width < sz || this.tmp2.height < sz) { this.tmp2.width = Math.max(this.tmp2.width, sz); this.tmp2.height = Math.max(this.tmp2.height, sz); }
      const g = this.tmp2.getContext('2d');
      g.globalCompositeOperation = 'source-over';
      g.clearRect(0, 0, sz, sz);
      const mag = 1 + 0.16 * (1 - q) * k;
      const src = R / mag;
      try {
        g.drawImage(S.canvas, (px - src) * dpr, (py - src) * dpr, src * 2 * dpr, src * 2 * dpr, 0, 0, sz, sz);
        g.globalCompositeOperation = 'destination-in';
        const gr = g.createRadialGradient(sz / 2, sz / 2, 0, sz / 2, sz / 2, sz / 2);
        gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.7, 'rgba(0,0,0,0.85)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr;
        g.fillRect(0, 0, sz, sz);
        ctx.save();
        ctx.globalAlpha = 0.9;
        ctx.drawImage(this.tmp2, 0, 0, sz, sz, px - R, py - R, R * 2, R * 2);
        // 衝撃の縁（ノイズで途切れる薄い光の輪）
        ctx.globalCompositeOperation = 'lighter';
        ctx.beginPath();
        ctx.arc(px, py, R, 0, TAU);
        ctx.arc(px, py, R * 0.86, 0, TAU, true);
        ctx.clip('evenodd');
        ctx.globalAlpha = clamp01(0.5 * (1 - q) * k);
        const nt = kick ? this.tex.noiseCyan : this.tex.noiseWarm;
        ctx.drawImage(nt, px - R, py - R, R * 2, R * 2);
        ctx.restore();
      } catch { /* キャンバスが読めない環境では省略 */ }
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // 攻撃方向へ伸びるエネルギー（2 層: 外側の色 ＋ 白熱の芯）
    const grow = easeOut(clamp01(p / 0.16));
    const L = H * (0.42 + 0.22 * e.gradeI) * grow, W = H * 0.1 * (1 - p) ** 0.6;
    if (p < 1 && L > 1) {
      ctx.save();
      ctx.translate(px - dx * H * 0.03, py - dy * H * 0.03);
      ctx.rotate(ang);
      const tex = kick ? this.tex.beamKick : this.tex.beamPunch;
      const scroll = (S.t * 900) % (tex.width * 0.25);
      ctx.globalAlpha = clamp01((1 - p ** 2) * k);
      ctx.drawImage(tex, scroll * 0.2, 0, tex.width - scroll * 0.2, tex.height, 0, -W, L, W * 2);
      ctx.globalAlpha = clamp01((1 - p) ** 1.5 * 0.9 * k);
      ctx.drawImage(this.tex.beamHot, 0, 0, tex.width, tex.height, 0, -W * 0.45, L * 0.8, W * 0.9);
      ctx.restore();
    }
    // 打撃点の閃光
    if (p < 0.3) {
      const q = p / 0.3, sz = H * (0.12 + 0.2 * easeOut(q)) * (0.7 + 0.3 * e.gradeI);
      ctx.globalAlpha = clamp01((1 - q) * k);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(ang + e.t0);
      ctx.drawImage(this.tex.flareWhite, -sz / 2, -sz / 2, sz, sz);
      ctx.restore();
    }
    // 火花（攻撃方向の円錐に飛ぶ。速度方向に伸ばして動きのぶれを出す）
    const n = this.low ? 8 : 18;
    for (let i = 0; i < n; i++) {
      const sd = e.seed * 13.7 + i;
      const a = ang + (hash(sd) - 0.5) * 1.3;
      const sp = H * (0.25 + 0.55 * hash(sd + 1.3));
      const life = 0.35 + 0.4 * hash(sd + 2.1);
      const u = (S.t - e.t0) / life;
      if (u < 0 || u > 1) continue;
      const d = sp * easeOut(u) * 0.55;
      const x = px + Math.cos(a) * d, y = py + Math.sin(a) * d + H * 0.05 * u * u;
      const len = H * 0.035 * (1 - u) + 2, wd = H * 0.008 * (1 - u) + 1;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.globalAlpha = clamp01((1 - u) * k);
      ctx.drawImage(kick ? this.tex.dotCyan : this.tex.dotGold, -len, -wd, len * 2, wd * 2);
      ctx.restore();
    }
    ctx.restore();
  }

  _turnTrail(ctx, S, e, p) {
    if (p > 1) return;
    const n = this.low ? 2 : 4;
    const dir = e.direction?.x ? Math.sign(e.direction.x) : 1;
    ctx.save();
    for (let k = n; k >= 1; k--) {
      const i = e.frameIndex - k;
      const bmp = i >= 0 ? S.store.peek(i) : null;
      if (!bmp) continue;
      const T = S.transformFor(i), r = T.crop();
      const sil = this.silhouette(i, bmp, r.w, r.h, '#7fd8ff');
      const off = -dir * k * S.standH * 0.035 * (0.4 + p);
      ctx.globalAlpha = clamp01(0.38 * (1 - k / (n + 1)) * (1 - p) * this.strength * e.gradeI);
      ctx.drawImage(sil, r.x + off, r.y, r.w, r.h);
    }
    ctx.restore();
  }

  _swirl(ctx, S, e, p, side) {
    if (p > 1) return;
    const cur = this._cur(S);
    if (!cur) return;
    const k = this.strength * e.gradeI * (1 - p) ** 0.8;
    const H = S.standH, cx = cur.T.ox, cy = cur.T.oy;
    const dir = e.direction?.x ? Math.sign(e.direction.x) : 1;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const [yy, rx, ry, w] of [[0.12, 0.34, 0.08, 0.05], [-0.12, 0.3, 0.07, 0.04], [0.32, 0.38, 0.09, 0.05]]) {
      const ey = cy + yy * H, RX = rx * H * (0.8 + 0.4 * p), RY = ry * H;
      ctx.save();
      // 奥側（上半分）は人物の後ろ、手前側（下半分）は人物の前に描く
      ctx.beginPath();
      if (side === 'back') ctx.rect(cx - RX - 10, ey - RY - 10, RX * 2 + 20, RY + 10);
      else ctx.rect(cx - RX - 10, ey, RX * 2 + 20, RY + 10);
      ctx.clip();
      ctx.beginPath();
      ctx.ellipse(cx, ey, RX, RY, 0, 0, TAU);
      ctx.ellipse(cx, ey, RX * (1 - w * 2.2), RY * (1 - w * 5), 0, 0, TAU);
      ctx.clip('evenodd');
      const nt = this.tex.noiseCyan, rot = dir * (S.t - e.t0) * 7 + yy * 5;
      ctx.translate(cx, ey);
      ctx.scale(1, RY / RX);
      ctx.rotate(rot);
      ctx.globalAlpha = clamp01(0.75 * k * (side === 'back' ? 0.6 : 1));
      ctx.drawImage(nt, -RX * 1.1, -RX * 1.1, RX * 2.2, RX * 2.2);
      ctx.restore();
    }
    // 巻き込まれる空気の粒（楕円軌道上を流れる、速度方向に伸ばす）
    const n = this.low ? 6 : 14;
    for (let i = 0; i < n; i++) {
      const ph = hash(i * 4.1 + e.seed) * TAU;
      const th = ph + dir * (S.t - e.t0) * (5 + 3 * hash(i));
      const front = Math.sin(th) > 0;
      if ((side === 'front') !== front) continue;
      const yy = (hash(i * 2.3) - 0.3) * 0.5;
      const RX = H * (0.3 + 0.08 * hash(i * 9.1)) * (0.8 + 0.4 * p);
      const x = cx + Math.cos(th) * RX, y = cy + yy * H + Math.sin(th) * RX * 0.22;
      const len = H * 0.03, wd = H * 0.006;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.atan2(Math.cos(th) * 0.22, -Math.sin(th)) * dir);
      ctx.globalAlpha = clamp01(0.7 * k);
      ctx.drawImage(this.tex.dotCyan, -len, -wd, len * 2, wd * 2);
      ctx.restore();
    }
    ctx.restore();
  }
}
