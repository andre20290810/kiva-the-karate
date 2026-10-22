// レーンの文字ノーツ（息・構・撃・旋）の描画と、成功時に判定位置の文字そのものに灯る赤い火。
// - 文字は四角い枠を使わず、太い縁取りと影で背景から浮かせる（スマホでも読める）
// - 火: 文字の形（アルファ）を上へずらし重ねた炎の舌を、縦の流れのノイズで切り分けて描く（円・楕円・棒線は使わない）。
//   文字の輪郭・内部は赤熱し、炎が短く立ち上がり、火の粉と余韻を残して消える。文字は読める状態を保つ
// - 呼吸の長押し: 正しく保持している間は火が育ち、完了で強く灯る。早すぎる解除・MISS では発火せず、育った火は静かに消える
// 時刻は時間軸の秒（一時停止で止まり、シーク・リトライで clear()）。

// 文字のノーツは太字の行書体（Yuji Mai、SIL OFL。app/fonts/ に「息構撃旋」だけを切り出して同梱。iPhone・PC で同じ字形）。
// 読み込み前・失敗時は端末の字体で描き、読み込み後に寸法を測り直してキャッシュを作り直す。
export const BRUSH_FONT = { family: 'KivaBrush', url: 'app/fonts/yuji-mai-kiva.woff2' };
const SANS = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", "IPAGothic", sans-serif';
let FONT = SANS;
let fontReady = false;
const PAD = 0.5;       // 文字の画像の余白（文字の大きさに対する比。筆のはみ出し・縁取り・影・発光が切れない）
const BOLD = 0.05;     // 太字: 同じ色の線で太らせる（文字の大きさに対する比）
const VIS = 0.9;       // 4 文字の外形の大きい方の辺 = 文字の大きさ × VIS（読み込み後に実測して合わせる）
let metrics = null;    // { k: フォント px / 文字の大きさ, off: {ch: [dx, dy]}（外形の中心を描く位置に合わせる） }

/** 行書体を読み込む（失敗しても遊べる）。読み込めたら true */
export async function loadBrushFont(base = '') {
  try {
    if (typeof FontFace === 'undefined' || typeof document === 'undefined') return false;
    const f = new FontFace(BRUSH_FONT.family, `url(${base}${BRUSH_FONT.url}) format("woff2")`, { display: 'block' });
    await f.load();
    document.fonts.add(f);
    FONT = `"${BRUSH_FONT.family}", ${SANS}`;
    fontReady = true;
    metrics = null;
    return true;
  } catch (e) {
    console.warn('行書体を読み込めませんでした。端末の字体で表示します', e);
    return false;
  }
}
export const brushFontReady = () => fontReady;

/** 文字の外形を測る（フォントの読み込み後に 1 回）。字ごとの中心のずれと、4 文字共通の倍率 */
function measure(chars) {
  const c = canvas(8, 8), g = c.getContext('2d');
  const R = 200;
  g.font = `400 ${R}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  let big = 0;
  const off = {}, box = {};
  for (const ch of chars) {
    const m = g.measureText(ch);
    const l = m.actualBoundingBoxLeft ?? R / 2, r = m.actualBoundingBoxRight ?? R / 2;
    const a = m.actualBoundingBoxAscent ?? R / 2, d = m.actualBoundingBoxDescent ?? R / 2;
    off[ch] = [(l - r) / 2 / R, (a - d) / 2 / R];
    box[ch] = [(l + r) / R, (a + d) / R];
    big = Math.max(big, (l + r) / R, (a + d) / R);
  }
  return { k: big > 0 ? VIS / big : 1, off, box, font: FONT };
}
const GLYPH_CHARS = '息構撃旋';
/** 文字を描く位置とフォント（外形の中心が (x, y) に来る） */
function place(g, ch, x, y, size) {
  if (!metrics || metrics.font !== FONT) metrics = measure(GLYPH_CHARS.includes(ch) ? GLYPH_CHARS : ch);
  const k = metrics.off[ch] ? metrics.k : 1, o = metrics.off[ch] || [0, 0];
  const px = size * k;
  g.font = `400 ${px}px ${FONT}`;
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
  return { x: x + o[0] * px, y: y + o[1] * px, px };
}
/** 文字の外形（測定値。テスト・配置用）: 文字の大きさに対する幅・高さ */
export function glyphBox(ch) {
  if (!metrics || metrics.font !== FONT) metrics = measure(GLYPH_CHARS);
  const b = metrics.box[ch]; return b ? { w: b[0] * metrics.k, h: b[1] * metrics.k } : null;
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

function canvas(w, h) {
  const W = Math.max(1, Math.ceil(w)), H = Math.max(1, Math.ceil(h));
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
}

export class GlyphRenderer {
  constructor() {
    this.cache = new Map();
    this.list = [];       // 発火（成功）
    this.hold = null;     // 長押し中の火 {button, progress, x?}
    this.smother = [];    // 早すぎる解除などで消える火（発火の演出ではない）
    this.tmp = canvas(8, 8);
    this.noise = this._flameNoise();
  }

  clear() { this.list = []; this.hold = null; this.smother = []; }

  /** フォントの読み込み後: 文字の画像を作り直す（寸法は次に描くときに測り直す） */
  resetFont() { this.cache.clear(); }
  fontKey() { return fontReady ? 'brush' : 'sans'; }

  // ---------- 文字の画像（キャッシュ） ----------
  /** 文字だけの形（白、余白つき）。炎・赤熱の元 */
  mask(ch, size) {
    const key = `m|${ch}|${size}`;
    let c = this.cache.get(key);
    if (!c) {
      const pad = Math.ceil(size * PAD);
      c = canvas(size + pad * 2, size + pad * 2);
      const g = c.getContext('2d');
      const p = place(g, ch, c.width / 2, c.height / 2, size);
      g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineWidth = size * BOLD;
      g.strokeText(ch, p.x, p.y);
      g.fillText(ch, p.x, p.y);
      c.pad = pad;
      this._put(key, c);
    }
    return c;
  }

  /** ノーツの文字: 黒い縁取り＋影、同じ色で太らせ、上が明るいグラデーション */
  note(ch, size, color, rgb) {
    const key = `n|${ch}|${size}|${color}`;
    let c = this.cache.get(key);
    if (!c) {
      const pad = Math.ceil(size * PAD);
      c = canvas(size + pad * 2, size + pad * 2);
      const g = c.getContext('2d');
      const { x, y } = place(g, ch, c.width / 2, c.height / 2, size);
      // 影（背景から浮かせる）→ 黒い縁取り → 同じ色の線で太らせた色の文字（太字の行書。上をわずかに明るく）
      g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = Math.max(2, size * 0.1); g.shadowOffsetY = Math.max(1, size * 0.03);
      g.strokeStyle = 'rgba(6,3,1,0.95)'; g.lineWidth = Math.max(2.5, size * (0.1 + BOLD));
      g.strokeText(ch, x, y);
      g.shadowColor = 'transparent';
      const gr = g.createLinearGradient(0, y - size / 2, 0, y + size / 2);
      gr.addColorStop(0, `rgb(${rgb.split(',').map((v) => Math.round(+v + (255 - v) * 0.45)).join(',')})`); gr.addColorStop(0.45, `rgb(${rgb})`); gr.addColorStop(1, `rgb(${rgb})`);
      g.fillStyle = gr; g.strokeStyle = gr; g.lineWidth = size * BOLD;
      g.strokeText(ch, x, y);
      g.fillText(ch, x, y);
      c.pad = pad;
      this._put(key, c);
    }
    return c;
  }

  _put(k, c) { this.cache.set(k, c); if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value); }

  /** 炎を切り分ける縦の流れのノイズ（上へ流す。舌のように途切れる） */
  _flameNoise() {
    const W = 64, H = 128, c = canvas(W, H), g = c.getContext('2d'), img = g.createImageData(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const fx = x / W, fy = y / H;
      let v = 0, amp = 1, f = 1, tot = 0;
      for (let o = 0; o < 4; o++) {
        const sx = fx * 6 * f, sy = fy * 2.5 * f;
        v += amp * (0.5 + 0.5 * Math.sin(sx * 6.283 + Math.sin(sy * 6.283 + o * 1.7) * 1.4 + o * 2.1));
        tot += amp; amp *= 0.55; f *= 2;
      }
      v /= tot;
      const a = clamp01((v - 0.35) / 0.45);
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = Math.round(a * 255);
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  // ---------- ノーツ ----------
  drawNote(ctx, ch, x, y, size, st, alpha = 1, selected = false) {
    const c = this.note(ch, Math.round(size), st.color, st.rgb);
    ctx.globalAlpha = alpha;
    ctx.drawImage(c, x - c.width / 2, y - c.height / 2);
    if (selected) {
      const m = this.mask(ch, Math.round(size));
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.35 * alpha;
      ctx.drawImage(m, x - m.width / 2, y - m.height / 2);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
  }



  // ---------- 成功の火 ----------
  /** 成功: 判定位置の文字に火を灯す。t0 = 判定した瞬間 */
  ignite(button, ch, t0, grade, strong = false) {
    const I = (grade === 'PERFECT' ? 1 : 0.65) * (strong ? 1.25 : 1);
    this.list.push({ button, ch, t0, I, grade, strong, dur: strong ? 1.05 : 0.8, seed: Math.random() * 100 });
    if (this.list.length > 10) this.list.shift();
  }

  /** 長押し中の火（progress 0〜1）。null で長押しが終わった（成功なら ignite が別に呼ばれる） */
  setHold(h, t) {
    if (!h && this.hold && !this.hold.done) this.smother.push({ ...this.hold, t0: t }); // 早すぎる解除など: 静かに消える
    this.hold = h;
  }

  /** 完了: 長押しの火は発火へ引き継ぐ（消える演出は出さない） */
  holdDone() { if (this.hold) this.hold.done = true; }

  /**
   * 判定位置の文字の火を描く（ノーツより先に描く。次のノーツを覆わない）
   * @param rowY  (button) => 行の中心の y
   */
  drawFires(ctx, jx, rowY, size, t, glyphOf) {
    this.list = this.list.filter((e) => t - e.t0 < e.dur);
    this.smother = this.smother.filter((e) => t - e.t0 < 0.25);
    for (const e of this.smother) {
      const a = 1 - (t - e.t0) / 0.25;
      this._fire(ctx, glyphOf(e.button), jx, rowY(e.button), size, t, (0.2 + 0.5 * e.progress) * a * 0.6, 0.5 * a, 7, false);
    }
    if (this.hold && !this.hold.done) {
      const p = this.hold.progress;
      this._fire(ctx, glyphOf(this.hold.button), jx, rowY(this.hold.button), size, t, 0.25 + 0.75 * p, 0.35 + 0.5 * p, 3, true);
    }
    for (const e of this.list) {
      const age = t - e.t0;
      if (age < 0) continue;
      const u = age / e.dur;
      // 一瞬で燃え上がり（最も強いのは t0）、余韻を残して消える
      const flame = e.I * (1 - u) ** 1.4;
      const heat = e.I * (1 - u) ** 0.8;
      this._fire(ctx, e.ch, jx, rowY(e.button), size, t, flame, heat, e.seed, true, u, e.I);
    }
  }

  /** 1 つの文字の火。flame: 炎の強さ、heat: 赤熱の強さ、u: 発火からの進み（火の粉用） */
  _fire(ctx, ch, x, y, size, t, flame, heat, seed, showGlyph, u = null, I = 1) {
    const m = this.mask(ch, Math.round(size));
    const W = m.width, H = m.height;
    // 1) 炎の舌: 文字の形を上へずらし・伸ばし・細めながら重ね、縦の流れのノイズで舌に切り分ける（文字の上に立ち上がる）
    const fw = W, fh = H * 2.3;
    if (this.tmp.width < fw || this.tmp.height < fh) { this.tmp.width = Math.max(this.tmp.width, fw); this.tmp.height = Math.max(this.tmp.height, fh); }
    const g = this.tmp.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.clearRect(0, 0, fw, fh);
    const base = fh - H; // 文字の画像の上端（下寄せ）
    const n = 8, rise = size * 0.95 * clamp01(flame);
    for (let i = 0; i < n; i++) {
      const k = i / (n - 1);
      const sx = 1 - 0.3 * k, sy = 1 + 0.6 * k, wob = Math.sin(t * 9 + i * 1.7 + seed) * size * 0.06 * k;
      g.globalAlpha = 1 - k * 0.55;
      g.drawImage(m, (W - W * sx) / 2 + wob, base - rise * k - H * (sy - 1) * 0.7, W * sx, H * sy);
    }
    g.globalAlpha = 1;
    // 流れるノイズ（上へ流れる）。destination-in は描いた範囲の外も消すので、先に別の画像へ並べてから 1 回で切り抜く
    const nh = fh, scroll = (t * size * 2.6 + seed * 37) % nh;
    if (!this.tmp2) this.tmp2 = canvas(8, 8);
    if (this.tmp2.width < fw || this.tmp2.height < fh) { this.tmp2.width = Math.max(this.tmp2.width, fw); this.tmp2.height = Math.max(this.tmp2.height, fh); }
    const g2 = this.tmp2.getContext('2d');
    g2.clearRect(0, 0, this.tmp2.width, this.tmp2.height);
    g2.drawImage(this.noise, 0, nh - scroll, fw, nh);
    g2.drawImage(this.noise, 0, -scroll, fw, nh);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(this.tmp2, 0, 0, fw, fh, 0, 0, fw, fh);
    // 色: 文字のところは黄、その上は橙、炎の先は赤から透明へ
    g.globalCompositeOperation = 'source-in';
    const gy = (v) => Math.max(0, Math.min(1, v / fh));
    const gr = g.createLinearGradient(0, fh, 0, 0);
    gr.addColorStop(0, 'rgba(255,240,170,1)');
    gr.addColorStop(gy(H * 0.55), 'rgba(255,200,80,1)');
    gr.addColorStop(gy(H * 0.85), 'rgba(255,120,30,0.95)');
    gr.addColorStop(gy(H * 0.85 + size * 0.55), 'rgba(235,45,15,0.85)');
    gr.addColorStop(1, 'rgba(140,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, fw, fh);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (flame > 0.01) {
      ctx.globalAlpha = clamp01(flame * 1.1);
      ctx.drawImage(this.tmp, 0, 0, fw, fh, x - W / 2, y - H / 2 - (fh - H), fw, fh);
    }
    // 2) 赤熱の光（文字の形のまわりがにじむ）
    if (heat > 0.01) {
      ctx.globalAlpha = clamp01(heat * 0.55);
      ctx.shadowColor = 'rgba(255,60,20,0.95)'; ctx.shadowBlur = size * 0.45;
      ctx.drawImage(this._tinted(ch, size, '255,70,25'), x - W / 2, y - H / 2);
      ctx.shadowColor = 'transparent';
    }
    ctx.restore();
    // 3) 文字そのもの: 縁取りを残し、内部が赤熱（白黄 → 橙 → 赤）。読める状態を保つ
    if (showGlyph && heat > 0.01) {
      const c = this._hot(ch, Math.round(size));
      ctx.globalAlpha = clamp01(0.35 + heat);
      ctx.drawImage(c, x - c.width / 2, y - c.height / 2);
      ctx.globalAlpha = 1;
    }
    // 4) 火の粉（文字から舞い上がる小さな光。余韻）
    if (u != null) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const cnt = Math.round(10 * I);
      for (let i = 0; i < cnt; i++) {
        const s = seed * 13.1 + i;
        const life = 0.5 + 0.5 * hash(s);
        const v = u / life;
        if (v > 1) continue;
        const px = x + (hash(s + 1) - 0.5) * size * 0.9 + Math.sin(v * 6 + i) * size * 0.08;
        const py = y - size * 0.1 - v * size * (1.2 + hash(s + 2));
        const r = Math.max(1.2, size * 0.055 * (1 - v));
        ctx.globalAlpha = clamp01((1 - v) * (0.6 + 0.4 * Math.sin(t * 30 + i)));
        ctx.fillStyle = i % 3 ? 'rgb(255,150,50)' : 'rgb(255,230,150)';
        ctx.fillRect(px - r / 2, py - r, r, r * 1.6);
      }
      ctx.restore();
    }
  }

  _tinted(ch, size, rgb) {
    const key = `t|${ch}|${Math.round(size)}|${rgb}`;
    let c = this.cache.get(key);
    if (!c) {
      const m = this.mask(ch, Math.round(size));
      c = canvas(m.width, m.height);
      const g = c.getContext('2d');
      g.drawImage(m, 0, 0);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = `rgb(${rgb})`; g.fillRect(0, 0, c.width, c.height);
      this._put(key, c);
    }
    return c;
  }

  /** 赤熱した文字（黒い縁取り＋白黄 → 橙 → 赤の内部） */
  _hot(ch, size) {
    const key = `h|${ch}|${size}`;
    let c = this.cache.get(key);
    if (!c) {
      const pad = Math.ceil(size * PAD);
      c = canvas(size + pad * 2, size + pad * 2);
      const g = c.getContext('2d');
      const { x, y } = place(g, ch, c.width / 2, c.height / 2, size);
      g.strokeStyle = 'rgba(40,4,0,0.92)'; g.lineWidth = Math.max(2.5, size * (0.13 + BOLD));
      g.strokeText(ch, x, y);
      g.strokeStyle = 'rgb(255,60,20)'; g.lineWidth = Math.max(1, size * (0.04 + BOLD));
      g.strokeText(ch, x, y);
      const gr = g.createLinearGradient(0, y - size / 2, 0, y + size / 2);
      gr.addColorStop(0, '#fff6c8'); gr.addColorStop(0.45, '#ffb040'); gr.addColorStop(1, '#ff3a10');
      g.fillStyle = gr;
      g.fillText(ch, x, y);
      this._put(key, c);
    }
    return c;
  }
}
