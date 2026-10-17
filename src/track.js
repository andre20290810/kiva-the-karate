// 譜面レーン（次に押すボタンが判定位置へ近づく表示）。
// ノーツはボタンと同じ色・同じ文字（A/B/X/Y）と、ひし形内の位置を示す小さな印で描く。
// horizontal: 右→左へ流れる（縦画面） / vertical: 上→下へ流れる（横画面の右パネル）

export class TrackRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {ReturnType<import('./controls.js').buildControlMap>} map
   */
  constructor(canvas, map, { lookahead = 2.2 } = {}) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.map = map;
    this.lookahead = lookahead;
    this.flashes = [];
    this.bursts = [];
    this.orbCache = new Map();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height); this.dpr = dpr;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.vertical = this.h > this.w * 1.2;
    this.orbCache.clear();
  }

  /** 判定結果の表示（音声時刻で管理） */
  mark(result, t, button = null) {
    this.flashes.push({ result, t });
    if (button) this.bursts.push({ result, t, button });
  }

  /** 光沢のある球体のノーツ（ボタンごとに1回だけ描いて使い回す） */
  _orb(button, R) {
    const key = `${button}:${Math.round(R * this.dpr)}`;
    let c = this.orbCache.get(key);
    if (c) return c;
    const e = this.map.byButton.get(button);
    const s = Math.ceil(R * 2.6 * this.dpr);
    c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    g.scale(this.dpr, this.dpr);
    const m = (R * 2.6) / 2;
    // 外周の発光
    const glow = g.createRadialGradient(m, m, R * 0.7, m, m, R * 1.3);
    glow.addColorStop(0, `rgba(${e.glow},0.55)`); glow.addColorStop(1, `rgba(${e.glow},0)`);
    g.fillStyle = glow; g.beginPath(); g.arc(m, m, R * 1.3, 0, Math.PI * 2); g.fill();
    // 本体（球面の陰影）
    const body = g.createRadialGradient(m - R * 0.35, m - R * 0.45, R * 0.1, m, m, R);
    body.addColorStop(0, '#ffffff'); body.addColorStop(0.18, e.color); body.addColorStop(0.75, shade(e.color, 0.55)); body.addColorStop(1, shade(e.color, 0.3));
    g.fillStyle = body; g.beginPath(); g.arc(m, m, R, 0, Math.PI * 2); g.fill();
    // 金属リング
    g.lineWidth = Math.max(1.5, R * 0.12);
    const ring = g.createLinearGradient(m, m - R, m, m + R);
    ring.addColorStop(0, '#f4f7ff'); ring.addColorStop(0.5, '#5d6476'); ring.addColorStop(1, '#c9d0e0');
    g.strokeStyle = ring; g.beginPath(); g.arc(m, m, R * 0.94, 0, Math.PI * 2); g.stroke();
    // 文字
    g.font = `900 ${Math.round(R * 1.05)}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillText(button, m + R * 0.05, m + R * 0.1);
    g.fillStyle = '#fff'; g.fillText(button, m, m + R * 0.03);
    // ひし形内の位置（上=Y 左=X 右=B 下=A）
    const [dx, dy] = e.dir;
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath(); g.arc(m + dx * R * 0.66, m + dy * R * 0.66, Math.max(1.4, R * 0.1), 0, Math.PI * 2); g.fill();
    this.orbCache.set(key, c);
    return c;
  }

  draw(now, notes) {
    const { g, w, h, dpr } = this;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const V = this.vertical;
    const len = V ? h : w;
    const thick = V ? w : h;
    const hitPos = len * (V ? 0.86 : 0.13);
    const pos = (dt) => (V ? hitPos - (dt / this.lookahead) * hitPos : hitPos + (dt / this.lookahead) * (len - hitPos));
    const xy = (p) => (V ? [thick / 2, p] : [p, thick / 2]);
    const R = Math.min(thick * 0.34, 26);

    // レーン（奥行きのあるガイド）
    const lane = V ? g.createLinearGradient(0, 0, 0, h) : g.createLinearGradient(w, 0, 0, 0);
    lane.addColorStop(0, 'rgba(60,140,255,0)'); lane.addColorStop(0.7, 'rgba(60,140,255,0.10)'); lane.addColorStop(1, 'rgba(60,140,255,0.18)');
    g.fillStyle = lane;
    if (V) g.fillRect(thick / 2 - R * 1.2, 0, R * 2.4, h); else g.fillRect(0, thick / 2 - R * 1.2, w, R * 2.4);
    g.strokeStyle = 'rgba(120,190,255,0.25)';
    g.lineWidth = 1;
    g.beginPath();
    if (V) { g.moveTo(thick / 2 - R * 1.2, 0); g.lineTo(thick / 2 - R * 1.2, h); g.moveTo(thick / 2 + R * 1.2, 0); g.lineTo(thick / 2 + R * 1.2, h); }
    else { g.moveTo(0, thick / 2 - R * 1.2); g.lineTo(w, thick / 2 - R * 1.2); g.moveTo(0, thick / 2 + R * 1.2); g.lineTo(w, thick / 2 + R * 1.2); }
    g.stroke();

    // 判定位置
    const [hx, hy] = xy(hitPos);
    const pulse = 0.5 + 0.5 * Math.cos((now % 0.5) / 0.5 * Math.PI * 2);
    g.save();
    g.shadowColor = 'rgba(120,200,255,0.9)';
    g.shadowBlur = 10 + pulse * 6;
    g.strokeStyle = 'rgba(230,245,255,0.95)';
    g.lineWidth = 3;
    g.beginPath(); g.arc(hx, hy, R * 1.08, 0, Math.PI * 2); g.stroke();
    g.restore();
    g.strokeStyle = 'rgba(120,200,255,0.5)';
    g.lineWidth = 1;
    g.beginPath(); g.arc(hx, hy, R * 1.32, 0, Math.PI * 2); g.stroke();

    // 判定の光（成功はボタン色の輪、失敗は寒色のひび）
    this.bursts = this.bursts.filter((b) => now - b.t < 0.35 && b.t <= now + 0.05);
    for (const b of this.bursts) {
      const k = Math.max(0, (now - b.t) / 0.35);
      const e = this.map.byButton.get(b.button);
      if (!e) continue;
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 1 - k;
      if (b.result === 'MISS') {
        g.strokeStyle = 'rgba(120,150,220,0.9)';
        g.lineWidth = 2;
        for (let i = 0; i < 5; i++) {
          const a = i * 1.3 + 0.4;
          g.beginPath(); g.moveTo(hx, hy); g.lineTo(hx + Math.cos(a) * R * (1 + k), hy + Math.sin(a) * R * (1 + k)); g.stroke();
        }
      } else {
        g.strokeStyle = e.color;
        g.lineWidth = (b.result === 'PERFECT' ? 5 : 3) * (1 - k) + 1;
        g.beginPath(); g.arc(hx, hy, R * (1.05 + k * 0.9), 0, Math.PI * 2); g.stroke();
        const glow = g.createRadialGradient(hx, hy, 0, hx, hy, R * 2);
        glow.addColorStop(0, `rgba(${e.glow},${b.result === 'PERFECT' ? 0.8 : 0.45})`); glow.addColorStop(1, `rgba(${e.glow},0)`);
        g.fillStyle = glow; g.beginPath(); g.arc(hx, hy, R * 2, 0, Math.PI * 2); g.fill();
      }
      g.restore();
    }

    // ノーツ（遠いものから描く）
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      const dt = n.t - now;
      if (dt > this.lookahead || dt < -0.35) continue;
      if (n.result && n.result !== 'MISS') continue;
      const btn = this.map.buttonFor(n.cmd);
      if (!btn) continue;
      const [x, y] = xy(pos(dt));
      const orb = this._orb(btn, R);
      const s = orb.width / this.dpr;
      // 判定位置に近づくほど大きく・明るく
      const near = 1 - Math.min(1, Math.max(0, dt) / this.lookahead);
      const sc = 0.82 + near * 0.18;
      g.globalAlpha = n.result === 'MISS' ? 0.25 : 0.55 + near * 0.45;
      g.drawImage(orb, x - (s * sc) / 2, y - (s * sc) / 2, s * sc, s * sc);
      g.globalAlpha = 1;
    }

    // 判定文字はステージ上部の DOM（#judgeText）に表示（ノーツと重ねない）
    this.flashes = this.flashes.filter((f) => now - f.t < 0.5 && f.t <= now + 0.05);
    const f = this.flashes[this.flashes.length - 1];
    if (this.judgeEl) {
      const txt = f && f.t <= now ? f.result : '';
      if (this.judgeEl.textContent !== txt) { this.judgeEl.textContent = txt; this.judgeEl.dataset.r = txt; }
      this.judgeEl.style.opacity = f ? String(Math.max(0, 1 - (now - f.t) / 0.5)) : '0';
    }
  }
}

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * k), g = Math.round(((n >> 8) & 255) * k), b = Math.round((n & 255) * k);
  return `rgb(${r},${g},${b})`;
}
