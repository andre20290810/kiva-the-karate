// 技成立エフェクトの設計（時間設計つき）。
// 位置・速度は「元画像ピクセル」単位（画面ではカメラ倍率を掛ける）。時間は秒（音声時刻基準）。
// 技カテゴリーは譜面の moves[].vfx で指定。未検証の譜面では 'generic' を使う。

import { KIND } from '../gfx/batch.js';

export const TECHNIQUES = ['generic', 'tsuki', 'uke', 'keri', 'fumikomi', 'kime'];

export const PALETTE = {
  hot: [[1, 1, 1], [1, 0.86, 0.45], [1, 0.42, 0.12]],
  gold: [[1, 0.97, 0.85], [1, 0.78, 0.3], [0.9, 0.35, 0.08]],
  cyan: [[0.9, 1, 1], [0.35, 0.85, 1], [0.1, 0.35, 0.9]],
  steel: [[0.95, 0.97, 1], [0.62, 0.68, 0.78], [0.3, 0.34, 0.42]],
  cold: [[0.75, 0.85, 1], [0.35, 0.5, 0.85], [0.12, 0.16, 0.35]],
  violet: [[1, 0.9, 1], [0.75, 0.45, 1], [0.35, 0.15, 0.8]],
};

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const P = (o) => ({
  mode: 'static', t0: 0, life: 0.3, x0: 0, y0: 0, vx: 0, vy: 0, drag: 0, g: 0,
  s0: 10, s1: 10, aspect: 1, rot: 0, rotV: 0, p1: 0, p2: 0, stretch: 0,
  pal: PALETTE.hot, attack: 0.08, pow: 1.6, alpha: 1, add: 1, ease: 'out', ...o,
});

/**
 * @param {'PERFECT'|'GOOD'|'MISS'} grade
 * @param {string} tech
 * @param {{dir:number, seed:number, scale:number}} o  dir: 技の向き(rad)、scale: 品質による粒子数倍率
 * @returns {{particles:object[], signals:object, duration:number}}
 */
export function buildHit(grade, tech, { dir = -Math.PI / 2, seed = 1, scale = 1 } = {}) {
  const R = rng(seed);
  const n = (k) => Math.max(1, Math.round(k * scale));
  const ps = [];
  const sig = { shake: 0, shakeDur: 0, flash: 0, chroma: 0, glitch: 0, floor: 0, boost: 0, afterimage: 0, comboBreak: false, tint: null };

  if (grade === 'MISS') {
    // 不発: 寒色のエネルギーが集まりかけて崩れる + 短いノイズ
    ps.push(P({ kind: KIND.RING, life: 0.32, s0: 170, s1: 40, aspect: 0.55, rot: dir, p1: 0.08, pal: PALETTE.cold, alpha: 0.55, attack: 0.15, ease: 'in' }));
    for (let i = 0; i < n(26); i++) {
      const a = R() * Math.PI * 2;
      const r = 70 + R() * 90;
      // 外から中心へ吸い込まれた後、重力で崩れ落ちる
      ps.push(P({ mode: 'ballistic', kind: KIND.GLOW, t0: R() * 0.06, life: 0.45 + R() * 0.35,
        x0: Math.cos(a) * r, y0: Math.sin(a) * r, vx: -Math.cos(a) * r * 3.2, vy: -Math.sin(a) * r * 3.2,
        drag: 6, g: 520 + R() * 300, s0: 9 + R() * 8, s1: 2, pal: PALETTE.cold, alpha: 0.7, pow: 1.2 }));
    }
    for (let i = 0; i < n(10); i++) {
      ps.push(P({ mode: 'ballistic', kind: KIND.SHARD, t0: 0.05 + R() * 0.08, life: 0.5 + R() * 0.3,
        x0: (R() - 0.5) * 60, y0: (R() - 0.5) * 60, vx: (R() - 0.5) * 120, vy: -40 + R() * 40, g: 900,
        s0: 9 + R() * 8, s1: 6, rot: R() * 6, rotV: (R() - 0.5) * 10, pal: PALETTE.cold, alpha: 0.75, add: 0, seed: R() }));
    }
    Object.assign(sig, { shake: 2.5, shakeDur: 0.1, glitch: 1, comboBreak: true, tint: 'cold' });
    return { particles: ps, signals: sig, duration: 0.9 };
  }

  const perfect = grade === 'PERFECT';
  const S = perfect ? 1 : 0.55; // 規模
  const main = perfect ? PALETTE.gold : PALETTE.cyan;
  const accent = perfect ? PALETTE.cyan : PALETTE.violet;
  const dx = Math.cos(dir), dy = Math.sin(dir);

  // ── 0–90ms: コアフラッシュ（鋭い十字の閃光）
  // 人物の体を隠さないよう、強い白色部分は小さく短く（外側の色光で広がりを出す）
  ps.push(P({ kind: KIND.CORE, life: perfect ? 0.075 : 0.06, s0: 24 * S, s1: 60 * S, rot: dir, pal: PALETTE.hot, attack: 0.016, pow: 2.4, alpha: 0.65 }));
  ps.push(P({ kind: KIND.GLOW, life: perfect ? 0.27 : 0.20, s0: 55 * S, s1: 145 * S, pal: main, alpha: perfect ? 0.28 : 0.2, attack: 0.03, pow: 1.9 }));
  // アナモルフィックな横長フレア
  ps.push(P({ kind: KIND.STREAK, life: perfect ? 0.2 : 0.12, s0: 380 * S, s1: 900 * S, aspect: 0.022, rot: 0, pal: PALETTE.cyan, alpha: perfect ? 0.9 : 0.5, attack: 0.02, pow: 2 }));

  // ── 20–420ms: 立体的な衝撃波（傾いた楕円リング + 正面リング）
  const tilt = tech === 'fumikomi' ? 0.22 : 0.42;
  ps.push(P({ kind: KIND.RING, t0: 0.015, life: perfect ? 0.42 : 0.3, s0: 50 * S, s1: 520 * S, aspect: tilt, rot: dir + Math.PI / 2,
    p1: 0.08, p2: 0.008, pal: main, alpha: perfect ? 0.45 : 0.3, attack: 0.04, pow: 1.4 }));
  if (perfect) {
    ps.push(P({ kind: KIND.RING, t0: 0.05, life: 0.33, s0: 30, s1: 330, aspect: 1, p1: 0.04, p2: 0.006, pal: PALETTE.cyan, alpha: 0.35, attack: 0.05, pow: 1.3 }));
    ps.push(P({ kind: KIND.RING, t0: 0.11, life: 0.4, s0: 40, s1: 640, aspect: tilt * 0.8, rot: dir + Math.PI / 2, p1: 0.05, p2: 0.005, pal: PALETTE.steel, alpha: 0.45, attack: 0.05 }));
  }

  // ── 0–100ms: 高速の光跡（技の向きに集中）
  const trails = perfect ? 9 : 4;
  for (let i = 0; i < trails; i++) {
    const a = dir + (R() - 0.5) * (tech === 'kime' ? Math.PI * 2 : 1.1);
    const sp = 2600 + R() * 1800;
    ps.push(P({ mode: 'ballistic', kind: KIND.STREAK, t0: R() * 0.04, life: 0.12 + R() * 0.08, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 9,
      s0: 4 * S, s1: 1.5, stretch: 0.055, pal: i % 3 ? main : accent, alpha: 0.95, attack: 0.01, pow: 1.4 }));
  }

  // ── 0–650ms: 火花（速度方向に伸びる・重力・高温色→赤）
  const sparks = n(perfect ? 64 : 18);
  for (let i = 0; i < sparks; i++) {
    const cone = tech === 'tsuki' ? 0.7 : tech === 'kime' ? Math.PI : 1.6;
    const a = dir + (R() - 0.5) * 2 * cone;
    const sp = (500 + R() * 1300) * (perfect ? 1 : 0.7);
    ps.push(P({ mode: 'ballistic', kind: KIND.SPARK, t0: R() * 0.035, life: 0.22 + R() * 0.45, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      drag: 3.2 + R() * 2, g: 1100, s0: 2.6 + R() * 2.4, s1: 0.8, stretch: 0.03, pal: PALETTE.hot, alpha: 1, attack: 0.01, pow: 1.1 }));
  }

  // ── 20–800ms: 金属片（回転・重力・通常合成）
  if (perfect) {
    for (let i = 0; i < n(16); i++) {
      const a = dir + (R() - 0.5) * 2.4;
      const sp = 260 + R() * 700;
      ps.push(P({ mode: 'ballistic', kind: KIND.SHARD, t0: 0.02 + R() * 0.03, life: 0.5 + R() * 0.35, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 120,
        drag: 2, g: 1500, s0: 9 + R() * 10, s1: 7, rot: R() * 6, rotV: (R() - 0.5) * 22, pal: PALETTE.steel, alpha: 0.95, add: 0, attack: 0.02, pow: 3, seed: R() }));
    }
  }

  // ── 技カテゴリー別の追加要素
  if (tech === 'uke') {
    for (let k = 0; k < (perfect ? 3 : 1); k++) {
      ps.push(P({ kind: KIND.ARC, t0: k * 0.04, life: 0.36, s0: 120 + k * 40, s1: 260 + k * 70, rot: dir, p1: 0.09, p2: 1.6 + k * 0.3, pal: PALETTE.cyan, alpha: 0.9 - k * 0.2 }));
    }
  } else if (tech === 'keri') {
    for (let k = 0; k < 6; k++) {
      ps.push(P({ kind: KIND.STREAK, t0: k * 0.012, life: 0.25, x0: -dx * k * 40, y0: -dy * k * 40, s0: 260 - k * 25, s1: 300, aspect: 0.05, rot: dir, pal: accent, alpha: 0.7 - k * 0.08 }));
    }
  } else if (tech === 'kime') {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      ps.push(P({ kind: KIND.STREAK, life: 0.22, x0: Math.cos(a) * 90, y0: Math.sin(a) * 90, s0: 120, s1: 420, aspect: 0.03, rot: a, pal: main, alpha: 0.6 }));
    }
  }

  // ── 150–1000ms: 余韻（漂う残り火）
  for (let i = 0; i < n(perfect ? 30 : 10); i++) {
    const a = R() * Math.PI * 2;
    const r = R() * 120 * S;
    ps.push(P({ mode: 'ballistic', kind: KIND.GLOW, t0: 0.12 + R() * 0.2, life: 0.5 + R() * 0.5, x0: Math.cos(a) * r, y0: Math.sin(a) * r,
      vx: (R() - 0.5) * 60, vy: -40 - R() * 90, drag: 0.8, s0: 6 + R() * 6, s1: 1.5, pal: main, alpha: 0.75, attack: 0.2, pow: 1 }));
  }

  Object.assign(sig, perfect
    ? { shake: 11, shakeDur: 0.16, flash: 0.32, chroma: 1, floor: 1, boost: 1, afterimage: 1 }
    : { shake: 3.5, shakeDur: 0.09, flash: 0.1, chroma: 0.35, floor: 0.45, boost: 0.45, afterimage: 0.5 });
  if (tech === 'fumikomi') sig.floor *= 1.6;
  return { particles: ps, signals: sig, duration: perfect ? 1.15 : 0.8 };
}
