// ステージと人物の描画。
// 人物はフレームごとに個別拡大せず、共通のカメラ（全フレームの人物領域の和集合に合わせた
// 1つの拡大率と基準点）で元画像をそのまま配置する。元映像の踏み込みや移動はそのまま残る。
// 譜面の camera.keys で区間ごとの基準点・拡大率を指定でき、その間は滑らかに補間する。

export class StageRenderer {
  constructor(canvas, frameStore, cameraDef = {}) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.frames = frameStore;
    this.view = { w: 1, h: 1, dpr: 1 };
    this.base = this._unionBox(cameraDef.margin ?? 0.06);
    this.keys = (cameraDef.keys || []).slice().sort((a, b) => a.t - b.t);
    this.debug = false;
  }

  _unionBox(margin) {
    const { width: W, height: H } = this.frames.def;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of this.frames.frames) {
      if (!f.bbox) continue;
      const [x, y, w, h] = f.bbox;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
    }
    if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = W; y1 = H; }
    const mw = (x1 - x0) * margin, mh = (y1 - y0) * margin;
    return { x0: x0 - mw, y0: y0 - mh, x1: x1 + mw, y1: y1 + mh };
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.view = { w: Math.max(1, r.width), h: Math.max(1, r.height), dpr };
    this.canvas.width = Math.round(this.view.w * dpr);
    this.canvas.height = Math.round(this.view.h * dpr);
  }

  /** 区間カメラ（元画像座標の注視枠）を時刻で補間 */
  _box(t) {
    const b = this.base;
    if (!this.keys.length) return b;
    const toBox = (k) => ({ x0: k.box[0], y0: k.box[1], x1: k.box[0] + k.box[2], y1: k.box[1] + k.box[3] });
    if (t <= this.keys[0].t) return toBox(this.keys[0]);
    for (let i = 0; i < this.keys.length - 1; i++) {
      const a = this.keys[i], c = this.keys[i + 1];
      if (t < c.t) {
        const u = (t - a.t) / (c.t - a.t);
        const s = u * u * (3 - 2 * u); // smoothstep
        const A = toBox(a), C = toBox(c);
        return { x0: A.x0 + (C.x0 - A.x0) * s, y0: A.y0 + (C.y0 - A.y0) * s, x1: A.x1 + (C.x1 - A.x1) * s, y1: A.y1 + (C.y1 - A.y1) * s };
      }
    }
    return toBox(this.keys[this.keys.length - 1]);
  }

  camera(t) {
    const { w, h } = this.view;
    const b = this._box(t);
    const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    const scale = Math.min(w / bw, h / bh);
    // 注視枠の下端（足元）を画面下寄りに、左右中央に置く
    const ox = w / 2 - (b.x0 + bw / 2) * scale;
    const oy = h - (h - bh * scale) * 0.35 - b.y1 * scale;
    return {
      scale, ox, oy,
      toScreen: (x, y) => ({ x: ox + x * scale, y: oy + y * scale }),
    };
  }

  drawStage(g, w, h, pulse) {
    g.fillStyle = '#07080c';
    g.fillRect(0, 0, w, h);
    const floorY = h * 0.84;
    const spot = g.createRadialGradient(w / 2, h * 0.55, 0, w / 2, h * 0.55, Math.max(w, h) * 0.65);
    spot.addColorStop(0, `rgba(70,74,92,${0.55 + 0.15 * pulse})`);
    spot.addColorStop(1, 'rgba(10,10,16,0)');
    g.fillStyle = spot;
    g.fillRect(0, 0, w, h);
    const floor = g.createLinearGradient(0, floorY, 0, h);
    floor.addColorStop(0, 'rgba(60,50,40,0.35)');
    floor.addColorStop(1, 'rgba(20,16,12,0.6)');
    g.fillStyle = floor;
    g.fillRect(0, floorY, w, h - floorY);
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    g.lineWidth = 1;
    for (let i = -6; i <= 6; i++) {
      g.beginPath();
      g.moveTo(w / 2 + i * w * 0.02, floorY);
      g.lineTo(w / 2 + i * w * 0.16, h);
      g.stroke();
    }
  }

  /**
   * @param {number} songTime
   * @param {number} videoTime timewarp で求めた元動画時刻
   * @param {import('./effects.js').Effects} effects
   */
  draw(songTime, videoTime, effects, { pulse = 0, info = null } = {}) {
    const { g } = this;
    const { w, h, dpr } = this.view;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawStage(g, w, h, pulse);
    const cam = this.camera(songTime);
    const idx = this.frames.indexAt(videoTime);
    this.frames.prefetch(idx);
    const { width: W, height: H } = this.frames.def;
    const drawFrame = (fi, alpha, tint) => {
      const fr = this.frames.get(fi);
      if (!fr) return null;
      g.save();
      g.globalAlpha = alpha;
      if (tint) g.filter = tint;
      g.drawImage(fr.bmp, cam.ox, cam.oy, W * cam.scale, H * cam.scale);
      g.restore();
      return fr;
    };
    effects.drawBehind(g, songTime, cam, (e, a) => {
      drawFrame(this.frames.indexAt(e.videoTime), 0.22 * a, 'brightness(1.6) sepia(1) hue-rotate(170deg) saturate(3)');
    });
    const shown = drawFrame(idx, 1);
    effects.drawFront(g, songTime, cam, this.view);
    this.lastShown = shown ? shown.index : -1;
    this.lastCam = cam;
    if (this.debug && info) {
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(6, 6, 230, 74);
      g.fillStyle = '#9fe';
      g.font = '12px ui-monospace, monospace';
      const lines = [
        `song ${songTime.toFixed(3)}s  video ${videoTime.toFixed(3)}s`,
        `frame ${idx}${shown && !shown.exact ? ` (代用 ${shown.index})` : ''} / ${this.frames.count}  5fps`,
        `rate ${info.rate?.toFixed(2)}x  decoded ${this.frames.bitmaps.size}`,
        info.extra || '',
      ];
      lines.forEach((s, i) => g.fillText(s, 12, 22 + i * 16));
    }
    return cam;
  }
}
