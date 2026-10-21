// 視覚エフェクトの番号・既定・保存形式（DOM 不要）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EFFECTS, EFFECT_BY_ID, DEFAULT_EFFECT_ID, effectIdOf, resolveEffect, effectForId, validateEffect, migrateEffect } from '../app/effects-catalog.js';
import { validateChart, normalizeChart, exportChart, parseChartText } from '../app/chart.js';

const chart = JSON.parse(readFileSync(new URL('../charts/seipai_v2.json', import.meta.url)));
const note = (o) => ({ id: 'n900', time: 10, button: 'X', action: 'stance', input: 'tap', ...o });

test('エフェクト番号は固定（0〜4。5「背後にまとう炎」は廃止して欠番）', () => {
  const ids = EFFECTS.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, '番号が重複しない');
  assert.deepEqual(Object.fromEntries(EFFECTS.map((e) => [e.id, e.key])), { 0: 'none', 1: 'breath', 2: 'stance', 3: 'strike', 4: 'turn' });
  assert.ok(!EFFECT_BY_ID.has(5));
  assert.deepEqual({ ...DEFAULT_EFFECT_ID }, { Y: 1, X: 2, A: 3, B: 4 });
});

test('未編集の息ノーツは呼吸の気。個別に指定したノーツは上書きしない', () => {
  assert.equal(effectIdOf(note({ button: 'Y', input: 'hold', duration: 2, effect: { preset: 'breath', intensity: 1 } })), 1);
  assert.equal(effectIdOf(note({ button: 'Y', input: 'hold', duration: 2 })), 1);
  assert.equal(effectIdOf(note({ button: 'Y', input: 'hold', duration: 2, effect: { id: 0 } })), 0, '番号で指定済み');
  const by = {};
  for (const n of chart.notes) by[`${n.button}:${resolveEffect(n).key}`] = (by[`${n.button}:${resolveEffect(n).key}`] || 0) + 1;
  assert.deepEqual(by, { 'Y:breath': 11, 'X:stance': 23, 'A:strike': 10, 'B:turn': 15 });
});

test('保存済みの No.5 は、息なら No.1、それ以外は No.0 に置き換え、ほかの編集内容は保つ', () => {
  const y = note({ button: 'Y', input: 'hold', duration: 2.4, effect: { id: 5, height: 1.4, width: 0.8, intensity: 1.6, offset: { x: 0.1, y: 0 }, duration: 1.2 } });
  assert.deepEqual(migrateEffect(y), { id: 1, intensity: 1.6, offset: { x: 0.1, y: 0 }, duration: 1.2 });
  assert.deepEqual(migrateEffect(note({ effect: { id: 5, size: 1.3 } })), { id: 0, size: 1.3 });
  assert.deepEqual(migrateEffect(note({ effect: { preset: 'backFire' } })), { id: 0 });
  assert.equal(resolveEffect(y).key, 'breath');
  // JSON として読み込むと置き換わり、時刻・コマンド・frameOverrides は変わらない
  const c = structuredClone(chart);
  c.display = { ...(c.display || {}), frameOverrides: { 12: { dx: 0.01, dy: 0, scale: 1.05 } } };
  const yi = c.notes.findIndex((n) => n.button === 'Y'), xi = c.notes.findIndex((n) => n.button === 'X');
  c.notes[yi].effect = { id: 5, height: 1.4, intensity: 1.5 };
  c.notes[xi].effect = { id: 5, size: 1.2 };
  c.notes[xi].label = '構え（編集）';
  const r = parseChartText(JSON.stringify(c), { gameVersion: 'v2' });
  assert.ok(r.ok, r.errors?.join());
  const y2 = r.chart.notes.find((n) => n.id === c.notes[yi].id), x2 = r.chart.notes.find((n) => n.id === c.notes[xi].id);
  assert.deepEqual(y2.effect, { id: 1, intensity: 1.5 });
  assert.deepEqual(x2.effect, { id: 0, size: 1.2 });
  assert.equal(x2.label, '構え（編集）'); assert.equal(x2.time, c.notes[xi].time); assert.equal(y2.duration, c.notes[yi].duration);
  assert.deepEqual(r.chart.display.frameOverrides, { 12: { dx: 0.01, dy: 0, scale: 1.05 } });
  assert.ok(!exportChart(r.chart).includes('"id": 5'), '書き出しに 5 は残らない');
});

test('従来の打撃の direction は角度として読め、方向を持たないエフェクトでは向きを使わない', () => {
  const r = resolveEffect(note({ button: 'A', action: 'punch', effect: { preset: 'strike', anchor: { x: 0.4, y: 0.4 }, direction: { x: 0, y: -1 }, intensity: 1 } }));
  assert.equal(r.id, 3); assert.equal(r.angle, -90); assert.equal(r.origin, 'point');
  const s = resolveEffect(note({ effect: { id: 2, angle: 45 } }));
  assert.equal(s.angle, null); assert.equal(s.direction, null);
});

test('種類を変えると前の方向・位置・大きさは残らない', () => {
  assert.deepEqual(effectForId(2, { anchor: { x: 0.4, y: 0.4 }, angle: 30 }), { id: 2 });
  assert.deepEqual(effectForId(3, { anchor: { x: 0.4, y: 0.4 }, angle: 30 }), { id: 3, origin: 'point', anchor: { x: 0.4, y: 0.4 }, angle: 30 });
});

test('検証: 範囲外・未知の番号は拒否、正しい値は通る', () => {
  assert.deepEqual(validateEffect({ id: 1, origin: 'torso', offset: { x: 0.1, y: -0.2 }, size: 1.2, intensity: 1.5, duration: 1.4 }, 'n'), []);
  assert.deepEqual(validateEffect({ id: 5, height: 1.3 }, 'n'), [], '廃止した番号は読み込める（置き換える）');
  assert.ok(validateEffect({ id: 99 }, 'n').length);
  assert.ok(validateEffect({ id: 3, origin: 'elbow' }, 'n').length);
  assert.ok(validateEffect({ id: 1, size: 9 }, 'n').length);
  assert.ok(validateEffect({ id: 3, offset: { x: 3, y: 0 } }, 'n').length);
});

test('ノーツ単位の設定は JSON の書き出し・読み込みで保たれ、他のノーツに影響しない。従来の JSON も読める', () => {
  const c = normalizeChart(chart);
  const target = c.notes.find((n) => n.button === 'A');
  const before = c.notes.filter((n) => n.id !== target.id).map((n) => JSON.stringify(n));
  // 誤って撃になっている所を構へ: コマンド・入力・エフェクトがそろう
  target.button = 'X'; target.action = 'stance'; target.input = 'tap'; target.label = '構え';
  target.effect = { id: 2, origin: 'torso', offset: { x: 0.05, y: -0.1 }, size: 1.3, intensity: 1.6, duration: 0.9 };
  assert.deepEqual(validateChart(c, { gameVersion: 'v2' }).errors, []);
  const r = parseChartText(exportChart(c), { gameVersion: 'v2' });
  assert.ok(r.ok, r.errors?.join());
  const back = r.chart.notes.find((n) => n.id === target.id);
  assert.deepEqual(back.effect, target.effect);
  assert.equal(back.button, 'X');
  assert.deepEqual(r.chart.notes.filter((n) => n.id !== target.id).map((n) => JSON.stringify(n)), before, '他のノーツは変わらない');
  assert.deepEqual(r.chart.display.frameOverrides, c.display.frameOverrides, 'frameOverrides を保つ');
  // effect のない従来の JSON
  const legacy = structuredClone(chart);
  for (const n of legacy.notes) delete n.effect;
  assert.deepEqual(validateChart(legacy, { gameVersion: 'v2' }).errors, []);
  assert.equal(resolveEffect(legacy.notes.find((n) => n.button === 'Y')).key, 'breath');
});
