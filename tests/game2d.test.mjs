import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateChart, normalizeChart, exportChart, parseChartText, makeNote, newNoteId, DEFAULT_SETTINGS } from '../app/chart.js';
import { Judge, GRADE } from '../app/judge.js';
import { AutoPlayer } from '../app/auto.js';

const base = () => ({
  schemaVersion: 1, title: 't',
  source: { frameManifest: 'assets/seipai/manifest.json', frameCount: 412, frameIntervalSeconds: 0.2, durationSeconds: 82.266667 },
  settings: { ...DEFAULT_SETTINGS },
  sequences: [{ id: 'opening', label: '呼吸・構え・二連突き' }],
  notes: [
    { id: 'n001', time: 1.0, button: 'Y', action: 'breathe', input: 'hold', duration: 2.0, label: '呼吸', sequenceId: 'opening' },
    { id: 'n002', time: 4.0, button: 'X', action: 'stance', input: 'tap', label: '構え', sequenceId: 'opening' },
    { id: 'n003', time: 5.0, button: 'A', action: 'punch', input: 'tap', label: '正拳突き', sequenceId: 'opening' },
    { id: 'n004', time: 5.6, button: 'A', action: 'punch', input: 'tap', label: '正拳突き', sequenceId: 'opening',
      effect: { preset: 'strike', anchor: { x: 0.6, y: 0.4 }, direction: { x: 1, y: 0 }, intensity: 1 } },
  ],
});
const S = { perfectWindowMs: 60, goodWindowMs: 120, missWindowMs: 180, holdReleaseWindowMs: 150 };

test('検証: 正しい譜面は通る', () => {
  assert.deepEqual(validateChart(base()).errors, []);
});

test('検証: 版・範囲・長押し・ID 重複・ボタンと action の対応', () => {
  const bad = (f) => { const c = base(); f(c); return validateChart(c, { frameCount: 412 }).errors.join('\n'); };
  assert.match(bad((c) => { c.schemaVersion = 2; }), /schemaVersion/);
  assert.match(bad((c) => { c.notes[1].time = 90; }), /範囲外/);
  assert.match(bad((c) => { c.notes[1].time = -1; }), /範囲外/);
  assert.match(bad((c) => { c.notes[0].duration = 0; }), /長押し時間/);
  assert.match(bad((c) => { c.notes[0].time = 81; }), /長押しが全体の長さ/);
  assert.match(bad((c) => { c.notes[2].id = 'n002'; }), /重複/);
  assert.match(bad((c) => { c.notes[1].action = 'punch'; }), /action/);
  assert.match(bad((c) => { c.notes[2].input = 'hold'; c.notes[2].duration = 1; }), /入力方式/);
  assert.match(bad((c) => { c.notes[2].sequenceId = 'nope'; }), /sequences にありません/);
  assert.match(bad((c) => { c.notes[3].effect.anchor.x = 1.5; }), /anchor/);
  assert.match(bad((c) => { c.notes.push({ id: 'n9', time: 2.0, button: 'Y', action: 'breathe', input: 'hold', duration: 1 }); }), /重なって/);
  assert.match(bad((c) => { c.display = { frameOverrides: { 999: { dx: 0 } } }; }), /範囲外/);
});

test('JSON 書き出し → 読み込み → 再書き出しで同一', () => {
  const c = base();
  c.display = { subjectAnchor: { x: 0.5, y: 0.5 }, referenceHeightRatio: 0.5, frameOverrides: { 12: { dx: 0.01, dy: -0.02, scale: 1.05 } } };
  c.memo = ['冒頭の呼吸の長さは要調整'];
  const t1 = exportChart(c);
  const r = parseChartText(t1, { frameCount: 412 });
  assert.equal(r.ok, true, r.errors?.join('\n'));
  const t2 = exportChart(r.chart);
  assert.equal(t2, t1);
  assert.equal(JSON.parse(t2).display.frameOverrides['12'].scale, 1.05);
  assert.equal(JSON.parse(t2).notes[0].duration, 2);
});

test('不正な JSON は読み込まない', () => {
  assert.equal(parseChartText('{').ok, false);
  assert.equal(parseChartText('{"schemaVersion":1}').ok, false);
  const r = parseChartText(JSON.stringify(base()), { frameCount: 300 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /412/);
});

test('ノーツ ID は重複しない', () => {
  const n = base().notes;
  assert.equal(newNoteId(n), 'n005');
  const m = makeNote(n, 'A', 7, { action: 'kick' });
  assert.equal(m.action, 'kick');
  assert.equal(m.input, 'tap');
  assert.equal(makeNote(n, 'Y', 7).input, 'hold');
});

test('判定: PERFECT / GOOD / 許容限界内の MISS / 空振り', () => {
  const j = new Judge(normalizeChart(base()).notes, S);
  assert.equal(j.press('X', 4.05).grade, GRADE.PERFECT);
  assert.equal(j.press('A', 5.1).grade, GRADE.GOOD);
  assert.equal(j.press('A', 5.6 + 0.15).grade, GRADE.MISS);
  assert.equal(j.press('B', 10), null); // 譜面にないボタン
  assert.equal(j.stray, 1);
});

test('A 2 回は 2 個のノーツとして別々に判定', () => {
  const j = new Judge(normalizeChart(base()).notes, S);
  assert.equal(j.press('A', 5.0).note.id, 'n003');
  assert.equal(j.press('A', 5.6).note.id, 'n004');
  assert.equal(j.summary().perfect, 2);
});

test('同じ入力 ID は二重に加点しない', () => {
  const j = new Judge(normalizeChart(base()).notes, S);
  j.press('X', 4.0, { id: 'p:1' });
  assert.equal(j.press('X', 4.0, { id: 'p:1' }), null);
  assert.equal(j.summary().perfect, 1);
});

test('長押し: 必要時間を保持すると成功、早すぎる離しは MISS', () => {
  let j = new Judge(normalizeChart(base()).notes, S);
  assert.equal(j.press('Y', 1.02).type, 'holdStart');
  assert.equal(j.update(2.0).length, 0);
  assert.equal(j.holdProgress(j.byId.get('n001'), 2.0), 0.5);
  const done = j.update(3.0);
  assert.equal(done[0].grade, GRADE.PERFECT);
  j = new Judge(normalizeChart(base()).notes, S);
  j.press('Y', 1.0);
  assert.equal(j.release('Y', 2.0)[0].grade, GRADE.MISS);
  assert.equal(j.byId.get('n001').reason, 'early-release');
  j = new Judge(normalizeChart(base()).notes, S);
  j.press('Y', 1.0);
  assert.equal(j.release('Y', 2.9)[0].grade, GRADE.PERFECT); // 終了の 0.15 秒前までは成功
});

test('長押し: 一時停止中の実時間は加算しない（時間軸の時刻だけで判定）', () => {
  const j = new Judge(normalizeChart(base()).notes, S);
  j.press('Y', 1.0);
  // 一時停止で時間軸は 1.5 のまま。何度 update しても完了しない
  for (let k = 0; k < 10; k++) assert.equal(j.update(1.5).length, 0);
  assert.equal(j.byId.get('n001').result, null);
});

test('期限を過ぎた未入力は MISS', () => {
  const j = new Judge(normalizeChart(base()).notes, S);
  const ev = j.update(4.0 + 0.181);
  assert.deepEqual(ev.map((e) => [e.note.id, e.grade]), [['n001', 'MISS'], ['n002', 'MISS']]);
});

test('シーク・ループで判定状態を初期化し、二重加点しない', () => {
  const j = new Judge(normalizeChart(base()).notes, S);
  j.press('X', 4.0); j.press('A', 5.0);
  assert.equal(j.summary().score > 0, true);
  j.resetFrom(4.5); // 4.5 秒へシーク
  const s = j.summary();
  assert.equal(j.byId.get('n003').result, null);
  assert.equal(j.byId.get('n002').result, GRADE.PERFECT);
  assert.equal(j.byId.get('n001').result, GRADE.SKIP);
  j.press('A', 5.0);
  j.resetFrom(4.5);
  j.press('A', 5.0);
  assert.equal(j.summary().perfect, 2); // n002 + n003（n003 は 1 回分だけ）
  assert.equal(s.skip, 1);
});

test('AUTO: 全ノーツを 1 回ずつ、長押しは保持して離す。フレーム落ちでも取りこぼさない', () => {
  const j = new Judge(normalizeChart(base()).notes, S);
  const a = new AutoPlayer(j);
  a.update(0.5);
  a.update(10.0); // 大きく時刻をまたぐ（フレーム落ち）
  j.update(10.0);
  const s = j.summary();
  assert.equal(s.perfect, 4);
  assert.equal(s.miss, 0);
  a.update(20); j.update(20);
  assert.equal(j.summary().perfect, 4);
});

test('AUTO: 途中から開始しても過去のノーツをまとめて成立させない', () => {
  const j = new Judge(normalizeChart(base()).notes, S);
  j.resetFrom(4.5);
  const a = new AutoPlayer(j);
  a.reset(4.5);
  a.update(10); j.update(10);
  const s = j.summary();
  assert.equal(s.perfect, 2);
  assert.equal(s.skip, 2);
});

test('AUTO: 長押しの途中でシークしても押しっぱなしが残らない', () => {
  const j = new Judge(normalizeChart(base()).notes, S);
  const a = new AutoPlayer(j);
  a.update(1.5);
  assert.equal(a.active.length, 1);
  j.resetFrom(0.5); a.reset(0.5);
  assert.equal(a.active.length, 0);
  assert.equal(j.byId.get('n001').holding, false);
  a.update(3.5); j.update(3.5);
  assert.equal(j.byId.get('n001').result, GRADE.PERFECT);
});

test('初期譜面ファイルが検証を通る', () => {
  const c = JSON.parse(readFileSync(new URL('../charts/seipai.json', import.meta.url)));
  const r = validateChart(c, { frameCount: 412 });
  assert.deepEqual(r.errors, []);
  assert.ok(c.notes.length >= 10);
  // 冒頭: Y 長押し → X → A
  const head = normalizeChart(c).notes.slice(0, 3).map((n) => n.button).join('');
  assert.equal(head, 'YXA'); // 2 回目の A は映像に見当たらないため置いていない（譜面の memo 参照）
});
