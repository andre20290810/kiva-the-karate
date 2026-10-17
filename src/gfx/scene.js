// シーン統合: ステージ空間・人物・VFX をまとめ、WebGL2（不可なら Canvas2D）で描く。
// 時刻はすべて音声の再生位置。判定・音声には一切関与しない（描画専用）。

import { GLRenderer } from './gl-renderer.js';
import { CanvasRenderer } from './canvas-renderer.js';
import { SpriteBatch, KIND } from './batch.js';
import { pickQuality, QUALITY_PRESETS, FrameRateGovernor } from './quality.js';
import { StageSpace } from '../stage/stage.js';
import { buildWorld } from '../stage/world.js';
import { CharacterRig } from '../character.js';
import { VfxEngine } from '../vfx/engine.js';

export class Scene {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../frames.js').FrameStore} frames
   * @param {{camera?:object, stage?:object}} chartView 譜面の camera / stage 設定
   * @param {{quality?:string, forceCanvas?:boolean}} opts
   */
  constructor(canvas, frames, chartView = {}, opts = {}) {
    this.canvas = canvas;
    this.frames = frames;
    this.renderer = opts.forceCanvas ? null : GLRenderer.create(canvas);
    if (!this.renderer) {
      // WebGL コンテキスト取得に失敗したキャンバスは 2D に使えないため差し替える
      if (!opts.forceCanvas) {
        const c = canvas.cloneNode(false);
        canvas.replaceWith(c);
        this.canvas = canvas = c;
      }
      this.renderer = new CanvasRenderer(canvas);
    }
    this.qualityMode = opts.quality || 'AUTO';
    this.q = pickQuality(this.qualityMode === 'AUTO' ? null : this.qualityMode, { webgl2: this.renderer.kind === 'webgl2', lowMemory: (navigator.deviceMemory || 8) <= 2 });
    this.st = new StageSpace({ ...(chartView.stage || {}), speed: this.q.floorSpeed });
    // frames は動作の時間軸の基準（KIVA のセーパイ演武）。表示する人物画像は setCharacter で切り替える
    this.cameraDef = chartView.camera || {};
    this.rig = new CharacterRig(frames, this.cameraDef);
    this.disp = { frames, rig: this.rig };
    this.vfx = new VfxEngine(this.q);
    this.batches = { fx: new SpriteBatch(4096), dustB: new SpriteBatch(512), dustF: new SpriteBatch(512), under: new SpriteBatch(16) };
    this.governor = new FrameRateGovernor();
    this.view = { w: 1, h: 1, dpr: 1 };
    this.energy = 0;
    this.lastHitT = -10;
    this.combo = 0;
    this.perf = { frames: 0, avgMs: 0, worstMs: 0, fps: 0, particles: 0, sprites: 0 };
    this.debug = false;
  }

  get rendererKind() { return this.renderer.kind; }

  /**
   * 表示する人物画像を切り替える（時間軸・判定・音声には影響しない）。
   * @param {import('../frames.js').FrameStore|null} store null = 人物を描かない（未完成のキャラクター）
   */
  setCharacter(store) {
    if (store && store !== this.frames && store.count !== this.frames.count) throw new Error('基準と時間軸が異なる人物画像は使えません');
    this.disp = store ? { frames: store, rig: store === this.frames ? this.rig : new CharacterRig(store, this.cameraDef) } : null;
    this.renderer.clearTextures?.(); // テクスチャはフレーム番号で保持しているため、別人物の画像と混ざらないよう破棄
  }

  setQuality(mode, t = 0) {
    this.qualityMode = mode;
    this.q = pickQuality(mode === 'AUTO' ? null : mode, { webgl2: this.renderer.kind === 'webgl2' });
    this.vfx.setQuality(this.q);
    this.st.setSpeed(this.q.floorSpeed, t);
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    const dpr = Math.min(window.devicePixelRatio || 1, this.q.dprCap);
    this.view = { w, h, dpr };
    this.st.layout(w, h);
    this.renderer.resize(w, h, dpr);
  }

  reset() {
    this.vfx.clear();
    this.st.clearBoosts();
    this.energy = 0;
    this.lastHitT = -10;
    this.combo = 0;
  }

  /**
   * 判定結果に応じた演出（PERFECT / GOOD / MISS）。同じ key は1回のみ。
   * @param {{key:string, grade:string, tech?:string, t:number, kimeVideoTime:number, fx?:Array, combo:number}} o
   */
  hit(o) {
    const idx = this.frames.indexAt(o.kimeVideoTime);
    const impact = (o.fx || []).find((f) => f.type === 'impact' || f.type === 'arc' || f.type === 'flash') || (o.fx || [])[0];
    // 演出位置は表示中の人物の画像座標（人物を描かない場合は基準の動作位置）
    const rig = (this.disp ?? { rig: this.rig }).rig;
    const anchor = rig.anchor(impact, idx);
    const foot = rig.foot(idx);
    const dir = o.dir ?? rig.direction(idx, anchor);
    const ev = this.vfx.spawn({ key: o.key, grade: o.grade, tech: o.tech || 'generic', t: o.t, anchor, foot, dir });
    if (!ev) return null;
    if (ev.signals.boost) this.st.boost(o.t, this.q.floorBoost * ev.signals.boost);
    this.combo = o.combo;
    if (o.grade !== 'MISS') this.lastHitT = o.t;
    return ev;
  }

  /** 1フレーム描画（t: 音声時刻 / vt: 元動画時刻） */
  render(t, vt, { frameMs = 16.7, stageT = t } = {}) {
    const t0 = performance.now();
    const { w, h } = this.view;
    const q = this.q;
    this.vfx.prune(t);
    const sig = this.vfx.signals(t, q.shake);
    // 連続成功で高まる“エネルギー”（床・リムライトの発光に反映）
    const recent = Math.max(0, 1 - (t - this.lastHitT) / 0.6);
    this.energy = Math.min(1, Math.min(1, this.combo / 20) * 0.45 + recent * 0.55);

    const D = this.disp;
    const geo = D ?? { frames: this.frames, rig: this.rig };
    const idx = this.frames.indexAt(vt);
    let fr = null;
    if (D) { D.frames.prefetch(idx); fr = D.frames.get(idx); }
    const cam = geo.rig.camera(t, this.view);
    const shownIdx = fr ? fr.index : idx;
    const foot = geo.rig.foot(shownIdx);
    const footS = cam.toScreen(foot.x, foot.y);
    const charZ = this.st.depthAtScreenY(footS.y);
    const charW = this.st.unproject(footS.x, Math.max(footS.y, this.st.horizonY + 1)) || { x: 0 };

    // 床への衝撃伝播（足元の床位置）
    const pulses = [];
    for (const p of sig.floorPulses) {
      const s = cam.toScreen(p.foot.x, p.foot.y);
      const wpos = this.st.unproject(s.x, Math.max(s.y, this.st.horizonY + 2));
      if (wpos) pulses.push({ x: wpos.x, z: wpos.z, age: p.age, strength: p.strength });
    }

    const world = buildWorld(this.st, stageT, charZ, q);
    const { dustB, dustF, under, fx } = this.batches;
    dustB.reset(); dustF.reset(); under.reset(); fx.reset();
    for (const d of world.dustBehind) dustB.push(d.x, d.y, d.r * 6, d.r * 6, 0, KIND.GLOW, 0, 0, 0, 0.5 + d.hue * 0.4, 0.75, 1, d.a * 0.6, 1);
    for (const d of world.dustFront) dustF.push(d.x, d.y, d.r * 6, d.r * 6, 0, KIND.GLOW, 0, 0, 0, 0.5 + d.hue * 0.4, 0.75, 1, d.a * 0.6, 1);

    if (fr) {
      // 接地影（足の位置・広がりから。画像と同じフレームで切り替わる）
      const sw = foot.spread * cam.scale * 2.4;
      under.push(footS.x, footS.y + 2, sw * 1.5, sw * 0.26, 0, KIND.GLOW, 0, 0, 0, 0, 0, 0, 0.55, 0);
      under.push(footS.x, footS.y + 1, sw * 0.8, sw * 0.12, 0, KIND.GLOW, 0, 0, 0, 0, 0, 0, 0.75, 0);
      // 背面の光（人物を背景から浮かび上がらせる）
      const body = cam.toScreen(foot.x, foot.y - 420);
      under.push(body.x, body.y, cam.rect.w * 1.25, cam.rect.h * 0.95, 0, KIND.GLOW, 0, 0, 0, 0.25, 0.42, 0.85, 0.22 + this.energy * 0.25, 1);
    }

    const ghosts = [];
    if (sig.afterimage > 0.02 && fr) {
      for (let k = 1; k <= q.afterimages; k++) {
        const gi = this.frames.indexAt(vt - 0.2 * k);
        if (gi === shownIdx) continue;
        const gf = D.frames.get(gi);
        if (gf && gf.exact) ghosts.push({ index: gf.index, bmp: gf.bmp, alpha: sig.afterimage * (0.55 / k) });
      }
    }

    const particles = this.vfx.render(t, cam, fx);
    this.renderer.render({
      t, st: this.st, q, sig, scroll: this.st.scroll(stageT), charZ, charX: charW.x, energy: this.energy, pulses, world,
      dustBehind: dustB, dustFront: dustF, under, fx,
      character: fr ? { index: fr.index, bmp: fr.bmp, rect: cam.rect, footY: footS.y, ghosts } : null,
    });

    // 計測
    const ms = performance.now() - t0;
    const p = this.perf;
    p.frames++;
    p.avgMs = p.avgMs * 0.95 + ms * 0.05;
    p.worstMs = Math.max(p.worstMs * 0.995, ms);
    p.particles = particles;
    p.sprites = fx.count;
    if (this.governor.sample(frameMs) === 'degrade' && this.qualityMode === 'AUTO' && this.q.name !== 'PERFORMANCE') {
      const next = this.q.name === 'CINEMATIC' ? 'NORMAL' : 'PERFORMANCE';
      this.q = { name: next, ...QUALITY_PRESETS[next] };
      this.vfx.setQuality(this.q);
      this.st.setSpeed(this.q.floorSpeed, t);
      this.resize();
    }
    p.fps = this.governor.fps;
    this.last = { idx, shownIdx, foot, footS, charZ, cam, drawn: !!fr };
    return { cam, shownIdx };
  }
}
