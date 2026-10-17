import test from 'node:test';
import assert from 'node:assert/strict';
import { Judge, RESULT } from '../src/judge.js';
import { AutoPlayer } from '../src/auto.js';

const mk = (spec) => spec.map(([t, cmd], i) => ({ id: `n${i}`, t, cmd }));

test('タイミングに応じて PERFECT / GOOD / 空振り が変わる', () => {
  const j = new Judge(mk([[1, 'A'], [2, 'A'], [3, 'A'], [4, 'A']]));
  assert.equal(j.input({ cmd: 'A', time: 1.079, source: 'k' }).result, RESULT.PERFECT);
  assert.equal(j.input({ cmd: 'A', time: 2.081, source: 'k' }).result, RESULT.GOOD);
  assert.equal(j.input({ cmd: 'A', time: 2.85, source: 'k' }).result, RESULT.GOOD); // -150ms
  assert.equal(j.input({ cmd: 'A', time: 3.6, source: 'k' }), null); // 幅外
  assert.equal(j.strayInputs, 1);
});

test('判定幅は設定で変更できる', () => {
  const j = new Judge(mk([[1, 'A']]), { perfect: 0.03, good: 0.06 });
  assert.equal(j.input({ cmd: 'A', time: 1.05, source: 'k' }).result, RESULT.GOOD);
  const j2 = new Judge(mk([[1, 'A']]), { perfect: 0.03, good: 0.06 });
  assert.equal(j2.input({ cmd: 'A', time: 1.07, source: 'k' }), null);
  assert.throws(() => new Judge([], { perfect: 0.2, good: 0.1 }));
});

test('違うコマンドは当たらない', () => {
  const j = new Judge(mk([[1, 'A']]));
  assert.equal(j.input({ cmd: 'B', time: 1, source: 'k' }), null);
  assert.equal(j.notes[0].result, null);
});

test('1入力が複数ノーツに重複して当たらない', () => {
  const j = new Judge(mk([[1.0, 'A'], [1.1, 'A']]));
  const e = j.input({ cmd: 'A', time: 1.05, source: 'k' });
  assert.ok(e);
  assert.equal(j.notes.filter((n) => n.result).length, 1);
});

test('同じ入力IDは二度処理されない（タッチ+クリック等の二重発火）', () => {
  const j = new Judge(mk([[1.0, 'A'], [1.1, 'A']]));
  assert.ok(j.input({ cmd: 'A', time: 1.0, source: 'touch', id: 'x1' }));
  assert.equal(j.input({ cmd: 'A', time: 1.1, source: 'touch', id: 'x1' }), null);
  assert.equal(j.counts.PERFECT, 1);
});

test('判定済みノーツには再度当たらない', () => {
  const j = new Judge(mk([[1, 'A']]));
  j.input({ cmd: 'A', time: 1, source: 'k' });
  assert.equal(j.input({ cmd: 'A', time: 1.01, source: 'k' }), null);
  assert.equal(j.counts.PERFECT, 1);
});

test('期限超過で MISS になりコンボがリセットされる', () => {
  const j = new Judge(mk([[1, 'A'], [2, 'A'], [3, 'A']]));
  j.input({ cmd: 'A', time: 1, source: 'k' });
  assert.equal(j.combo, 1);
  assert.equal(j.update(2.149).length, 0);
  const m = j.update(2.151);
  assert.equal(m.length, 1);
  assert.equal(m[0].result, RESULT.MISS);
  assert.equal(j.combo, 0);
  // MISS 済みには遅れて入力しても当たらない
  assert.equal(j.input({ cmd: 'A', time: 2.1, source: 'k' }), null);
  j.update(10);
  assert.ok(j.done);
  assert.deepEqual([j.counts.PERFECT, j.counts.GOOD, j.counts.MISS], [1, 0, 2]);
  assert.equal(j.maxCombo, 1);
});

test('AUTO: 全ノーツが1回ずつ PERFECT（delta=0）', () => {
  const notes = [];
  for (let i = 0; i < 200; i++) notes.push({ id: `n${i}`, t: 0.5 + i * 0.37, cmd: 'ABCD'[i % 4] });
  // 近接した同コマンドのノーツも含める
  notes.push({ id: 'close1', t: 100.0, cmd: 'A' }, { id: 'close2', t: 100.05, cmd: 'A' });
  const j = new Judge(notes);
  const a = new AutoPlayer(j);
  const judged = [];
  j.on((e) => e.type === 'judged' && judged.push(e));
  // 不規則なフレーム間隔（描画遅れ・長いスタッター）でも結果は同じ
  let t = 0;
  let k = 0;
  while (t < 110) {
    t += [0.016, 0.033, 0.5, 0.001, 1.2][k++ % 5];
    a.update(t);
    j.update(t);
  }
  assert.equal(judged.length, notes.length);
  assert.ok(judged.every((e) => e.result === RESULT.PERFECT && e.delta === 0 && e.source === 'auto'));
  assert.equal(new Set(judged.map((e) => e.note.id)).size, notes.length);
  assert.equal(j.maxCombo, notes.length);
  assert.equal(j.summary().achievement, 1);
});

test('AUTO: 同じ時刻で何度 update しても二重発火しない', () => {
  const j = new Judge(mk([[1, 'A'], [1, 'B']]));
  const a = new AutoPlayer(j);
  for (let i = 0; i < 5; i++) { a.update(1); a.update(0.5); a.update(1); }
  assert.equal(a.fired, 2);
  assert.equal(j.counts.PERFECT, 2);
});

test('一時停止中（時刻停止）に update を繰り返しても判定は増えない／再開後も重複しない', () => {
  const j = new Judge(mk([[1, 'A'], [2, 'B'], [3, 'C']]));
  const a = new AutoPlayer(j);
  a.update(1.5); j.update(1.5);
  // 一時停止: 時刻は 1.5 のまま。複数フレーム経過
  for (let i = 0; i < 100; i++) { a.update(1.5); j.update(1.5); }
  assert.equal(j.counts.PERFECT, 1);
  a.update(3.2); j.update(3.2);
  assert.equal(j.counts.PERFECT, 3);
  assert.equal(j.counts.MISS, 0);
});

test('リスタート: 新しい Judge/AutoPlayer で古い世代の入力IDが混ざらない', () => {
  const notes = mk([[1, 'A'], [2, 'B']]);
  const j1 = new Judge(notes);
  const a1 = new AutoPlayer(j1, { generation: 1 });
  a1.update(1.5);
  const j2 = new Judge(notes);
  const a2 = new AutoPlayer(j2, { generation: 2 });
  assert.equal(j2.counts.PERFECT, 0); // 元配列は変更されない
  a2.update(3);
  assert.equal(j2.counts.PERFECT, 2);
  assert.equal(j1.counts.PERFECT, 1);
});

test('MANUAL 混在: 人の入力で先に判定したノーツは AUTO が再判定しない', () => {
  const j = new Judge(mk([[1, 'A']]));
  const a = new AutoPlayer(j);
  j.input({ cmd: 'A', time: 0.95, source: 'keyboard' });
  a.update(2);
  assert.equal(a.fired, 0);
  assert.equal(j.counts.GOOD + j.counts.PERFECT, 1);
});
