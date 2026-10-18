import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_SOURCES } from '../src/three-stage.js';
import { findLimbBones } from '../src/vfx3d.js';
import { DISPLAY_MODES } from '../src/display-modes.js';

test('3D: スキン付き人体モデルを優先し、旧プロトタイプは代替としてだけ使う', () => {
  for (const id of ['kiva-3d', 'alexandre-3d']) {
    assert.equal(MODEL_SOURCES[id][0].kind, 'skinned');
    assert.match(MODEL_SOURCES[id][0].path, /^assets\/3d\/.+_seipai\.glb$/);
    assert.equal(MODEL_SOURCES[id].at(-1).kind, 'legacy');
    // デモ（補助動画の姿勢をつないだもの）はセーパイ用 GLB とは別名
    const demo = MODEL_SOURCES[id].find((s) => s.kind === 'demo');
    assert.match(demo.path, /_demo\.glb$/);
    assert.notEqual(demo.path, MODEL_SOURCES[id][0].path);
  }
});

test('3D: 未完成のモードは TECH PREVIEW と表示する', () => {
  for (const m of DISPLAY_MODES.filter((m) => m.kind === '3d')) assert.match(m.label, /TECH PREVIEW/);
  assert.match(DISPLAY_MODES.find((m) => m.id === 'alexandre-frames').label, /PREVIEW/);
});

test('VFX: 手足のボーン名は glTF 書き出しで "." が落ちても見つかる', () => {
  const bones = ['root', 'wristL', 'wrist.R', 'foot_L', 'footR', 'lowerarm01.L'].map((name) => ({ name, isBone: true }));
  const root = { traverse: (fn) => bones.forEach(fn) };
  const found = findLimbBones(root);
  assert.deepEqual(Object.keys(found).sort(), ['foot.L', 'foot.R', 'wrist.L', 'wrist.R']);
  assert.equal(found['wrist.L'].name, 'wristL');
});
