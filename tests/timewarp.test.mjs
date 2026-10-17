import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWarp } from '../src/timewarp.js';
import { compileChart, validateChart } from '../src/chart.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('決めの元動画時刻が判定時刻に正確に一致する', () => {
  const anchors = [
    { t: 2.0, kime: 1.8 },
    { t: 3.0, kime: 2.4 },
    { t: 4.5, kime: 4.6 },
  ];
  const w = buildWarp(anchors, { start: { t: 0, v: 0 }, end: { t: 10, v: 10 } });
  for (const a of anchors) close(w.map(a.t), a.kime);
});

test('写像は単調増加（逆再生しない）', () => {
  const anchors = [];
  let v = 0;
  for (let i = 0; i < 50; i++) { v += 0.3 + (i % 3) * 0.4; anchors.push({ t: 1 + i * 0.8, kime: v }); }
  const w = buildWarp(anchors, { start: { t: 0, v: 0 }, end: { t: 60, v: 80 } });
  let prev = -Infinity;
  for (let t = 0; t <= 60; t += 0.01) {
    const x = w.map(t);
    assert.ok(x >= prev - 1e-12, `t=${t}`);
    prev = x;
  }
});

test('元動画区間が短いときは決めポーズを保持する', () => {
  const w = buildWarp([{ t: 1, kime: 1 }, { t: 3, kime: 2 }], { start: { t: 0, v: 0 }, end: { t: 4, v: 3 } });
  const hold = w.segments.find((s) => s.kind === 'hold');
  assert.ok(hold);
  close(hold.v0, 1);
  close(w.map(1.5), 1);
});

test('長尺でも累積ずれがない（100ノーツ目も正確）', () => {
  const anchors = [];
  for (let i = 0; i < 100; i++) anchors.push({ t: 0.5 + i * 0.6 + 0.0001 * i, kime: 0.5 + i * 0.61 });
  const w = buildWarp(anchors, { start: { t: 0, v: 0 }, end: { t: 70, v: 70 } });
  for (const a of anchors) close(w.map(a.t), a.kime, 1e-9);
});

test('極端な早送りは警告する', () => {
  const w = buildWarp([{ t: 1, kime: 1 }, { t: 1.5, kime: 3 }], { start: { t: 0, v: 0 }, end: { t: 5, v: 5 } });
  assert.ok(w.warnings.some((m) => m.includes('範囲外')));
});

const baseChart = () => ({
  audio: 'a.m4a', frames: 'f.json',
  commands: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
  moves: [
    { id: 'm1', src: { start: 0.5, kime: 1.0, end: 1.4 }, fx: [{ type: 'impact', at: { x: 1, y: 2 } }] },
    { id: 'm2', src: { start: 1.4, kime: 2.0, end: 2.6 } },
  ],
  notes: [{ id: 'n1', t: 1.1, cmd: 'A', move: 'm1' }, { id: 'n2', t: 2.1, cmd: 'B', move: 'm2' }],
});

test('譜面検証: 正常な譜面はエラーなし、コンパイルで決めが判定時刻に揃う', () => {
  const c = baseChart();
  assert.deepEqual(validateChart(c).errors, []);
  const r = compileChart(c, 5, 5);
  close(r.warp.map(1.1), 1.0);
  close(r.warp.map(2.1), 2.0);
  assert.equal(r.notes[0].fx[0].type, 'impact');
});

test('譜面検証: 型の順序の逆転・未定義コマンド・重複IDを検出', () => {
  const c = baseChart();
  c.notes[1].move = 'm1';
  c.notes.push({ id: 'n1', t: 3, cmd: 'Z', move: 'm2' });
  const { errors } = validateChart(c);
  assert.ok(errors.some((e) => e.includes('重複')));
  assert.ok(errors.some((e) => e.includes('未定義のコマンド')));
  const c2 = baseChart();
  c2.notes[0].move = 'm2'; c2.notes[1].move = 'm1';
  assert.ok(validateChart(c2).errors.some((e) => e.includes('順序')));
  assert.throws(() => compileChart(c2, 5, 5));
});
