// 判定の境界・入力の記録・成績の集計・比較・履歴（DOM 不要）
import test from 'node:test';
import assert from 'node:assert/strict';
import { Judge, diffMs } from '../app/judge.js';
import { AutoPlayer } from '../app/auto.js';
import { validateTiming, fillSettings, DEFAULT_SETTINGS } from '../app/chart.js';
import { buildRecord, summarize, compareRecords, comparisonTargets, conditionDiffs, recordError, chartHash } from '../app/score.js';
import { ScoreHistory } from '../app/history.js';

const S = fillSettings({}); // PERFECT 60 / GOOD 120 / 許容限界 180 / 息の押し始め 120 / 早離し 150
const tap = (id, time, button = 'X') => ({ id, time, button, input: 'tap', action: 'stance' });
const hold = (id, time, duration, button = 'Y') => ({ id, time, button, input: 'hold', duration, action: 'breathe' });
const chartOf = (notes) => ({ title: 't', gameVersion: 'v2', notes });
const rec = (j, notes, extra = {}) => buildRecord(j, { chart: chartOf(notes), settings: S, rate: 1, mode: 'manual', kind: 'full', ...extra });
let seq = 0;
const press = (j, b, t, o = {}) => j.press(b, t, { id: `k${++seq}`, source: 'key', device: 'keyboard', raw: t, ...o });

test('判定の境界: 境界ちょうどは内側、0.1ms 外は外側（浮動小数の誤差に左右されない）', () => {
  const at = (dMs) => { const n = [tap('n1', 10.17)]; const j = new Judge(n, S); press(j, 'X', 10.17 + dMs / 1000); j.update(20); return j.notes[0]; };
  assert.equal(at(-60).result, 'PERFECT'); assert.equal(at(60).result, 'PERFECT');
  assert.equal(at(60.1).result, 'GOOD'); assert.equal(at(-60.1).result, 'GOOD');
  assert.equal(at(120).result, 'GOOD'); assert.equal(at(-120).result, 'GOOD');
  assert.equal(at(120.1).result, 'MISS'); assert.equal(at(120.1).hit.deltaMs, 120.1, '範囲外でも許容限界の内側なら入力ありの MISS');
  assert.equal(at(180).result, 'MISS'); assert.equal(at(180).reason, 'late');
  const out = at(180.1);
  assert.equal(out.result, 'MISS'); assert.equal(out.hit, null, '許容限界の外は入力なしの MISS（余分な入力として別に記録）');
  assert.equal(diffMs(10.23, 10.17), 60);
});

test('ずれの符号: マイナスが早い、プラスが遅い。入力補正の前の時刻も残す', () => {
  const j = new Judge([tap('a', 5), tap('b', 6)], S);
  press(j, 'X', 4.97, { raw: 4.99 });
  press(j, 'X', 6.045, { raw: 6.065 });
  const r = rec(j, [tap('a', 5), tap('b', 6)]);
  assert.deepEqual(r.notes.map((n) => n.input.deltaMs), [-30, 45]);
  assert.deepEqual(r.notes.map((n) => n.input.rawDeltaMs), [-10, 65]);
  assert.equal(r.summary.meanMs, 7.5); assert.equal(r.summary.maeMs, 37.5);
});

test('入力なし・余分な入力・間違ったボタン・二重の入力を区別し、付け替えない', () => {
  const notes = [tap('a', 5), tap('b', 7, 'A')];
  const j = new Judge(notes, S);
  press(j, 'B', 5.0);                       // 間違ったボタン → 余分な入力
  press(j, 'X', 6.0);                       // 範囲外 → 余分な入力
  j.press('A', 7.01, { id: 'same', source: 'pointer', device: 'touch', raw: 7.01 });
  j.press('A', 7.01, { id: 'same', source: 'pointer', device: 'touch', raw: 7.01 }); // 同じ入力（二重）は 1 回
  press(j, 'X', 5.4);                       // a の判定後: 付け替えない
  j.update(9);
  const r = rec(j, notes);
  const a = r.notes.find((n) => n.id === 'a'), b = r.notes.find((n) => n.id === 'b');
  assert.equal(a.result, 'MISS'); assert.equal(a.input, null, '入力なしの MISS に時刻・ずれを入れない'); assert.equal(a.reason, 'timeout');
  assert.equal(b.result, 'PERFECT'); assert.equal(b.input.device, 'touch');
  assert.equal(r.extras.length, 3);
  assert.deepEqual(r.extras.map((x) => x.button), ['B', 'X', 'X']);
  assert.equal(r.summary.missNoInput, 1); assert.equal(r.summary.timed, 1);
});

test('同時入力・長押し中の別ボタン入力はそれぞれのノーツに当たる', () => {
  const notes = [hold('y', 10, 2), tap('x', 10), tap('x2', 11)];
  const j = new Judge(notes, S);
  press(j, 'Y', 10.01); press(j, 'X', 9.99);
  j.update(10.5);
  press(j, 'X', 11.02);                     // 長押し中に別のボタン
  j.update(12.2);
  j.release('Y', 12.4, { raw: 12.4, device: 'keyboard' });
  const r = rec(j, notes);
  const m = Object.fromEntries(r.notes.map((n) => [n.id, n]));
  assert.equal(m.y.result, 'PERFECT'); assert.equal(m.x.result, 'PERFECT'); assert.equal(m.x2.result, 'PERFECT');
  assert.equal(m.x.input.deltaMs, -10); assert.equal(m.x2.input.deltaMs, 20);
});

test('長押し: 押し始め・離した時刻・必要な保持・実際の保持・早離し。自動の完了時刻を離した時刻にしない', () => {
  // 1) 必要な時間を保持 → 完了（終了の時刻）→ その後に実際に離す
  let n = [hold('y', 10, 2)], j = new Judge(n, S);
  press(j, 'Y', 9.95); j.update(12.0); j.update(12.1);
  let r0 = rec(j, n).notes[0];
  assert.equal(r0.result, 'PERFECT'); assert.equal(r0.hold.completedAt, 12); assert.equal(r0.hold.releasedAt, null, '離す前は離した時刻なし'); assert.equal(r0.hold.status, 'completed-held');
  j.release('Y', 12.35, { raw: 12.35, device: 'keyboard' });
  r0 = rec(j, n).notes[0];
  assert.equal(r0.hold.releasedAt, 12.35); assert.equal(r0.hold.releaseDeltaMs, 350); assert.equal(r0.hold.heldSec, 2.4); assert.equal(r0.hold.status, 'completed-released');
  assert.equal(r0.hold.requiredSec, 1.85); assert.equal(r0.input.deltaMs, -50);
  // 2) 早離し（終了の 0.15 秒より前）
  n = [hold('y', 10, 2)]; j = new Judge(n, S);
  press(j, 'Y', 10.0); j.update(11); j.release('Y', 11.5, { raw: 11.5 });
  r0 = rec(j, n).notes[0];
  assert.equal(r0.result, 'MISS'); assert.equal(r0.reason, 'early-release'); assert.equal(r0.hold.releasedAt, 11.5); assert.equal(r0.hold.releaseDeltaMs, -500); assert.equal(r0.hold.status, 'early-release');
  assert.equal(r0.input.deltaMs, 0, '押し始めのずれは残す');
  // 3) 終了の許容内で離す（成功）
  n = [hold('y', 10, 2)]; j = new Judge(n, S);
  press(j, 'Y', 10.0); j.update(11.8); j.release('Y', 11.86, { raw: 11.86 });
  r0 = rec(j, n).notes[0];
  assert.equal(r0.result, 'PERFECT'); assert.equal(r0.hold.status, 'released-in-window'); assert.equal(r0.hold.releaseDeltaMs, -140);
  // 4) 押し始めの許容幅（息の押し始め）
  const st = { ...S, holdStartWindowMs: 80 };
  n = [hold('y', 10, 2)]; j = new Judge(n, st); press(j, 'Y', 10.1); assert.equal(j.notes[0].result, 'MISS'); assert.equal(rec(j, n, { settings: st }).notes[0].hold.status, 'start-miss');
  n = [hold('y', 10, 2)]; j = new Judge(n, S); press(j, 'Y', 10.1); assert.equal(j.notes[0].startGrade, 'GOOD');
});

test('AUTO は予定時刻ちょうど（ずれ 0）で、入力方法は AUTO', () => {
  const notes = [tap('a', 1), hold('y', 2, 1)];
  const j = new Judge(notes, S), a = new AutoPlayer(j);
  for (let t = 0; t < 4; t += 1 / 60) { a.update(t); j.update(t); }
  const r = rec(j, notes, { mode: 'auto' });
  assert.deepEqual(r.notes.map((n) => [n.result, n.input.deltaMs, n.input.device]), [['PERFECT', 0, 'auto'], ['PERFECT', 0, 'auto']]);
  assert.equal(r.notes[1].hold.releasedAt, 3);
});

test('集計: 平均絶対誤差は早い・遅いを相殺しない。記録がなければ null（— と表示）', () => {
  const notes = [tap('a', 1), tap('b', 2), tap('c', 3)];
  const j = new Judge(notes, S);
  press(j, 'X', 0.95); press(j, 'X', 2.05); j.update(5);
  const s = rec(j, notes).summary;
  assert.equal(s.meanMs, 0); assert.equal(s.maeMs, 50); assert.equal(s.sdMs, 50);
  assert.equal(s.timed, 2); assert.equal(s.missNoInput, 1); assert.equal(s.miss, 1); assert.equal(s.total, 3);
  assert.equal(s.byCmd.X.successRate, 2 / 3);
  assert.equal(s.byCmd.A.maeMs, null); assert.equal(s.byCmd.A.successRate, null);
  const j2 = new Judge(notes, S); j2.update(5);
  assert.equal(rec(j2, notes).summary.maeMs, null, '入力が 1 つもなければ 0ms ではなく null');
});

test('判定の設定の検証: 範囲・整数・大小関係', () => {
  assert.deepEqual(validateTiming(fillSettings({})), []);
  assert.ok(validateTiming({ ...S, perfectWindowMs: 130 }).some((e) => /PERFECT は GOOD 以下/.test(e)));
  assert.ok(validateTiming({ ...S, goodWindowMs: 200 }).some((e) => /GOOD は許容限界/.test(e)));
  assert.ok(validateTiming({ ...S, holdStartWindowMs: 50 }).some((e) => /息の押し始め/.test(e)));
  assert.ok(validateTiming({ ...S, missWindowMs: 500 }).some((e) => /30〜400/.test(e)));
  assert.ok(validateTiming({ ...S, perfectWindowMs: 50.5 }).some((e) => /整数/.test(e)));
  assert.ok(validateTiming({ ...S, inputOffsetMs: NaN }).length);
  assert.equal(fillSettings({ goodWindowMs: 150 }).holdStartWindowMs, 150, '息の押し始めの無い譜面は GOOD と同じ（従来どおり）');
  assert.equal(DEFAULT_SETTINGS.holdStartWindowMs, 120);
});

test('比較: 同条件の前回・自己ベスト（AUTO・練習は除く）、条件の違い、技ごとの変化', () => {
  const notes = [tap('a', 1), tap('b', 2, 'A')];
  const mk = (d, o = {}) => { const j = new Judge(notes, o.settings || S); press(j, 'X', 1 + d / 1000); press(j, 'A', 2 + d / 1000); j.update(5); return { ...rec(j, notes, o), id: o.id, at: o.at }; };
  const h = [
    mk(40, { id: 'r1', at: '2026-10-22T01:00:00Z' }),
    mk(10, { id: 'auto', at: '2026-10-22T02:00:00Z', mode: 'auto' }),
    mk(5, { id: 'prac', at: '2026-10-22T03:00:00Z', kind: 'practice' }),
    mk(20, { id: 'r2', at: '2026-10-22T04:00:00Z' }),
    mk(0, { id: 'slow', at: '2026-10-22T05:00:00Z', rate: 0.5 }),
  ];
  const cur = mk(30, { id: 'cur', at: '2026-10-22T06:00:00Z' });
  const t = comparisonTargets(cur, [...h, cur]);
  assert.equal(t.previous.id, 'r2', '前回 = 同条件・同じ区分の手動（速度の違う記録・AUTO・練習は除く）');
  assert.equal(t.best.id, 'r2', '自己ベスト = 同条件の手動の通しプレイ（AUTO・練習は除く）');
  const c = compareRecords(cur, h[0]);
  assert.equal(c.maeImproveMs, 10); assert.equal(c.conditions.length, 0); assert.equal(c.pairs.length, 2);
  assert.equal(c.byCmd.X.maeImproveMs, 10);
  const d = conditionDiffs(cur, h[4]);
  assert.deepEqual(d.map((x) => x.key), ['rate']);
  assert.equal(chartHash(chartOf(notes)), cur.chart.hash);
});

test('履歴: 保存・再読み込み・書き出し・読み込み（重複なし）・削除。譜面 JSON は成績として読まない', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const notes = [tap('a', 1)];
  const j = new Judge(notes, S); press(j, 'X', 1.01); j.update(3);
  const r = { ...rec(j, notes), id: 'x1' };
  const h = new ScoreHistory('hist', storage);
  assert.ok(h.add(r).ok);
  const h2 = new ScoreHistory('hist', storage);
  assert.equal(h2.records.length, 1); assert.deepEqual(h2.records[0], JSON.parse(JSON.stringify(r)));
  const text = h2.exportText();
  const h3 = new ScoreHistory('other', storage);
  assert.deepEqual(h3.importText(text), { ok: true, error: undefined, added: 1, skipped: 0, invalid: 0 });
  assert.equal(h3.importText(text).skipped, 1);
  const chartJson = JSON.stringify({ schemaVersion: 1, gameVersion: 'v2', notes: [] });
  const bad = h3.importText(chartJson);
  assert.equal(bad.ok, false); assert.match(bad.error, /譜面 JSON/);
  assert.equal(recordError({ schemaVersion: 1, notes: [] }), '譜面 JSON です（成績 JSON ではありません）');
  assert.equal(h3.remove(['x1']).removed, 1);
  assert.equal(new ScoreHistory('other', storage).records.length, 0);
  // 保存できないとき
  const full = new ScoreHistory('q', { getItem: () => null, setItem: () => { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } });
  const res = full.add({ ...r, id: 'x2' });
  assert.equal(res.ok, false); assert.match(res.error, /いっぱい/); assert.equal(full.records.length, 1, 'メモリ上には残す（退避用）');
});

test('summarize は記録から再計算しても同じ（表示と記録が一致）', () => {
  const notes = [tap('a', 1), tap('b', 2), hold('y', 3, 1)];
  const j = new Judge(notes, S);
  press(j, 'X', 1.07); press(j, 'X', 1.98); press(j, 'Y', 3.02); j.update(4.2); j.update(5);
  const r = rec(j, notes);
  assert.deepEqual(summarize(JSON.parse(JSON.stringify(r))), r.summary);
  assert.equal(r.summary.perfect + r.summary.good + r.summary.miss, r.summary.total);
});

test('照合タイムラインと編集画面の目盛りは同じ（timeline.js）: 1 秒ごとに太い目盛り、0.2 秒の細い目盛り', async () => {
  const { timeTicks, FRAME } = await import('../app/timeline.js');
  assert.equal(FRAME, 0.2);
  const t = timeTicks(0, 10, 40);
  assert.deepEqual(t.filter((x) => x.whole).map((x) => x.t), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(t.length, 51); // 0.2 秒ごと
  assert.deepEqual(t.filter((x) => x.label).map((x) => x.label).slice(0, 3), ['0s', '1s', '2s']);
  // 狭い（1 秒 = 10px）: 細い目盛りを省き、数字は 5 秒ごと
  const n = timeTicks(0, 20, 10);
  assert.equal(n.length, 21);
  assert.deepEqual(n.filter((x) => x.label).map((x) => x.label), ['0s', '5s', '10s', '15s', '20s']);
  // とても狭い（スマホの全体表示 1 秒 = 3px）: 数字は重ならない間隔（20 秒）、線は 5 秒ごと
  const w = timeTicks(0, 80, 3);
  assert.deepEqual(w.filter((x) => x.label).map((x) => x.label), ['0s', '20s', '40s', '60s', '80s']);
  assert.ok(w.every((x) => x.t % 5 === 0));
  const { readFileSync } = await import('node:fs');
  for (const f of ['app/editor.js', 'app/results.js']) assert.match(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /timeTicks\(/, `${f} は共通の目盛りを使う`);
});

test('記録に時間軸の長さ（演武の終わり）を残す', () => {
  const chart = { title: 't', notes: [{ id: 'a', time: 1, button: 'X', input: 'tap' }] };
  const j = new Judge(chart.notes, DEFAULT_SETTINGS);
  j.update(3);
  const r = buildRecord(j, { chart, settings: DEFAULT_SETTINGS, rate: 1, mode: 'manual', kind: 'full', duration: 82.2679 });
  assert.equal(r.chart.duration, 82.268);
});
