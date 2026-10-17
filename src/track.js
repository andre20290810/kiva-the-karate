// 譜面レーン（次に押すコマンドが判定位置へ近づく表示）。
// horizontal: 右→左へ流れる / vertical: 上→下へ流れる（横画面の右パネル用）

export class TrackRenderer {
  constructor(canvas, commands, { lookahead = 2.2 } = {}) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.commands = commands;
    this.lookahead = lookahead;
    this.flashes = [];
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height); this.dpr = dpr;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.vertical = this.h > this.w * 1.2;
  }

  /** 判定結果の表示（音声時刻で管理） */
  mark(result, t) { this.flashes.push({ result, t }); }

  draw(now, notes) {
    const { g, w, h, dpr } = this;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const V = this.vertical;
    const len = V ? h : w;
    const thick = V ? w : h;
    const hitPos = len * (V ? 0.85 : 0.14);
    const pos = (dt) => (V ? hitPos - (dt / this.lookahead) * hitPos : hitPos + (dt / this.lookahead) * (len - hitPos));
    const xy = (p) => (V ? [thick / 2, p] : [p, thick / 2]);

    g.fillStyle = 'rgba(255,255,255,0.06)';
    if (V) g.fillRect(thick * 0.15, 0, thick * 0.7, h); else g.fillRect(0, thick * 0.15, w, thick * 0.7);

    // 判定位置
    const [hx, hy] = xy(hitPos);
    const R = thick * 0.34;
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 3;
    g.beginPath(); g.arc(hx, hy, R, 0, Math.PI * 2); g.stroke();

    const cmdIndex = new Map(this.commands.map((c, i) => [c.id, i]));
    for (const n of notes) {
      const dt = n.t - now;
      if (dt > this.lookahead || dt < -0.4) continue;
      if (n.result && n.result !== 'MISS') continue;
      const c = this.commands[cmdIndex.get(n.cmd)];
      const [x, y] = xy(pos(dt));
      const missed = n.result === 'MISS';
      g.globalAlpha = missed ? 0.3 : 1;
      g.fillStyle = c.color || '#fc6';
      g.beginPath(); g.arc(x, y, R * 0.86, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#111';
      g.font = `bold ${Math.round(R * 0.95)}px system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(c.label, x, y + 1);
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
