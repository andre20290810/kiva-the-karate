// 成功エフェクト（Canvas 2D）。人物のアルファ（切り抜きの形）を使って、光・残像・歪みを人物に結び付ける。
// - Y 呼吸: 胴体の周りに立ち上る細かな光と、輪郭の空気の揺らぎ（長押しの進み具合で増える）
// - X 構え: 輪郭に沿う光（リムライト）、体の上を走る光、胸元の閃光
// - A 打撃: 拳・足の位置から攻撃方向へ伸びるエネルギー、直前のコマの残像、打撃点の局所的な歪み、火花
// - B 旋回: 直前の数コマのシルエットの残像、体を巻く空気のノイズ（体の前後に回り込む）
// - 背後にまとう炎（番号 5、息の既定）: 人物の形から背後に立ち上がる炎（揺らぎ・明暗・透け感）と火の粉、輪郭の控えめな照り返し。
//   炎の本体は人物の後ろに描く（顔・髪・道着・手足は隠さない）。床の反射や人影の複製は作らない。
//   長押し中は小さく灯って育ち、成功で大きく燃え上がって短い余韻で収まる。途中で離す・MISS では燃え上がらずに消える
// どのエフェクトも番号（app/effects-catalog.js）で選び、発生位置・位置調整・向き・大きさ・強さ・持続時間を変えられる。
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

/**
 * 炎の舌の形（下が根元、上が先）。芯は黄白、外へ橙・赤、縁はノイズで揺らぎ、先は曲がって細る。
 * 曲がり方の違う数種類を作り、描くときに入れ替えて揺らぎにする
 */
function flameSprite(seed, w = 64, h = 160) {
  const c = canvas(w, h), g = c.getContext('2d'), im = g.createImageData(w, h);
  const N = 256, n = valueNoise(N, 10, 20 + seed), n2 = valueNoise(N, 24, 40 + seed);
  const at = (a, x, y) => a[(((y | 0) % N + N) % N) * N + (((x | 0) % N + N) % N)];
  const bend = (hash(seed * 3.1) - 0.5) * 0.9, bend2 = (hash(seed * 7.7) - 0.5) * 0.6;
  for (let y = 0; y < h; y++) {
    const v = 1 - y / h; // 0 = 根元、1 = 先
    // 幅: 根元の少し上がいちばん太く、先へ細る
    const width = 0.62 * Math.sin(Math.PI * Math.min(1, 0.18 + v * 0.95)) ** 0.8 * (1 - v) ** 0.35 + 0.02;
    const cx = bend * v * v + bend2 * Math.sin(v * Math.PI * 1.6) * v + (at(n, 30, v * 90) - 0.5) * 0.35 * v;
    for (let x = 0; x < w; x++) {
      const u = (x / (w - 1)) * 2 - 1;
      const edge = (at(n2, x * 3, y * 1.2) - 0.5) * 0.35 * (0.4 + v);
      const d = Math.abs(u - cx) / (width + edge * width + 1e-3);
      let a = clamp01(1.25 - d * 1.25) ** 0.9;
      a *= 0.72 + 0.28 * at(n, x * 2, y * 0.7); // 明暗
      a *= clamp01(v * 10) * clamp01((1 - v) * 3.5); // 根元はなじませ、先は消える
      const hot = clamp01(1 - d * 1.6) * clamp01(1.1 - v * 1.4); // 芯
      const i = (y * w + x) * 4;
      im.data[i] = 255;
      im.data[i + 1] = Math.round(70 + 120 * clamp01(1 - v * 0.9) * (0.4 + 0.6 * (1 - d)) + 60 * hot);
      im.data[i + 2] = Math.round(10 + 150 * hot * hot);
      im.data[i + 3] = Math.round(255 * a);
    }
  }
  g.putImageData(im, 0, 0);
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

const DUR = { breath: 0.7, stance: 0.6, strike: 0.55, turn: 0.75, backFire: 1.1 };
const JOINT_OF = { head: 'nose', left_wrist: 'left_wrist', right_wrist: 'right_wrist', left_ankle: 'left_ankle', right_ankle: 'right_ankle' };

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
      flames: [0, 1, 2, 3, 4, 5].map((k) => flameSprite(k)), // 背後の炎の舌
    };
    this.sil = new Map(); // 色付きシルエットのキャッシュ（キー: コマ番号|色|幅）
    this.tmp = canvas(64, 64);
    this.tmp2 = canvas(64, 64);
    this.hold = null;     // 長押し中のエフェクト {id, key, fx, progress, done}
    this.smother = [];    // 途中で離した・MISS: 燃え上がらずに消える炎
    this.filterOk = (() => { try { const g = canvas(2, 2).getContext('2d'); g.filter = 'blur(2px)'; return g.filter === 'blur(2px)'; } catch { return false; } })();
    this.stats = { active: 0, drawn: 0 };
  }

  setQuality({ low, strength }) {
    if (low != null) this.low = !!low;
    if (strength != null) this.strength = Math.max(0, Math.min(1, strength));
  }

  clear() { this.list = []; this.hold = null; this.smother = []; this._trimCache(true); }

  /**
   * 成功時に呼ぶ。kind: breath|stance|strike|turn|backFire|none（エフェクトの種類。コマンドとは別に選べる）
   * o.fx: resolveEffect() の値（発生位置・位置調整・向き・大きさ・強さ・持続時間）
   */
  trigger(kind, o) {
    if (kind === 'none') return;
    const gradeI = o.grade === 'PERFECT' ? 1 : 0.62;
    const fx = o.fx || {};
    this.list.push({ ...o, kind, t0: o.t, dur: fx.duration ?? DUR[kind], gradeI: gradeI * (fx.intensity ?? o.intensity ?? 1), fx,
      anchor: fx.anchor ?? o.anchor, direction: fx.direction ?? o.direction });
    if (this.list.length > 24) this.list.shift();
  }

  /**
   * 長押し中のエフェクト（毎フレーム）。h = {id, key, fx, progress} か null。
   * 長押しが成功以外（途中で離す・MISS）で終わったら、育った炎を燃え上がらせずに消す
   */
  setHold(h, t) {
    const cur = this.hold;
    if (h && cur && h.id === cur.id) { cur.progress = h.progress; cur.fx = h.fx; cur.key = h.key; return; }
    if (cur && !cur.done && cur.key === 'backFire') this.smother.push({ ...cur, t0: t, level: this._holdLevel(cur.progress) });
    this.hold = h ? { ...h } : null;
  }

  /** 長押しの成功（炎は燃え上がりへ引き継ぐ。消える演出は出さない） */
  holdDone(id) { if (this.hold && (id == null || this.hold.id === id)) this.hold.done = true; }

  _holdLevel(p) { return 0.25 + 0.75 * clamp01(p); }

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

  /** ぼかし済みの画像（コマごとに 1 回だけ作る。毎フレームの filter は重いので使わない） */
  blurred(key, src, px) {
    const k = `blur|${key}|${px}`;
    let c = this.sil.get(k);
    if (!c) {
      const pad = Math.ceil(px * 3);
      c = canvas(src.width + pad * 2, src.height + pad * 2);
      const g = c.getContext('2d');
      if (this.filterOk) g.filter = `blur(${px}px)`;
      g.drawImage(src, pad, pad);
      c.pad = pad;
      this.sil.set(k, c);
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
    // 背後の炎: 長押し中 → 途中で消える炎 → 成功の燃え上がり（人物の後ろ）
    const h = this.hold;
    if (h?.key === 'backFire') this._place(ctx, S, { fx: h.fx, frameIndex: S.frameIndex }, () => this._fireAura(ctx, S, h.fx, this._holdLevel(h.progress) * (h.fx.intensity ?? 1), 0, 7));
    this.smother = this.smother.filter((e) => S.t >= e.t0 - 0.05 && S.t - e.t0 < 0.4);
    for (const e of this.smother) {
      const q = clamp01((S.t - e.t0) / 0.4);
      this._place(ctx, S, { fx: e.fx, frameIndex: S.frameIndex }, () => this._fireAura(ctx, S, e.fx, e.level * (1 - q) ** 1.5 * (e.fx.intensity ?? 1), 0, 7));
    }
    for (const e of this.list) {
      const p = (S.t - e.t0) / e.dur;
      if (p < 0) continue;
      if (e.kind === 'turn') this._place(ctx, S, e, () => { this._turnTrail(ctx, S, e, p); this._swirl(ctx, S, e, p, 'back'); });
      if (e.kind === 'strike') this._afterimage(ctx, S, e, p);
      if (e.kind === 'backFire') this._place(ctx, S, e, () => this._fireAura(ctx, S, e.fx, this._flareLevel(e, p), 1, e.seed));
    }
  }

  /** 成功の燃え上がり: 効果音の山（t0）で一気に大きく、短い余韻で収まる */
  _flareLevel(e, p) {
    if (p > 1) return 0;
    return (e.hold ? 1.65 : 1.45) * e.gradeI * (1 - p) ** 1.25;
  }

  /** 発生位置: 基準（胴体・頭・拳・足・指定位置）＋画面上の位置調整（直立時の身長比）。[x, y] */
  _origin(S, e, which) {
    const fx = e.fx || {}, H = S.standH;
    const fi = which === 'trigger' ? e.frameIndex ?? S.frameIndex : S.frameIndex;
    const T = S.transformFor(fi), fr = S.store.frames[fi];
    let x = T.ox, y = T.oy;
    const j = JOINT_OF[fx.origin];
    if (j && fr?.joints?.[j]) [x, y] = T.toScreen(fr.joints[j][0], fr.joints[j][1]);
    else if (fx.origin === 'point' && fx.anchor) [x, y] = T.toScreen(fx.anchor.x * S.store.m.width, fx.anchor.y * S.store.m.height);
    return [x + (fx.offset?.x ?? 0) * H, y + (fx.offset?.y ?? 0) * H];
  }

  /** 人物（胴体）を中心に作る演出を、指定の位置・大きさへ移して描く */
  _place(ctx, S, e, draw) {
    const fx = e.fx || {};
    const size = fx.size ?? 1, moved = (fx.origin && fx.origin !== 'auto' && fx.origin !== 'torso') || fx.offset?.x || fx.offset?.y;
    if (size === 1 && !moved) { draw(); return; }
    const T = S.transformFor(S.frameIndex);
    const [tx, ty] = this._origin(S, e, 'current');
    ctx.save();
    ctx.translate(tx, ty); ctx.scale(size, size); ctx.translate(-T.ox, -T.oy);
    draw();
    ctx.restore();
  }

  /** 人物を描いた後（光・歪み・粒子） */
  renderOver(ctx, S) {
    let drawn = 0;
    for (const e of this.list) {
      const p = (S.t - e.t0) / e.dur;
      if (p < 0) continue;
      drawn++;
      if (e.kind === 'stance') this._place(ctx, S, e, () => this._stance(ctx, S, e, p));
      else if (e.kind === 'strike') this._strike(ctx, S, e, p);
      else if (e.kind === 'turn') this._place(ctx, S, e, () => this._swirl(ctx, S, e, p, 'front'));
      else if (e.kind === 'breath') this._place(ctx, S, e, () => { this._breath(ctx, S, e.anchorFrame ?? S.frameIndex, 1, 1 - p, e.gradeI); if (p < 0.3) this._breathConverge(ctx, S, e, p / 0.3); });
      else if (e.kind === 'backFire') this._place(ctx, S, e, () => this._fireRim(ctx, S, this._flareLevel(e, p)));
    }
    this.stats = { active: this.list.length, drawn, cache: this.sil.size };
  }

  /** 長押し中（人物の手前側）: 呼吸の気は進み具合で増やす。背後の炎は輪郭の照り返し */
  renderHold(ctx, S) {
    const h = this.hold;
    if (!h) return;
    const k = h.fx?.intensity ?? 1;
    if (h.key === 'breath') this._place(ctx, S, { fx: h.fx }, () => this._breath(ctx, S, S.frameIndex, h.progress, 1, k));
    else if (h.key === 'backFire') this._place(ctx, S, { fx: h.fx }, () => this._fireRim(ctx, S, this._holdLevel(h.progress) * k));
  }

  // ---------- 背後にまとう炎 ----------
  /** 人物の輪郭（行ごとの左右の端、元画像の切り抜き内 0〜1）。コマごとに 1 回だけ調べる */
  _outline(index, bmp) {
    const key = `outline|${index}`;
    let o = this.sil.get(key);
    if (!o) {
      const R = 28, W = 40;
      const c = canvas(W, R), g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0, W, R);
      const d = g.getImageData(0, 0, W, R).data;
      const rows = [];
      for (let y = 0; y < R; y++) {
        let l = -1, r = -1;
        for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 90) { if (l < 0) l = x; r = x; }
        if (l >= 0) rows.push({ v: (y + 0.5) / R, l: (l + 0.5) / W, r: (r + 0.5) / W });
      }
      o = { rows };
      this.sil.set(key, o);
      this._trimCache();
    }
    return o;
  }

  /**
   * 人物の背後の炎。炎の舌（手続き的に作った曲がった炎の形。芯は黄、外は橙〜赤、ノイズの明暗）を、
   * 人物の輪郭（左右の端・頭や肩）から立ち上らせる。舌は揺れながら伸び、細って消え、次々に入れ替わる。
   * 人物の後ろに描くので、根元は体に隠れ、体を包むように見える。足元より下には描かない（床の反射を作らない）。
   * level: 炎の大きさ・明るさ（長押し 0.25〜1、燃え上がり 〜1.65）
   */
  _fireAura(ctx, S, fx, level, flare, seed) {
    if (level <= 0.02) return;
    const cur = this._cur(S);
    if (!cur) return;
    const { r, T } = cur, H = S.standH, k = this.strength;
    if (k <= 0.01) return;
    const wid = fx?.width ?? 1, hei = fx?.height ?? 1;
    const fr = S.store.frames[cur.index];
    const footY = fr.bbox ? T.toScreen(fr.bbox[0], fr.bbox[1] + fr.bbox[3])[1] : r.y + r.h;
    const L = Math.min(1.7, level);
    const rows = this._outline(cur.index, cur.bmp).rows;
    if (!rows.length) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x - H, r.y - H * 1.5, r.w + H * 2, footY - (r.y - H * 1.5)); ctx.clip();
    // 体の周りの熱気（人物の形をぼかしたもの。円にはしない）
    const sil0 = this.silhouette(cur.index, cur.bmp, r.w * 0.5, r.h * 0.5, '#ff5a14');
    const glow = this.blurred(`${cur.index}|fireglow|${(r.w * 0.5) | 0}`, sil0, Math.max(3, r.w * 0.05));
    const gp = glow.pad || 0, gs = r.w / sil0.width;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp01(0.3 * L * k);
    ctx.drawImage(glow, r.x - gp * gs - r.w * 0.05 * wid, r.y - gp * gs - r.h * 0.04, r.w + gp * gs * 2 + r.w * 0.1 * wid, r.h + gp * gs * 2 + r.h * 0.04);
    // 炎の舌: 輪郭の左右の端と頭・肩から。体の上の方ほど多く、高く伸びる
    const n = Math.round((this.low ? 24 : 56) * (0.45 + 0.55 * Math.min(1.3, L)));
    const sprites = this.tex.flames;
    const top = rows[0];
    for (let i = 0; i < n; i++) {
      const h1 = hash(i * 7.13 + seed * 1.7), h2 = hash(i * 3.31 + seed * 0.9), h3 = hash(i * 5.77 + 11);
      const life = 0.42 + 0.38 * h3;
      const u = ((S.t / life + h1) % 1 + 1) % 1; // 舌の一生（0 → 1）
      // 根元: 上の行ほど選ばれやすい（頭・肩から立ち上る）。両端と頭頂
      const ri = Math.min(rows.length - 1, Math.floor((h2 ** 1.5) * rows.length));
      const row = rows[ri];
      const side = i % 5 === 0 ? 0 : (i % 2 ? -1 : 1);
      const ex = side === 0 ? (top.l + top.r) / 2 + (h3 - 0.5) * (top.r - top.l) : side < 0 ? row.l : row.r;
      const ev = side === 0 ? top.v : row.v;
      const rx = r.x + ex * r.w - side * r.w * 0.04 + side * r.w * 0.06 * (wid - 1), ry = r.y + (side === 0 ? ev + 0.03 : ev) * r.h; // 根元は輪郭の少し内側（体に隠れる）
      // 大きさ・高さ: 上の方・燃え上がりで大きく。一生の間に伸びて細って消える
      const upper = 1 - row.v;
      const size = H * (0.11 + 0.08 * h1 + 0.07 * upper) * (0.55 + 0.45 * L) * wid;
      const len = H * (0.16 + 0.22 * upper + 0.12 * h2) * (0.4 + 0.6 * L) * hei;
      const grow = Math.sin(Math.PI * Math.min(1, u * 1.15)) ** 0.7;
      const sway = Math.sin(S.t * (5 + 3 * h3) + i * 2.3) * size * 0.22 + side * u * size * 0.3;
      const w = size * (1 - 0.35 * u), hgt = len * (0.6 + 0.6 * u) * (0.75 + 0.25 * grow);
      const x = rx + sway, y = ry - u * len * 0.3;
      const spr = sprites[(i + Math.floor(S.t * 12 + h1 * 7)) % sprites.length]; // ゆらぎ（形の入れ替わり）
      // レーンの帯にかかる舌は薄く（レーンの文字・判定の表示を読みやすく）
      const lane = S.laneBottom != null && y - hgt * 0.5 < S.laneBottom ? 0.4 : 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = clamp01(grow * (0.55 + 0.25 * h2) * Math.min(1, L * 1.2) * k * lane);
      ctx.drawImage(spr, x - w / 2, y - hgt, w, hgt * 1.08);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = clamp01(grow * 0.25 * Math.min(1.4, L) * k * lane);
      ctx.drawImage(spr, x - w / 2, y - hgt, w, hgt * 1.08);
    }
    // 火の粉（体のまわりから舞い上がる）
    ctx.globalCompositeOperation = 'lighter';
    const cnt = Math.round((this.low ? 8 : 22) * Math.min(1.6, L));
    for (let i = 0; i < cnt; i++) {
      const life = 0.9 + 0.8 * hash(i * 3.7 + seed);
      const u = (((S.t + hash(i * 1.3 + seed) * life) % life) + life) % life / life;
      const row = rows[Math.floor(hash(i * 9.7) ** 1.3 * rows.length) % rows.length];
      const side = hash(i * 5.1 + seed) < 0.5 ? -1 : 1;
      const x0 = r.x + (side < 0 ? row.l : row.r) * r.w + side * r.w * 0.05;
      const x = x0 + Math.sin(u * 7 + i) * H * 0.02 + side * u * H * 0.05;
      const y = r.y + row.v * r.h - u * H * (0.3 + 0.3 * L) * hei;
      const sz = H * (0.004 + 0.005 * hash(i * 4.4)) * (1 - u * 0.6);
      ctx.globalAlpha = clamp01((1 - u) * Math.sin(Math.PI * Math.min(1, u * 4)) * (0.6 + 0.4 * Math.sin(S.t * 23 + i)) * k);
      ctx.fillStyle = i % 3 ? '#ff9a3c' : '#ffe08a';
      ctx.fillRect(x - sz / 2, y - sz * 1.6, sz, sz * 3.2);
    }
    ctx.restore();
    void flare;
  }

  /** 炎の照り返し: 人物の輪郭に控えめな橙の光（顔や道着は隠さない） */
  _fireRim(ctx, S, level) {
    if (level <= 0.02) return;
    const cur = this._cur(S);
    if (!cur) return;
    const { r } = cur;
    const rim = this.rim(cur.index, cur.bmp, r.w, r.h, '#ff8a3a', Math.max(1.5, S.standH / 260));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp01(0.38 * Math.min(1.65, level) * this.strength);
    ctx.drawImage(rim, r.x - 4, r.y - 4, r.w + 8, r.h + 8);
    ctx.restore();
  }

  _expire(t) {
    // 時刻が戻った（シーク）・寿命切れのものを捨てる
    this.list = this.list.filter((e) => t >= e.t0 - 0.25 && t <= e.t0 + e.dur); // 効果音の山（t0）は判定より最大 0.2 秒後
  }

  _cur(S) {
    const g = S.store.get(S.frameIndex);
    if (!g) return null;
    const T = S.transformFor(g.index);
    const r = T.crop();
    return { bmp: g.bmp, index: g.index, T, r };
  }

  /** 呼吸の完了: 体の輪郭に沿う光が少し外側から体へ収束して消える（効果音の収束と同じ瞬間 t0 に最も明るい） */
  _breathConverge(ctx, S, e, q) {
    const cur = this._cur(S);
    if (!cur) return;
    const k = this.strength * e.gradeI;
    const { r, T } = cur;
    const rim = this.rim(cur.index, cur.bmp, r.w, r.h, '#d8f6ff', Math.max(1.5, S.standH / 240));
    const glow = this.low ? null : this.blurred(`${cur.index}|conv|${r.w | 0}`, rim, 2.5);
    const sc = 1 + 0.07 * (1 - easeOut(q)); // 外側から体へ
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(T.ox, T.oy); ctx.scale(sc, sc); ctx.translate(-T.ox, -T.oy);
    ctx.globalAlpha = clamp01((1 - q) ** 1.6 * 0.9 * k);
    if (glow) { const pd = glow.pad; ctx.drawImage(glow, r.x - 4 - pd, r.y - 4 - pd, r.w + 8 + pd * 2, r.h + 8 + pd * 2); }
    ctx.drawImage(rim, r.x - 4, r.y - 4, r.w + 8, r.h + 8);
    ctx.restore();
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
    const sil0 = this.silhouette(cur.index, cur.bmp, r.w, r.h, '#bfefff');
    const sil = this.low ? sil0 : this.blurred(`${cur.index}|breath|${r.w | 0}`, sil0, 3);
    // ぼかし済みの画像（周囲に pad 画素の余白）を、余白ごと横帯に切って少しずつ左右へずらす（帯の境目は重ねない）
    const pad = sil.pad || 0, sc = sil0.width / r.w;
    const SH = sil.height, DH = r.h + (2 * pad) / sc;
    const bands = this.low ? 6 : 14;
    ctx.globalAlpha = (0.12 + 0.2 * progress) * k;
    for (let b = 0; b < bands; b++) {
      const off = Math.sin(b * 0.9 + S.t * 3.4) * (1.5 + 3 * progress) * (H / 400);
      const sy0 = Math.round((SH * b) / bands), sy1 = Math.round((SH * (b + 1)) / bands);
      const dy0 = r.y - pad / sc + (DH * sy0) / SH, dh = (DH * (sy1 - sy0)) / SH;
      ctx.drawImage(sil, 0, sy0, sil.width, sy1 - sy0, r.x - pad / sc + off, dy0, r.w + (2 * pad) / sc, dh);
    }
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
    if (!this.low) {
      const rb = this.blurred(`${cur.index}|rim|${r.w | 0}`, rim, 1.5), pd = rb.pad;
      ctx.drawImage(rb, r.x - 4 - pd, r.y - 4 - pd, r.w + 8 + pd * 2, r.h + 8 + pd * 2);
    }
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
      // 決まった瞬間（t0）に胸（体の幅がいちばん広い所）で最も明るく、下へ走りながら弱まる
      const band = th * 0.16, y0 = th * 0.24, y = y0 + (th - y0) * easeOut(p / 0.6);
      const gr = g.createLinearGradient(0, y - band, 0, y + band);
      gr.addColorStop(0, 'rgba(255,235,190,0)');
      gr.addColorStop(0.5, 'rgba(255,245,220,0.9)');
      gr.addColorStop(1, 'rgba(255,235,190,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, tw, th);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(sil, 0, 0, tw, th);
      ctx.globalAlpha = clamp01(0.55 * k * (1 - p / 0.6) ** 2.2); // 走りながら弱まる（明るさの山は t0）
      ctx.drawImage(this.tmp, 0, 0, tw, th, r.x, r.y, tw, th);
    }
    // 胸元の閃光
    if (p < 0.4) {
      const q = p / 0.4, sz = S.standH * (0.34 + 0.06 * easeOut(q)); // 最初から大きく、広がりながら消える（明るさの山 = t0）
      const [fx, fy] = [T.ox, T.oy - S.standH * 0.12];
      ctx.globalAlpha = clamp01((1 - q) ** 1.5 * 0.85 * k);
      ctx.translate(fx, fy);
      ctx.rotate(e.t0 * 1.7);
      ctx.drawImage(this.tex.flareGold, -sz / 2, -sz / 2, sz, sz);
    }
    ctx.restore();
  }

  _strikeGeom(S, e) {
    // 打撃点: ノーツの effect.anchor（元画像 0〜1）か、選んだ基準（拳・足・胴体など）をトリガー時のコマの変換で画面へ
    const fr = S.store.frames[e.frameIndex];
    const T = S.transformFor(e.frameIndex);
    const fx = e.fx || {};
    let ax = (e.anchor?.x ?? 0.5) * S.store.m.width, ay = (e.anchor?.y ?? 0.45) * S.store.m.height;
    const j = JOINT_OF[fx.origin];
    if (j && fr.joints?.[j]) [ax, ay] = fr.joints[j];
    else if (fx.origin === 'torso') [ax, ay] = fr.anchor;
    let [px, py] = T.toScreen(ax, ay);
    px += (fx.offset?.x ?? 0) * S.standH; py += (fx.offset?.y ?? 0) * S.standH;
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
    const H = S.standH * (e.fx?.size ?? 1), ang = Math.atan2(dy, dx);
    const kick = e.action === 'kick';
    // 打撃点の局所的な歪み（その時点の画面を少し拡大して戻す。低負荷では省略）
    if (!this.low && p < 0.55 && S.canvas) {
      const q = p / 0.55, R = H * (0.12 + 0.06 * easeOut(q)), dpr = S.dpr;
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
        ctx.globalAlpha = clamp01(0.5 * (1 - q) ** 1.6 * k);
        const nt = kick ? this.tex.noiseCyan : this.tex.noiseWarm;
        ctx.drawImage(nt, px - R, py - R, R * 2, R * 2);
        ctx.restore();
      } catch { /* キャンバスが読めない環境では省略 */ }
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // 攻撃方向へ伸びるエネルギー（2 層: 外側の色 ＋ 白熱の芯）
    // 衝撃音の最も強い瞬間（t0）でほぼ伸び切る（突き 約 11 ms、蹴り 約 19 ms）
    const grow = 0.6 + 0.4 * easeOut(clamp01(p / (kick ? 0.035 : 0.02))); // 山（t0）で既に 6 割の長さ（明るさの山を音の山にそろえる）
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
      const q = p / 0.3, sz = H * (0.26 + 0.06 * easeOut(q)) * (0.7 + 0.3 * e.gradeI); // 最初から大きく（明るさの山 = t0）
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
