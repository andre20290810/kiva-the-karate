// 背景上部の 4 レーン（上から Y・X・A・B）。ノーツは右から左へ流れ、共通の判定位置で押す。
// ノーツの位置は「判定時刻までの残り時間 ÷ 先読み時間」だけで決める（縦横でレーンの長さが変わってもタイミングは同じ）。

import { GlyphRenderer } from './glyphfire.js';
import { GAME } from './config.js';

/** レーンの文字（入力の割り当て Y・X・A・B は変えない） */
export const GLYPH = GAME.glyphs;

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
    this.glyph = new GlyphRenderer();
  }

  clear() { this.marks = []; this.glyph.clear(); }

  /** 成功: 判定位置の文字に火を灯す（t0 = 効果音の最も強い瞬間）。strong: 長押しの完了 */
  ignite(button, t0, grade, strong = false) {
    if (strong) this.glyph.holdDone();
    this.glyph.ignite(button, GLYPH[button], t0, grade, strong);
  }

  /** 長押しの始端と終端を結ぶ直線（レーンに平行。保持中は明るく） */
  _holdLine(ctx, x0, x1, y, S, st, active) {
    const a = x0 + S * 0.42, b = x1 - S * 0.42;
    if (b <= a) return;
    const h = Math.max(3, S * 0.16);
    ctx.save();
    ctx.fillStyle = 'rgba(8,4,2,0.85)';
    ctx.fillRect(a, y - h / 2 - 1.5, b - a, h + 3);
    ctx.fillStyle = active ? '#ffd27a' : st.color;
    ctx.fillRect(a, y - h / 2, b - a, h);
    ctx.fillStyle = active ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.45)';
    ctx.fillRect(a, y - h / 2, b - a, Math.max(1, h * 0.3));
    ctx.restore();
  }

  mark(grade, t, button, delta) { this.marks.push({ grade, t, button, delta }); if (this.marks.length > 12) this.marks.shift(); }

  /**
   * @param ctx 2D コンテキスト（CSS px）
   * @param L   laneRect
   * @param t   現在時刻
   * @param notes Judge.notes（result/holding を持つ）
   * @param o   {lead, judge, held:{Y:bool...}, selected:Set<id>, edit:bool}
   */
  /** レーンの背景・枠（人物より奥）。行の区切りと、押している行の明るさもここ */
  drawBack(ctx, L, o = {}) {
    const { rowH } = L;
    ctx.save();
    rr(ctx, L.x, L.y, L.w, L.h, 8);
    ctx.fillStyle = `rgba(12,8,5,${L.panelAlpha ?? 0.6})`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,230,200,0.18)'; ctx.lineWidth = 1; ctx.stroke();
    LANE_ORDER.forEach((b, k) => {
      const y = L.y + k * rowH, st = LANE_STYLE[b];
      if (k) { ctx.fillStyle = 'rgba(255,255,255,0.07)'; ctx.fillRect(L.x + 4, y, L.w - 8, 1); }
      if (o.held?.[b]) { ctx.fillStyle = `rgba(${st.rgb},0.14)`; ctx.fillRect(L.x + 2, y + 1, L.w - 4, rowH - 2); }
    });
    ctx.restore();
  }

  /**
   * レーンの手前側（人物より手前）: ボタンのラベル・判定線・ノーツ・判定の文字。
   * 奥側（drawBack）と分けて、間に人物を描く（人物の頭がレーンの面に隠れない）。
   */
  draw(ctx, L, t, notes, o) {
    const { rowH } = L;
    const labelW = Math.min(118, Math.max(58, L.w * 0.16));
    const jx = L.x + labelW + rowH * 0.6; // 判定位置
    const right = L.x + L.w - 6;
    const lead = o.lead;
    const xAt = (time) => jx + ((time - t) / lead) * (right - jx);
    // 文字の大きさは 1 つの基準: 左端の見出し（判定の文字）と、流れる文字・長押しの終端・判定位置の火を同じ大きさ・太さにする
    const GS = Math.round(rowH * 0.86);
    ctx.save();
    ctx.font = `600 ${Math.round(rowH * 0.42)}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`;
    ctx.textBaseline = 'middle';
    LANE_ORDER.forEach((b, k) => {
      const y = L.y + k * rowH, st = LANE_STYLE[b];
      const held = o.held?.[b];
      // 見出し: 漢字（息・構・撃・旋）＋ 小さく入力ボタン（／Y など）
      const gs = GS, cx = L.x + 6 + gs * 0.62, cy = y + rowH / 2;
      this.glyph.drawNote(ctx, GLYPH[b], cx, cy, gs, st, held ? 1 : 0.92);
      if (held) { ctx.globalCompositeOperation = 'lighter'; this.glyph.drawNote(ctx, GLYPH[b], cx, cy, gs, st, 0.45); ctx.globalCompositeOperation = 'source-over'; }
      ctx.font = `800 ${Math.round(rowH * 0.42)}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`;
      ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3;
      ctx.strokeText(`／${b}`, cx + gs * 0.62, cy + rowH * 0.08);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillText(`／${b}`, cx + gs * 0.62, cy + rowH * 0.08);
    });
    // 判定位置の線
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(jx - 2.5, L.y + 3, 5, L.h - 6);
    ctx.fillStyle = 'rgba(255,240,210,0.95)';
    ctx.fillRect(jx - 1.5, L.y + 3, 3, L.h - 6);
    // 判定位置の文字の火（ノーツより先に描く。次に流れてくるノーツを覆わない）
    const S = GS, rowY = (b) => L.y + LANE_ORDER.indexOf(b) * rowH + rowH / 2;
    this.glyph.setHold(o.holdFire || null, t);
    if (o.holdFire) this.glyph.hold.progress = o.holdFire.progress;
    this.glyph.drawFires(ctx, jx, rowY, S, t, (b) => GLYPH[b]);
    ctx.save();
    ctx.beginPath(); ctx.rect(jx - S * 0.7, L.y - rowH * 0.2, right - jx + S * 0.7 + 6, L.h + rowH * 0.4); ctx.clip();
    // ノーツ: 文字そのもの（息・構・撃・旋）が流れてくる。長押しは始端と終端の「息」を直線で結ぶ（長さ = 保持時間）
    for (const n of notes) {
      const end = n.time + (n.duration || 0);
      if (end < t - 0.6 || n.time > t + lead + 0.1) continue;
      const st = LANE_STYLE[n.button], y = rowY(n.button);
      const hit = n.result === 'PERFECT' || n.result === 'GOOD';
      if (hit && n.input !== 'hold') continue; // 成功したノーツは消える（判定位置の文字に火が灯る）
      const sel = o.selected?.has(n.id);
      const alpha = n.result === 'MISS' ? 0.35 : n.result === 'SKIP' ? 0.25 : 1;
      ctx.globalAlpha = alpha;
      if (n.input === 'hold') {
        // 長押し: 始端と終端に同じ「息」、間はレーンに平行な直線（長さ = 長押し時間）
        const xs = Math.max(xAt(n.time), n.holding || hit ? jx : -1e9), xe = xAt(end);
        if (!hit) {
          this._holdLine(ctx, xs, xe, y, S, st, !!n.holding);
          this.glyph.drawNote(ctx, GLYPH[n.button], xe, y, S, st, alpha, sel); // 終端
          if (n.holding) {
            ctx.globalAlpha = 1;
            ctx.font = `800 ${Math.round(rowH * 0.4)}px system-ui, sans-serif`;
            ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3;
            const txt = `${Math.max(0, end - t).toFixed(1)}s`, tx = Math.min(xe + S * 0.6, right - rowH * 1.6);
            ctx.strokeText(txt, tx, y - rowH * 0.32); ctx.fillStyle = '#ffe2b0'; ctx.fillText(txt, tx, y - rowH * 0.32);
          }
        }
        if (!n.holding && !hit) this.glyph.drawNote(ctx, GLYPH[n.button], xAt(n.time), y, S, st, alpha, sel); // 始端
      } else {
        this.glyph.drawNote(ctx, GLYPH[n.button], xAt(n.time), y, S, st, alpha, sel);
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
      ctx.strokeText(txt, jx + rowH * 0.85, y);
      ctx.fillText(txt, jx + rowH * 0.85, y);
    }
    ctx.restore();
    return { jx, xAt, right };
  }
}
