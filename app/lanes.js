// 背景上部の 4 レーン（上から Y・X・A・B）。ノーツは右から左へ流れ、共通の判定位置で押す。
// ノーツの位置は「判定時刻までの残り時間 ÷ 先読み時間」だけで決める（縦横でレーンの長さが変わってもタイミングは同じ）。

import { BUTTON_INFO } from './chart.js';

export const LANE_ORDER = ['Y', 'X', 'A', 'B'];
export const LANE_STYLE = Object.freeze({
  Y: { color: '#ffc531', rgb: '255,197,49' },
  X: { color: '#3d97ff', rgb: '61,151,255' },
  A: { color: '#2fdc7c', rgb: '47,220,124' },
  B: { color: '#ff4d5e', rgb: '255,77,94' },
});
const GRADE_TEXT = { PERFECT: 'PERFECT', GOOD: 'GOOD', MISS: 'MISS' };
const GRADE_COLOR = { PERFECT: '#ffe17a', GOOD: '#9fe7ff', MISS: '#ff7a7a' };

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class LaneRenderer {
  constructor() {
    this.marks = []; // 判定の文字（時間軸の時刻で寿命管理）
    this.pressed = { Y: 0, X: 0, A: 0, B: 0 }; // 押した表示（時刻）
  }

  clear() { this.marks = []; }

  mark(grade, t, button, delta) { this.marks.push({ grade, t, button, delta }); if (this.marks.length > 12) this.marks.shift(); }

  /**
   * @param ctx 2D コンテキスト（CSS px）
   * @param L   laneRect
   * @param t   現在時刻
   * @param notes Judge.notes（result/holding を持つ）
   * @param o   {lead, judge, held:{Y:bool...}, selected:Set<id>, edit:bool}
   */
  draw(ctx, L, t, notes, o) {
    const { rowH } = L;
    const labelW = Math.min(118, Math.max(58, L.w * 0.16));
    const jx = L.x + labelW + rowH * 0.6; // 判定位置
    const right = L.x + L.w - 6;
    const lead = o.lead;
    const xAt = (time) => jx + ((time - t) / lead) * (right - jx);
    ctx.save();
    ctx.font = `600 ${Math.round(rowH * 0.42)}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`;
    ctx.textBaseline = 'middle';
    // レーンの面（半透明。人物が見えるように）
    rr(ctx, L.x, L.y, L.w, L.h, 8);
    ctx.fillStyle = `rgba(12,8,5,${L.panelAlpha ?? 0.6})`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,230,200,0.18)'; ctx.lineWidth = 1; ctx.stroke();
    LANE_ORDER.forEach((b, k) => {
      const y = L.y + k * rowH, st = LANE_STYLE[b];
      const held = o.held?.[b];
      if (k) { ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(L.x + 4, y, L.w - 8, 1); }
      if (held) { ctx.fillStyle = `rgba(${st.rgb},0.14)`; ctx.fillRect(L.x + 2, y + 1, L.w - 4, rowH - 2); }
      // ラベル: 丸いボタン文字 ＋ 意味（色だけに頼らない）
      const r = rowH * 0.36, cx = L.x + 8 + r, cy = y + rowH / 2;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = held ? st.color : `rgba(${st.rgb},0.28)`; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = st.color; ctx.stroke();
      ctx.fillStyle = held ? '#111' : '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(b, cx, cy + 1);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.86)';
      if (labelW > 70) ctx.fillText(BUTTON_INFO[b].meaning, cx + r + 6, cy + 1);
    });
    // 判定位置の線
    ctx.fillStyle = 'rgba(255,240,210,0.9)';
    ctx.fillRect(jx - 1.5, L.y + 3, 3, L.h - 6);
    ctx.save();
    ctx.beginPath(); ctx.rect(jx - rowH * 0.5, L.y, right - jx + rowH * 0.5 + 6, L.h); ctx.clip();
    // ノーツ
    for (const n of notes) {
      const end = n.time + (n.duration || 0);
      if (end < t - 0.6 || n.time > t + lead + 0.1) continue;
      const k = LANE_ORDER.indexOf(n.button), st = LANE_STYLE[n.button];
      const y = L.y + k * rowH + rowH / 2, h = rowH * 0.66;
      const done = n.result && n.result !== 'SKIP';
      const hit = n.result === 'PERFECT' || n.result === 'GOOD';
      if (hit && n.input !== 'hold') continue; // 成功したノーツは消す（判定位置に文字が出る）
      const sel = o.selected?.has(n.id);
      const alpha = n.result === 'MISS' ? 0.35 : n.result === 'SKIP' ? 0.25 : 1;
      ctx.globalAlpha = alpha;
      if (n.input === 'hold') {
        const x0 = Math.max(xAt(n.time), n.holding || hit ? jx : -1e9), x1 = xAt(end);
        if (!(hit && t > end)) {
          rr(ctx, x0, y - h * 0.32, Math.max(4, x1 - x0), h * 0.64, h * 0.3);
          ctx.fillStyle = `rgba(${st.rgb},${n.holding ? 0.75 : 0.42})`; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = st.color; ctx.stroke();
          // 長押しの残り
          if (n.holding) {
            const prog = Math.max(0, Math.min(1, (t - n.time) / n.duration));
            ctx.fillStyle = '#fff';
            ctx.fillText(`HOLD ${(Math.max(0, end - t)).toFixed(1)}s`, Math.min(x1 + 6, right - 80), y + 1);
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.fillRect(jx, y + h * 0.36, (x1 - jx) * (1 - prog) + 0, 2);
          }
          // 終点
          ctx.fillStyle = st.color; ctx.fillRect(x1 - 2, y - h * 0.4, 4, h * 0.8);
        }
        if (!n.holding && !hit) this._head(ctx, xAt(n.time), y, h, n, st, sel, 'HOLD');
      } else {
        this._head(ctx, xAt(n.time), y, h, n, st, sel, n.button === 'A' ? (n.action === 'kick' ? '蹴り' : n.action === 'punch' ? '突き' : '打') : null);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    // 判定の文字（判定位置の右上）
    for (const m of this.marks) {
      const age = t - m.t;
      if (age < -0.05 || age > 0.7) continue;
      const k = LANE_ORDER.indexOf(m.button);
      const y = L.y + Math.max(0, k) * rowH + rowH / 2 - age * rowH * 0.6;
      ctx.globalAlpha = Math.max(0, 1 - age / 0.7);
      ctx.font = `800 ${Math.round(rowH * 0.5)}px system-ui, sans-serif`;
      ctx.fillStyle = GRADE_COLOR[m.grade] || '#ccc';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 3;
      const txt = GRADE_TEXT[m.grade] || m.grade;
      ctx.strokeText(txt, jx + rowH * 0.6, y);
      ctx.fillText(txt, jx + rowH * 0.6, y);
    }
    ctx.restore();
    return { jx, xAt, right };
  }

  _head(ctx, x, y, h, n, st, sel, sub) {
    const w = h * 0.95;
    rr(ctx, x - w / 2, y - h / 2, w, h, h * 0.28);
    const g = ctx.createLinearGradient(0, y - h / 2, 0, y + h / 2);
    g.addColorStop(0, '#fff'); g.addColorStop(0.18, st.color); g.addColorStop(1, `rgba(${st.rgb},0.8)`);
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = sel ? 3 : 1.5; ctx.strokeStyle = sel ? '#fff' : 'rgba(0,0,0,0.6)'; ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.font = `800 ${Math.round(h * 0.5)}px system-ui, sans-serif`;
    ctx.fillText(n.button, x, y + 1);
    if (sub) {
      ctx.font = `700 ${Math.round(h * 0.34)}px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif`;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.lineWidth = 3;
      ctx.strokeText(sub, x, y + h * 0.78);
      ctx.fillText(sub, x, y + h * 0.78);
    }
    ctx.textAlign = 'left';
  }
}
