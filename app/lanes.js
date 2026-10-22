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
/** ボタン配置の案内の位置（上 Y・右 B・下 A・左 X） */
export const PAD_GUIDE = Object.freeze([['Y', 0, -1], ['B', 1, 0], ['A', 0, 1], ['X', -1, 0]]);
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

  /** 成功: 判定位置の文字に火を灯す（t0 = 判定した瞬間）。strong: 長押しの完了 */
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

  /**
   * レーンの横の配置（見出し → 「／Y」→ ボタン配置の案内 → 余白 → 判定位置）。文字の幅は実測する。
   * ノーツの位置は判定位置 jx からの距離 = 残り時間 ÷ 先読み時間なので、見出しの幅が変わっても判定時刻はずれない。
   */
  layout(ctx, L) {
    const { rowH } = L;
    const key = `${L.x}|${L.w}|${rowH}|${this.glyph.fontKey?.() || ''}`;
    if (this._lay?.key === key) return this._lay;
    const GS = Math.round(rowH * 0.86); // 見出しと流れる文字・長押しの終端・判定位置の火は同じ大きさ
    const cx = L.x + 6 + GS * 0.55;     // 見出しの文字の中心
    const fs = Math.round(rowH * 0.42);
    ctx.save();
    ctx.font = `800 ${fs}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`;
    const tw = Math.max(...LANE_ORDER.map((b) => ctx.measureText(`／${b}`).width));
    ctx.restore();
    const tx = cx + GS * 0.52;          // 「／Y」の左端
    const gap = Math.max(4, rowH * 0.16);
    const D = Math.round(rowH * 0.84);  // ボタン配置の案内（菱形）の大きさ（上下の行の案内と離す）
    const dx = tx + tw + gap + D / 2;   // 案内の中心
    const jx = dx + D / 2 + gap + GS * 0.55; // 判定位置（判定位置の文字の半分の幅を空ける）
    this._lay = { key, GS, cx, fs, tx, D, dx, jx, right: L.x + L.w - 6 };
    return this._lay;
  }

  /**
   * コントローラーの配置の案内: 4 つのボタンを菱形に並べる（上 Y・右 B・下 A・左 X。配置は固定）。
   * その行のボタンだけを色と明るさで強調し、他の 3 つは控えめに表示する。
   */
  drawPadGuide(ctx, b, x, y, D) {
    const r = D * 0.19, o = D / 2 - r; // 隣の円と重ならない（中心の間隔 o√2 > 2r）
    for (const [k, px, py] of PAD_GUIDE) {
      const on = k === b, st = LANE_STYLE[k];
      const cx = x + px * o, cy = y + py * o;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = on ? st.color : '#3b3029'; // 他の 3 つは背景に左右されない控えめな色
      ctx.fill();
      ctx.lineWidth = on ? 1.6 : 1;
      ctx.strokeStyle = on ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.32)';
      ctx.stroke();
      if (r >= 5) {
        ctx.font = `800 ${Math.round(r * 1.25)}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = on ? '#140b04' : 'rgba(255,255,255,0.42)';
        ctx.fillText(k, cx, cy + r * 0.06);
      }
    }
    ctx.textAlign = 'start';
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
   * 流れるノーツ（文字・長押しの線・終端・選択の光・残り時間）。人物より奥に描く（人物を覆わない）。
   * 人物の画像の透明な部分からは、奥のノーツが見える。
   */
  drawNotes(ctx, L, t, notes, o) {
    const { rowH } = L;
    const { GS, jx, right } = this.layout(ctx, L);
    const lead = o.lead;
    const xAt = (time) => jx + ((time - t) / lead) * (right - jx);
    const S = GS, rowY = (b) => L.y + LANE_ORDER.indexOf(b) * rowH + rowH / 2;
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
            ctx.textBaseline = 'middle';
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
    return { jx, xAt, right };
  }

  /**
   * レーンの手前側（人物より手前）: 見出し（息／Y と ボタン配置の案内）・判定線・判定位置の火・判定の文字。
   * 流れるノーツは drawNotes（人物より奥）。
   */
  draw(ctx, L, t, notes, o) {
    const { rowH } = L;
    const lay = this.layout(ctx, L);
    const { GS, jx, right } = lay;
    const lead = o.lead;
    const xAt = (time) => jx + ((time - t) / lead) * (right - jx);
    ctx.save();
    ctx.textBaseline = 'middle';
    LANE_ORDER.forEach((b, k) => {
      const y = L.y + k * rowH, st = LANE_STYLE[b];
      const held = o.held?.[b];
      // 見出し: 漢字（息・構・撃・旋。流れる文字と同じ大きさ）＋ 入力ボタン（／Y など）＋ ボタン配置の案内
      const gs = GS, cx = lay.cx, cy = y + rowH / 2;
      this.glyph.drawNote(ctx, GLYPH[b], cx, cy, gs, st, held ? 1 : 0.92);
      if (held) { ctx.globalCompositeOperation = 'lighter'; this.glyph.drawNote(ctx, GLYPH[b], cx, cy, gs, st, 0.45); ctx.globalCompositeOperation = 'source-over'; }
      ctx.font = `800 ${lay.fs}px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3;
      ctx.strokeText(`／${b}`, lay.tx, cy + rowH * 0.04);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillText(`／${b}`, lay.tx, cy + rowH * 0.04);
      this.drawPadGuide(ctx, b, lay.dx, cy, lay.D);
    });
    // 判定位置の線
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(jx - 2.5, L.y + 3, 5, L.h - 6);
    ctx.fillStyle = 'rgba(255,240,210,0.95)';
    ctx.fillRect(jx - 1.5, L.y + 3, 3, L.h - 6);
    // 判定位置の文字の火
    const S = GS, rowY = (b) => L.y + LANE_ORDER.indexOf(b) * rowH + rowH / 2;
    this.glyph.setHold(o.holdFire || null, t);
    if (o.holdFire) this.glyph.hold.progress = o.holdFire.progress;
    this.glyph.drawFires(ctx, jx, rowY, S, t, (b) => GLYPH[b]);
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
