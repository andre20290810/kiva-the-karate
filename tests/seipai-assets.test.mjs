import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateChart, compileChart } from '../src/chart.js';

const root = resolve(import.meta.dirname, '..');
const chartPath = join(root, 'charts/seipai.chart.json');
const framePath = join(root, 'assets/seipai/frames.json');

test('Seipai candidate chart is explicit about unverified timing', () => {
  const chart = JSON.parse(readFileSync(chartPath, 'utf8'));
  assert.equal(chart.draft, true);
  assert.match(chart.annotation, /未検証/);
  assert.deepEqual(validateChart(chart).errors, []);
  assert.equal(chart.notes.length, 23);
  const compiled = compileChart(chart, 82.266667, 82.4);
  for (const n of compiled.notes) {
    assert.ok(Math.abs(compiled.warp.map(n.t) - n.move.src.kime) < 1e-6, n.id);
  }
});

test('Locally prepared Seipai frames and audio are complete', { skip: !existsSync(framePath) }, () => {
  const data = JSON.parse(readFileSync(framePath, 'utf8'));
  assert.equal(data.fps, 5);
  assert.equal(data.width, 576);
  assert.equal(data.height, 1024);
  assert.equal(data.frames.length, 412);
  for (let i = 0; i < data.frames.length; i++) {
    const f = data.frames[i];
    assert.equal(f.i, i);
    assert.ok(Math.abs(f.t - i / 5) < 0.001);
    assert.equal(f.bbox.length, 4);
    assert.ok(f.bbox[2] >= 0 && f.bbox[3] >= 0, f.file);
    assert.ok(existsSync(join(root, 'assets/seipai', f.file)), f.file);
  }
  assert.ok(statSync(join(root, 'assets/seipai/audio.m4a')).size > 100000);
});
