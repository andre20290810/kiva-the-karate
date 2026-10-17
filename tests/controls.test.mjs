import test from 'node:test';
import assert from 'node:assert/strict';
import { buildControlMap, PadProfiles, describePad, FACE } from '../src/controls.js';
import { InputRouter } from '../src/input.js';

const commands = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }];

class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.get(k) ?? null; }
  setItem(k, v) { this.m.set(k, String(v)); }
}

/** Gamepad API の擬似実装（実機ではなくエミュレーション） */
function fakePad({ index = 0, id = 'GameSir-T4 Cyclone (STANDARD GAMEPAD Vendor: 3537)', mapping = 'standard' } = {}) {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  return {
    index, id, mapping, connected: true, buttons,
    set(i, down) { buttons[i] = { pressed: down, value: down ? 1 : 0 }; },
  };
}

function rig(storage = new MemStorage()) {
  const map = buildControlMap(commands);
  const events = [];
  let pads = [];
  const r = new InputRouter(map, (e) => events.push(e), { storage, getGamepads: () => pads });
  return { map, events, r, setPads: (p) => { pads = p; } };
}

test('既定割り当て: 譜面コマンド順に A/B/X/Y、ひし形の位置と色が一元表から決まる', () => {
  const m = buildControlMap(commands);
  assert.deepEqual(commands.map((c) => m.buttonFor(c.id)), ['A', 'B', 'X', 'Y']);
  assert.equal(m.commandFor('Y'), 'D');
  assert.deepEqual(m.entries.map((e) => e.button), ['Y', 'X', 'B', 'A']);
  assert.equal(m.byButton.get('Y').pos, 'up');
  assert.equal(m.byButton.get('A').pos, 'down');
  assert.equal(FACE.X.pos, 'left');
  assert.equal(FACE.B.pos, 'right');
});

test('譜面側で button を指定でき、重複・不正は拒否', () => {
  const m = buildControlMap([{ id: 'p', button: 'Y' }, { id: 'q', button: 'A' }, { id: 'r', button: 'X' }, { id: 's', button: 'B' }]);
  assert.equal(m.commandFor('Y'), 'p');
  assert.throws(() => buildControlMap([{ id: 'p', button: 'Y' }, { id: 'q', button: 'Y' }, { id: 'r' }, { id: 's' }]));
  assert.throws(() => buildControlMap([{ id: 'p', button: 'Z' }, { id: 'q' }, { id: 'r' }, { id: 's' }]));
});

test('標準ゲームパッド: ABXY と十字キーが同じ論理ボタンになる（立ち上がりのみ）', () => {
  const { events, r, setPads } = rig();
  const p = fakePad();
  setPads([p]);
  r.pollGamepads(0); // 接続直後は基準取りのみ
  p.set(0, true); r.pollGamepads(10);  // A
  r.pollGamepads(20);                  // 保持 → 発火しない
  p.set(0, false); r.pollGamepads(30);
  p.set(3, true); r.pollGamepads(40);  // Y
  p.set(3, false); p.set(14, true); r.pollGamepads(50); // 十字左 = X
  assert.deepEqual(events.map((e) => [e.button, e.cmd]), [['A', 'A'], ['Y', 'D'], ['X', 'C']]);
  assert.equal(events[0].perfMs, 10);
});

test('同時押し: 同一ポーリングで複数ボタンがそれぞれ1回ずつ入力される', () => {
  const { events, r, setPads } = rig();
  const p = fakePad();
  setPads([p]);
  r.pollGamepads(0);
  p.set(0, true); p.set(1, true); r.pollGamepads(5);
  assert.deepEqual(events.map((e) => e.button).sort(), ['A', 'B']);
  assert.equal(new Set(events.map((e) => e.id)).size, 2);
});

test('連続入力: 押す→離す→押すで2回入力', () => {
  const { events, r, setPads } = rig();
  const p = fakePad();
  setPads([p]);
  r.pollGamepads(0);
  for (let k = 0; k < 5; k++) { p.set(1, true); r.pollGamepads(k * 20 + 1); p.set(1, false); r.pollGamepads(k * 20 + 10); }
  assert.equal(events.length, 5);
});

test('接続時に押しっぱなしでも入力にならない・切断で押下表示が解除・再接続で復帰', () => {
  const { events, r, setPads } = rig();
  const p = fakePad();
  p.set(0, true);
  setPads([p]);
  const held = [];
  r.onHeldChange = (b, d) => held.push(`${b}${d ? '+' : '-'}`);
  r.pollGamepads(0);
  r.pollGamepads(16);
  assert.equal(events.length, 0);
  p.set(0, false); r.pollGamepads(32);
  p.set(2, true); r.pollGamepads(48);
  assert.equal(events.length, 1);
  assert.ok(r.isHeld('X'));
  setPads([]); r.pollGamepads(64); // 切断
  assert.ok(!r.isHeld('X'));
  assert.deepEqual(held, ['X+', 'X-']);
  const p2 = fakePad({ index: 1 });
  setPads([p2]); r.pollGamepads(80); // 再接続（別 index）
  p2.set(3, true); r.pollGamepads(96);
  assert.deepEqual(events.map((e) => e.button), ['X', 'Y']);
  assert.equal(r.gamepads[0].vendor, 'GameSir');
});

test('キャリブレーション結果を保存し、非標準配置のパッドに適用する', () => {
  const storage = new MemStorage();
  const prof = new PadProfiles(storage);
  const id = 'GameSir-G7 (Vendor: 3537 Product: 1010)';
  prof.set(id, { A: 1, B: 2, X: 0, Y: 3 });
  assert.throws(() => prof.set(id, { A: 1, B: 1, X: 0, Y: 3 }));
  const { events, r, setPads } = rig(storage);
  const p = fakePad({ id, mapping: '' });
  setPads([p]);
  r.pollGamepads(0);
  p.set(1, true); r.pollGamepads(10);
  p.set(1, false); p.set(0, true); r.pollGamepads(20);
  assert.deepEqual(events.map((e) => e.button), ['A', 'X']);
  assert.equal(r.gamepads[0].profile, 'calibrated');
  assert.equal(new PadProfiles(storage).get(id, '').name, 'calibrated');
});

test('キャプチャ中（キャリブレーション）はゲーム入力にしない', () => {
  const { events, r, setPads } = rig();
  const p = fakePad();
  setPads([p]);
  r.pollGamepads(0);
  const got = [];
  r.capture = ({ index }) => got.push(index);
  p.set(5, true); r.pollGamepads(10);
  r.capture = null;
  assert.deepEqual(got, [5]);
  assert.equal(events.length, 0);
});

test('デバイス種別の表示', () => {
  assert.equal(describePad('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)', 'standard').vendor, 'Xbox 互換 (XInput)');
  assert.equal(describePad('GameSir T4k', '').standard, false);
});
