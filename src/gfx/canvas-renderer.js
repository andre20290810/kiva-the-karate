// Canvas2D フォールバック（WebGL2 非対応環境）。GLRenderer と同じフレーム情報を描く。
// 光の形はあらかじめ描いたスプライト（ぼかした円・光条）を加算合成で重ね、線や楕円だけの見た目を避ける。

import { KIND, STRIDE } from './batch.js';

function sprite(size, draw) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  draw(c.getContext('2d'), size);
  return c;
}

export class CanvasRenderer {
  constructor(canvas) {
    this.kind = 'canvas2d';
    this.canvas = canvas;
    this.g = canvas.getContext('2d', { alpha: false });
    this.glow = sprite(128, (g, s) => {
      const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,255,255,0.55)');
      r.addColorStop(0.6, 'rgba(255,255,255,0.12)'); r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r; g.fillRect(0, 0, s, s);
    });
    this.streak = sprite(128, (g, s) => {
      const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.4, 'rgba(255,255,255,0.35)'); r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r; g.fillRect(0, 0, s, s);
    });
    this.tintCache = new Map();
  }

  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
  }

  _tinted(src, rgb) {
    const key = src === this.glow ? 'g' : 's';
    const k = `${key}${Math.round(rgb[0] * 8)},${Math.round(rgb[1] * 8)},${Math.round(rgb[2] * 8)}`;
    let c = this.tintCache.get(k);
    if (!c) {
      c = sprite(src.width, (g, s) => {
        g.drawImage(src, 0, 0);
        g.globalCompositeOperation = 'source-in';
        g.fillStyle = `rgb(${rgb.map((v) => Math.round(Math.min(1, v) * 255)).join(',')})`;
        g.fillRect(0, 0, s, s);
      });
      if (this.tintCache.size > 400) this.tintCache.clear();
      this.tintCache.set(k, c);
    }
    return c;
  }

  _floor(f) {
    const { g, w, h } = this;
    const { st } = f;
    const hy = st.horizonY;
    const sky = g.createLinearGradient(0, 0, 0, hy);
    sky.addColorStop(0, '#03040a'); sky.addColorStop(0.75, '#0a1024'); sky.addColorStop(1, '#1a2850');
    g.fillStyle = sky; g.fillRect(0, 0, w, hy);
    const fl = g.createLinearGradient(0, hy, 0, h);
    fl.addColorStop(0, '#131a30'); fl.addColorStop(0.25, '#0d1018'); fl.addColorStop(1, '#151820');
    g.fillStyle = fl; g.fillRect(0, hy, w, h - hy);
    // 床面のスポット反射
    const sp = st.project(f.charX, f.charZ);
    if (sp) {
      const r = g.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, w * 0.4);
      r.addColorStop(0, 'rgba(110,130,170,0.35)'); r.addColorStop(1, 'rgba(110,130,170,0)');
      g.fillStyle = r; g.fillRect(0, hy, w, h - hy);
    }
    // 横方向ネオン（手前へ流れる）
    const P = st.p.panel * st.p.neonEvery;
    const off = f.scroll % P;
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let z = P - off; z < 50; z += P) {
      if (z < st.p.near) continue;
      const a = st.project(-40, z), b = st.project(40, z);
      const fog = Math.exp(-z * f.q.fog);
      g.strokeStyle = `rgba(30,190,255,${0.75 * fog})`;
      g.lineWidth = Math.max(1, a.k * 0.03);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
    // パネルの継ぎ目（細い横線）
    for (let z = st.p.panel - (f.scroll % st.p.panel); z < 30; z += st.p.panel) {
      if (z < st.p.near) continue;
      const a = st.project(-40, z), b = st.project(40, z);
      g.strokeStyle = `rgba(0,0,0,${0.35 * Math.exp(-z * 0.05)})`;
      g.globalCompositeOperation = 'source-over';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      g.globalCompositeOperation = 'lighter';
    }
    // 縦方向（消失点へ収束）
    for (let x = -12; x <= 12; x += st.p.panel) {
      const a = st.project(x, st.p.near + 0.01), b = st.project(x, 60);
      const neon = Math.abs(Math.abs(x) - st.p.corridor * 0.55) < 0.6;
      g.strokeStyle = neon ? 'rgba(255,80,190,0.55)' : 'rgba(255,255,255,0.05)';
      g.lineWidth = neon ? 2 : 1;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
    // 床面の衝撃伝播
    for (const p of f.pulses) {
      const r = p.age * 16;
      const life = 1 - Math.min(1, p.age / 1.1);
      const N = 40;
      g.strokeStyle = `rgba(255,190,90,${0.8 * life * p.strength})`;
      g.lineWidth = 3;
      g.beginPath();
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        const s = st.project(p.x + Math.cos(a) * r, Math.max(st.p.near + 0.05, p.z + Math.sin(a) * r));
        if (i) g.lineTo(s.x, s.y); else g.moveTo(s.x, s.y);
      }
      g.stroke();
    }
    // 地平線の発光
    const hg = g.createLinearGradient(0, hy - 30, 0, hy + 20);
    hg.addColorStop(0, 'rgba(40,120,255,0)'); hg.addColorStop(0.6, 'rgba(40,120,255,0.35)'); hg.addColorStop(1, 'rgba(40,120,255,0)');
    g.fillStyle = hg; g.fillRect(0, hy - 30, w, 50);
    g.restore();
  }

  _quads(list) {
    const { g } = this;
    for (const q of list) {
      const [a, b, c, d] = q.pts;
      g.globalAlpha = q.alpha;
      const fog = q.fog;
      const shade = Math.round(24 * q.shade * (1 - fog) + 18 * fog);
      g.fillStyle = `rgb(${shade},${shade + 3},${shade + 12})`;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.lineTo(c.x, c.y); g.lineTo(d.x, d.y); g.closePath(); g.fill();
      g.strokeStyle = q.kind === 'gate' || q.kind === 'beam' ? `rgba(255,80,190,${0.8 * (1 - fog)})` : `rgba(40,190,255,${0.8 * (1 - fog)})`;
      g.lineWidth = 1.5;
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  _sprites(batch) {
    const { g } = this;
    const d = batch.data;
    for (let i = 0; i < batch.count; i++) {
      const o = i * STRIDE;
      const x = d[o], y = d[o + 1], w = d[o + 2], h = d[o + 3], rot = d[o + 4], kind = d[o + 5];
      const rgb = [d[o + 9], d[o + 10], d[o + 11]];
      const a = Math.min(1, d[o + 12]);
      const add = d[o + 13] > 0.5;
      g.save();
      g.globalCompositeOperation = add ? 'lighter' : 'source-over';
      g.globalAlpha = a;
      g.translate(x, y);
      g.rotate(rot);
      switch (kind) {
        case KIND.RING: case KIND.ARC: {
          const th = Math.max(0.01, d[o + 6]);
          g.scale(1, h / w);
          const span = kind === KIND.ARC ? d[o + 7] : Math.PI * 2;
          const col = `rgb(${rgb.map((v) => Math.round(Math.min(1, v) * 255)).join(',')})`;
          g.strokeStyle = col;
          g.lineWidth = Math.max(1, (w / 2) * th * 2.2);
          g.beginPath(); g.arc(0, 0, (w / 2) * (1 - th * 1.6), -span / 2, span / 2); g.stroke();
          g.globalAlpha = a * 0.35;
          g.lineWidth *= 3.5;
          g.stroke();
          break;
        }
        case KIND.SHARD: {
          g.fillStyle = `rgb(${rgb.map((v) => Math.round(Math.min(1, v) * 255)).join(',')})`;
          g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(-w * 0.4, h / 2); g.lineTo(-w * 0.28, -h / 2); g.closePath(); g.fill();
          break;
        }
        case KIND.STREAK: case KIND.SPARK:
          g.drawImage(this._tinted(this.streak, rgb), -w / 2, -h, w, h * 2);
          break;
        case KIND.CORE: {
          const t = this._tinted(this.glow, [1, 1, 1]);
          g.drawImage(t, -w / 2, -h / 2, w, h);
          g.drawImage(this._tinted(this.streak, rgb), -w, -h * 0.06, w * 2, h * 0.12);
          g.drawImage(this._tinted(this.streak, rgb), -w * 0.06, -h, w * 0.12, h * 2);
          break;
        }
        default:
          g.drawImage(this._tinted(this.glow, rgb), -w / 2, -h / 2, w, h);
      }
      g.restore();
    }
  }

  render(f) {
    const { g, dpr } = this;
    const { sig } = f;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.save();
    g.translate(sig.sx, sig.sy);
    this._floor(f);
    this._quads(f.world.behind);
    this._sprites(f.dustBehind);
    const ch = f.character;
    if (ch && ch.bmp) {
      this._sprites(f.under);
      const r = ch.rect;
      for (const gh of ch.ghosts) {
        if (!gh.bmp) continue;
        g.save(); g.globalAlpha = gh.alpha * 0.6; g.globalCompositeOperation = 'lighter';
        g.drawImage(gh.bmp, r.x, r.y, r.w, r.h); g.restore();
      }
      g.drawImage(ch.bmp, r.x, r.y, r.w, r.h);
    }
    this._quads(f.world.front);
    this._sprites(f.dustFront);
    this._sprites(f.fx);
    g.restore();
    if (sig.flash > 0) { g.fillStyle = `rgba(255,240,215,${sig.flash * 0.5})`; g.fillRect(0, 0, this.w, this.h); }
    if (sig.cold > 0) { g.fillStyle = `rgba(40,80,160,${sig.cold * 0.18})`; g.fillRect(0, 0, this.w, this.h); }
    const v = g.createRadialGradient(this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.3, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.75);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.6)');
    g.fillStyle = v; g.fillRect(0, 0, this.w, this.h);
  }

  dispose() { this.tintCache.clear(); }
}
