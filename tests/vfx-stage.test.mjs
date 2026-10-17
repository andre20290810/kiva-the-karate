import test from 'node:test';
import assert from 'node:assert/strict';
import { StageSpace } from '../src/stage/stage.js';
import { VfxEngine } from '../src/vfx/engine.js';
import { SpriteBatch, STRIDE } from '../src/gfx/batch.js';
import { QUALITY_PRESETS } from '../src/gfx/quality.js';

const cam = { scale: 0.7, toScreen: (x, y) => ({ x: 100 + x * 0.7, y: 50 + y * 0.7 }) };
const hit = (e, key, grade, t) => e.spawn({ key, grade, tech: 'generic', t, anchor: { x: 300, y: 400 }, foot: { x: 290, y: 900 } });

test('ステージ: 床の投影と逆投影が一致し、奥ほど消失点へ近づく', () => {
  const st = new StageSpace().layout(800, 600);
  for (const [x, z] of [[0, 3], [2.5, 7], [-4, 20], [1, 55]]) {
    const s = st.project(x, z);
    const w = st.unproject(s.x, s.y);
    assert.ok(Math.abs(w.x - x) < 1e-9 && Math.abs(w.z - z) < 1e-9);
  }
  const near = st.project(3, 4), far = st.project(3, 40);
  assert.ok(far.y < near.y && far.y > st.horizonY, '奥は地平線に近い');
  assert.ok(Math.abs(far.x - st.vpX) < Math.abs(near.x - st.vpX), '奥は消失点へ収束');
  assert.equal(st.unproject(400, st.horizonY - 5), null, '地平線より上は床ではない');
});

test('ステージ: 床の流れは時刻の単調増加関数（加速を含む）・速度変更で不連続にならない', () => {
  const st = new StageSpace({ speed: 3.6 });
  st.boost(1.0, 9); st.boost(1.4, 5);
  let prev = -Infinity;
  for (let t = 0; t <= 5; t += 0.01) { const s = st.scroll(t); assert.ok(s >= prev - 1e-12); prev = s; }
  assert.ok(st.speedAt(1.01) > 3.6 + 8, '技成立の直後に一瞬加速');
  assert.ok(Math.abs(st.speedAt(4) - 3.6) < 0.1, '加速は減衰して元の速度に戻る');
  const t = 2.345, before = st.scroll(t);
  st.setSpeed(4.2, t);
  assert.ok(Math.abs(st.scroll(t) - before) < 1e-9, '速度変更の瞬間に床位置が跳ばない');
  assert.ok(st.scroll(t + 1) > before);
});

test('ステージ: 柱は奥から手前へ連続して流れる（同じ柱の奥行きが時間とともに減る）', () => {
  const st = new StageSpace({ speed: 3.6 });
  const a = st.pillars(1.0, 10), b = st.pillars(1.05, 10);
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) continue; // 手前を抜けて奥へ戻った柱
    assert.ok(b[i].z < a[i].z, `柱${i} z ${a[i].z}→${b[i].z}`);
    assert.ok(Math.abs((a[i].z - b[i].z) - 3.6 * 0.05) < 1e-6);
  }
});

test('VFX: 同じノーツの演出は1回だけ（重複発火防止）', () => {
  const e = new VfxEngine({ ...QUALITY_PRESETS.NORMAL });
  assert.ok(hit(e, 'g1:n1', 'PERFECT', 1));
  assert.equal(hit(e, 'g1:n1', 'PERFECT', 1), null);
  assert.equal(e.stats.deduped, 1);
  assert.ok(hit(e, 'g2:n1', 'PERFECT', 1), 'リスタート後（世代が違う）は別の演出');
});

test('VFX: 粒子数の上限を超えない（古い演出から解放）', () => {
  const q = { ...QUALITY_PRESETS.PERFORMANCE };
  const e = new VfxEngine(q);
  for (let i = 0; i < 40; i++) hit(e, `k${i}`, 'PERFECT', 1 + i * 0.01);
  assert.ok(e.liveParticles <= q.maxParticles, `${e.liveParticles} <= ${q.maxParticles}`);
  assert.ok(e.stats.evicted > 0);
  const b = new SpriteBatch(8192);
  e.render(1.3, cam, b);
  assert.ok(b.count <= q.maxParticles);
});

test('VFX: 終了後に解放され、描画対象が残らない', () => {
  const e = new VfxEngine({ ...QUALITY_PRESETS.NORMAL });
  hit(e, 'a', 'PERFECT', 1); hit(e, 'b', 'GOOD', 1.2); hit(e, 'c', 'MISS', 1.4);
  e.prune(1.5);
  assert.equal(e.events.length, 3);
  e.prune(10);
  assert.equal(e.events.length, 0);
  assert.equal(e.liveParticles, 0);
  const b = new SpriteBatch();
  assert.equal(e.render(10, cam, b), 0);
});

test('VFX: 同じ時刻なら同じ見た目（時刻の解析式・描画頻度に依存しない）', () => {
  const mk = () => { const e = new VfxEngine({ ...QUALITY_PRESETS.NORMAL }); hit(e, 'n7', 'PERFECT', 2); return e; };
  const e1 = mk(), e2 = mk();
  // e1 は細かく、e2 は1回だけ描画しても、t=2.23 の結果は一致
  for (let t = 2; t < 2.23; t += 0.004) e1.render(t, cam, new SpriteBatch());
  const b1 = new SpriteBatch(), b2 = new SpriteBatch();
  e1.render(2.23, cam, b1); e2.render(2.23, cam, b2);
  assert.equal(b1.count, b2.count);
  assert.deepEqual(Array.from(b1.data.slice(0, b1.count * STRIDE)), Array.from(b2.data.slice(0, b2.count * STRIDE)));
  // 予約時刻より前は何も描かない
  const b0 = new SpriteBatch();
  e2.render(1.99, cam, b0);
  assert.equal(b0.count, 0);
});

test('VFX: PERFECT > GOOD の規模、MISS は寒色・揺れ小・コンボ切れ信号', () => {
  const e = new VfxEngine({ ...QUALITY_PRESETS.NORMAL });
  const p = hit(e, 'p', 'PERFECT', 0), g = hit(e, 'g', 'GOOD', 0), m = hit(e, 'm', 'MISS', 0);
  assert.ok(p.particles.length > g.particles.length);
  assert.ok(p.signals.shake > g.signals.shake && g.signals.shake > m.signals.shake);
  assert.equal(m.signals.comboBreak, true);
  assert.equal(m.signals.tint, 'cold');
  assert.equal(m.signals.floor, 0, 'MISS は床へ衝撃を伝えない');
});
