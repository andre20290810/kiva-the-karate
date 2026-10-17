// ステージの立体物（柱・ゲート・奥行き方向の粒子）を画面上の四角形／点に変換する。
// WebGL2 と Canvas2D の両方がこの結果を描く。人物より奥のものと手前のものに分けて返す。

import { hash } from './stage.js';

/**
 * @param {import('./stage.js').StageSpace} st
 * @param {number} t 音声時刻
 * @param {number} charZ 人物の立ち位置の奥行き
 * @param {{pillars:number,gates:number,dust:number,fog:number}} q
 */
export function buildWorld(st, t, charZ, q) {
  const behind = [];
  const front = [];
  const fogOf = (z) => 1 - Math.exp(-z * q.fog);
  const quad = (pts, o) => ({ pts, ...o });
  const P = (x, y, z) => st.project(x, z, y);

  for (const p of st.pillars(t, q.pillars)) {
    const d = p.w * 1.1;
    const x0 = p.x - p.w / 2, x1 = p.x + p.w / 2;
    if (p.z < st.p.near + 0.25) continue;
    const zf = p.z, zb = p.z + d;
    const fade = Math.min(1, (p.z - st.p.near - 0.25) / 1.5) * (1 - smooth(st.p.far * 0.7, st.p.far, p.z));
    const fog = fogOf(p.z);
    const list = p.z < charZ ? front : behind;
    const f = [P(x0, 0, zf), P(x1, 0, zf), P(x1, p.h, zf), P(x0, p.h, zf)];
    // 通路側の側面（奥行きが見える面）
    const ix = p.side < 0 ? x1 : x0;
    const s = [P(ix, 0, zf), P(ix, 0, zb), P(ix, p.h, zb), P(ix, p.h, zf)];
    if (s.every(Boolean)) list.push(quad(s, { kind: 'side', z: zb, fog, alpha: fade, shade: 0.55, seed: hash(p.id), side: p.side }));
    if (f.every(Boolean)) list.push(quad(f, { kind: 'front', z: zf, fog, alpha: fade, shade: 1, seed: hash(p.id + 1), side: p.side }));
  }

  for (const g of st.gates(t, q.gates)) {
    // 人物に近づく前に消える（人物を隠さない）
    const alpha = smooth(charZ + 2, charZ + 7, g.z) * (1 - smooth(st.p.far * 0.75, st.p.far, g.z));
    if (alpha <= 0.01) continue;
    const fog = fogOf(g.z);
    const lw = 0.45, bh = 0.5;
    const legs = [[-g.w - lw / 2, -g.w + lw / 2], [g.w - lw / 2, g.w + lw / 2]];
    for (const [a, b] of legs) {
      const pts = [P(a, 0, g.z), P(b, 0, g.z), P(b, g.h, g.z), P(a, g.h, g.z)];
      if (pts.every(Boolean)) behind.push(quad(pts, { kind: 'gate', z: g.z, fog, alpha, shade: 0.9, seed: g.id * 0.17 }));
    }
    const beam = [P(-g.w - lw / 2, g.h, g.z), P(g.w + lw / 2, g.h, g.z), P(g.w + lw / 2, g.h + bh, g.z), P(-g.w - lw / 2, g.h + bh, g.z)];
    if (beam.every(Boolean)) behind.push(quad(beam, { kind: 'beam', z: g.z, fog, alpha, shade: 0.9, seed: g.id * 0.31 }));
  }

  behind.sort((a, b) => b.z - a.z);
  front.sort((a, b) => b.z - a.z);

  // 奥行き方向に流れる粒子（光の塵）
  const dustBehind = [], dustFront = [];
  const span = st.p.far - st.p.near;
  const off = st.scroll(t) * 1.15;
  for (let i = 0; i < q.dust; i++) {
    const x = (hash(i * 3.1) - 0.5) * 22;
    const y = 0.2 + hash(i * 7.7) * 6.5;
    const z = ((hash(i * 1.3) * span - off) % span + span) % span + st.p.near;
    const s = st.project(x, z, y);
    if (!s) continue;
    const a = (1 - fogOf(z) * 0.9) * smooth(st.p.near, st.p.near + 2, z) * (0.35 + hash(i) * 0.65);
    (z < charZ ? dustFront : dustBehind).push({ x: s.x, y: s.y, r: Math.max(0.6, s.k * 0.035), a, hue: hash(i * 5.3) });
  }
  return { behind, front, dustBehind, dustFront };
}

function smooth(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
