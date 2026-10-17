// VFX エンジン。粒子の位置・大きさ・色は「発生からの経過時間（音声時刻）」の解析式で求めるため、
// 一時停止で止まり、フレーム落ちしても飛ばず、AUTO/MANUAL で同じ見た目になる。
// 描画は SpriteBatch に積み、WebGL2 / Canvas2D のどちらでも描ける。

import { buildHit, TECHNIQUES } from './presets.js';
import { KIND } from '../gfx/batch.js';

const lerp = (a, b, u) => a + (b - a) * u;

export class VfxEngine {
  constructor(quality) {
    this.setQuality(quality);
    this.events = [];
    this.keys = new Set();
    this.stats = { spawned: 0, deduped: 0, evicted: 0, peakParticles: 0, live: 0 };
  }

  setQuality(q) {
    this.q = q;
    this.maxParticles = q.maxParticles;
  }

  clear() { this.events = []; this.keys.clear(); }

  get liveParticles() { return this.events.reduce((s, e) => s + e.particles.length, 0); }

  /**
   * 判定結果に応じた演出を予約する（同じ key は1回だけ）。
   * @param {object} o
   * @param {string} o.key  ノーツID（重複発火防止）
   * @param {'PERFECT'|'GOOD'|'MISS'} o.grade
   * @param {string} o.tech 技カテゴリー（未検証なら generic）
   * @param {number} o.t   演出の基準時刻（技の決め）
   * @param {{x:number,y:number}} o.anchor 接触位置（元画像座標）
   * @param {{x:number,y:number}} [o.foot] 足元（元画像座標）
   * @param {number} [o.dir] 技の向き(rad)
   */
  spawn({ key, grade, tech = 'generic', t, anchor, foot = null, dir = -Math.PI / 2 }) {
    if (key != null) {
      if (this.keys.has(key)) { this.stats.deduped++; return null; }
      this.keys.add(key);
    }
    if (!TECHNIQUES.includes(tech)) tech = 'generic';
    const seed = hashKey(String(key ?? Math.random()));
    const def = buildHit(grade, tech, { dir, seed, scale: this.q.particleScale });
    // 粒子数の上限: 超える場合は古い演出から解放する
    let live = this.liveParticles;
    while (this.events.length && live + def.particles.length > this.maxParticles) {
      const old = this.events.shift();
      live -= old.particles.length;
      this.stats.evicted++;
    }
    if (def.particles.length > this.maxParticles) def.particles.length = this.maxParticles;
    const ev = { key, grade, tech, t, anchor, foot, dir, ...def };
    this.events.push(ev);
    this.stats.spawned++;
    this.stats.peakParticles = Math.max(this.stats.peakParticles, live + def.particles.length);
    return ev;
  }

  /** 終了した演出を解放（予約が遠すぎるもの＝巻き戻し後の残骸も破棄） */
  prune(now) {
    this.events = this.events.filter((e) => now <= e.t + e.duration && e.t <= now + 1.5);
    this.stats.live = this.liveParticles;
  }

  /** 画面全体に効く信号（揺れ・閃光・色収差・ノイズ・床伝播・残像） */
  signals(now, shakeScale = 1) {
    const out = { sx: 0, sy: 0, flash: 0, chroma: 0, glitch: 0, afterimage: 0, cold: 0, floorPulses: [] };
    for (const e of this.events) {
      const a = now - e.t;
      if (a < 0) continue;
      const s = e.signals;
      if (s.shake && a < s.shakeDur) {
        const k = 1 - a / s.shakeDur;
        const amp = s.shake * k * k * shakeScale;
        out.sx += Math.sin(a * 91 + e.dir) * amp;
        out.sy += Math.cos(a * 73) * amp * 0.8;
      }
      if (s.flash && a < 0.09) out.flash = Math.max(out.flash, s.flash * (1 - a / 0.09));
      if (s.chroma && a < 0.24) out.chroma = Math.max(out.chroma, s.chroma * (1 - a / 0.24) ** 2);
      if (s.glitch && a < 0.2) out.glitch = Math.max(out.glitch, s.glitch * (1 - a / 0.2));
      if (s.tint === 'cold' && a < 0.35) out.cold = Math.max(out.cold, 1 - a / 0.35);
      if (s.afterimage && a < 0.34) out.afterimage = Math.max(out.afterimage, s.afterimage * (1 - a / 0.34));
      if (s.floor && a < 1.1 && e.foot) out.floorPulses.push({ age: a, strength: s.floor, foot: e.foot, grade: e.grade });
    }
    return out;
  }

  /**
   * @param {number} now
   * @param {{toScreen:(x:number,y:number)=>{x:number,y:number}, scale:number}} cam
   * @param {import('../gfx/batch.js').SpriteBatch} batch
   */
  render(now, cam, batch) {
    const k = cam.scale;
    let live = 0;
    for (const e of this.events) {
      const base = cam.toScreen(e.anchor.x, e.anchor.y);
      for (const p of e.particles) {
        const a = now - (e.t + p.t0);
        if (a < 0 || a > p.life) continue;
        live++;
        const u = a / p.life;
        let x = p.x0, y = p.y0, vx = p.vx, vy = p.vy;
        if (p.mode === 'ballistic') {
          if (p.drag > 0) {
            const f = (1 - Math.exp(-p.drag * a)) / p.drag;
            x += p.vx * f; y += p.vy * f;
            const d = Math.exp(-p.drag * a);
            vx = p.vx * d; vy = p.vy * d;
          } else { x += p.vx * a; y += p.vy * a; }
          y += 0.5 * p.g * a * a;
          vy += p.g * a;
        }
        const eu = p.ease === 'in' ? u * u : 1 - (1 - u) ** 3;
        const size = lerp(p.s0, p.s1, eu) * k;
        const env = (u < p.attack ? u / p.attack : (1 - (u - p.attack) / (1 - p.attack)) ** p.pow) * p.alpha;
        const c = palAt(p.pal, u);
        const sx = base.x + x * k, sy = base.y + y * k;
        switch (p.kind) {
          case KIND.SPARK:
          case KIND.STREAK: {
            if (p.mode === 'ballistic') {
              const sp = Math.hypot(vx, vy);
              const len = Math.max(size * 2, sp * p.stretch * k);
              batch.push(sx, sy, len, size, Math.atan2(vy, vx), p.kind, 0, 0, 0, c[0], c[1], c[2], env, 1);
            } else {
              batch.push(sx, sy, size, Math.max(1, size * p.aspect), p.rot, p.kind, 0, 0, 0, c[0], c[1], c[2], env, 1);
            }
            break;
          }
          case KIND.RING:
            batch.push(sx, sy, size, size * p.aspect, p.rot, KIND.RING, lerp(p.p1, p.p2 || p.p1, eu), 0, hashKey(String(e.key)) % 997, c[0], c[1], c[2], env, 1);
            break;
          case KIND.ARC:
            batch.push(sx, sy, size, size, p.rot, KIND.ARC, p.p1, p.p2, 0, c[0], c[1], c[2], env, 1);
            break;
          case KIND.SHARD:
            batch.push(sx, sy, size, size * 0.62, p.rot + p.rotV * a, KIND.SHARD, p.seed || 0.5, u, 0, c[0], c[1], c[2], env, 0);
            break;
          default:
            batch.push(sx, sy, size, size, p.rot, p.kind, 0, 0, 0, c[0], c[1], c[2], env, p.add);
        }
      }
    }
    this.stats.peakParticles = Math.max(this.stats.peakParticles, live);
    return live;
  }
}

function palAt(pal, u) {
  const t = Math.min(1, Math.max(0, u)) * (pal.length - 1);
  const i = Math.min(pal.length - 2, Math.floor(t));
  const f = t - i;
  const a = pal[i], b = pal[i + 1];
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), lerp(a[2], b[2], f)];
}

export function hashKey(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
