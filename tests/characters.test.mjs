import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { characterList, validateCharacterFrames, CharacterSelector, STATUS } from '../src/characters.js';

const base = { fps: 5, frames: Array.from({ length: 412 }, (_, i) => ({ t: i / 5, file: `f${i}.webp` })) };
class Mem { constructor() { this.m = new Map(); } getItem(k) { return this.m.get(k) ?? null; } setItem(k, v) { this.m.set(k, String(v)); } }

test('譜面に characters が無ければ KIVA（譜面の frames）だけ', () => {
  const l = characterList({ frames: '../assets/seipai/frames.json' });
  assert.equal(l.length, 1);
  assert.equal(l[0].name, 'KIVA');
  assert.equal(l[0].base, true);
});

test('本番譜面: KIVA ⇄ ALEXANDRE。ALEXANDRE は未完成（pending）として定義', () => {
  const chart = JSON.parse(readFileSync(new URL('../charts/seipai.chart.json', import.meta.url)));
  const l = characterList(chart);
  assert.deepEqual(l.map((c) => c.name), ['KIVA', 'ALEXANDRE']);
  assert.equal(l[0].frames, chart.frames, 'KIVA は既存のセーパイ演武フレーム');
  assert.equal(l[1].status, STATUS.PENDING);
  assert.ok(l[1].references.includes('alexandre.mp4'));
});

test('別キャラクターのフレームは基準と同じ時間軸（fps・枚数・各コマの時刻）でなければ使わない', () => {
  const ok = { fps: 5, width: 576, height: 1024, frames: base.frames.map((f) => ({ ...f })) };
  assert.equal(validateCharacterFrames(base, ok).ok, true);
  assert.match(validateCharacterFrames(base, { ...ok, fps: 30 }).reason, /fps/);
  assert.match(validateCharacterFrames(base, { ...ok, frames: ok.frames.slice(1) }).reason, /フレーム数/);
  const shifted = { ...ok, frames: ok.frames.map((f, i) => ({ ...f, t: i === 100 ? f.t + 0.1 : f.t })) };
  assert.match(validateCharacterFrames(base, shifted).reason, /フレーム 100 の時刻/);
  assert.match(validateCharacterFrames(base, { ...ok, width: 0 }).reason, /画像サイズ/);
  assert.equal(validateCharacterFrames(base, null).ok, false);
});

test('ボタンを押すたびに KIVA → ALEXANDRE → KIVA と切り替わり、選択は保存される', () => {
  const list = characterList({ frames: 'a.json', characters: [{ id: 'kiva', name: 'KIVA', frames: 'a.json' }, { id: 'alexandre', name: 'ALEXANDRE', frames: 'b.json', status: 'pending' }] });
  const mem = new Mem();
  const s = new CharacterSelector(list, mem);
  assert.equal(s.current.name, 'KIVA');
  assert.equal(s.next().name, 'ALEXANDRE');
  assert.equal(new CharacterSelector(list, mem).current.name, 'ALEXANDRE', '次回も同じ選択');
  assert.equal(s.next().name, 'KIVA');
  assert.equal(s.label(), 'KIVA ⇄ ALEXANDRE');
  assert.equal(new CharacterSelector(list, null).current.name, 'KIVA', '保存できない環境でも動作');
});

test('id の重複は拒否', () => {
  assert.throws(() => characterList({ characters: [{ id: 'a', frames: 'x' }, { id: 'a', frames: 'y' }] }));
});
