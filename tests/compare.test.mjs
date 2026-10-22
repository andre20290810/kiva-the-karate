// 成績の比較（複数の記録・期間平均）の計算の確認（DOM 不要）
import test from 'node:test';
import assert from 'node:assert/strict';
import { observe, noteChange, holdChange, pool, matchNote, compareMany, periodRange, presetPeriods, comparePeriods, periodDiff, dedupe, periodCsv, condKey, inPeriod } from '../app/compare.js';

const S = { perfectWindowMs: 60, goodWindowMs: 120, missWindowMs: 180, holdStartWindowMs: 120, holdReleaseWindowMs: 150, inputOffsetMs: 0 };
const grade = (d) => (Math.abs(d) <= 60 ? 'PERFECT' : Math.abs(d) <= 120 ? 'GOOD' : 'MISS');
/** ノーツ: [id, time, button, d（ms。null = 入力なし）, hold?] */
function rec(id, at, notes, extra = {}) {
  const ns = notes.map(([nid, time, button, d, hold]) => {
    const n = { id: nid, button, time, result: d == null ? 'MISS' : grade(d), points: d == null ? 0 : grade(d) === 'PERFECT' ? 1000 : grade(d) === 'GOOD' ? 500 : 0,
      input: d == null ? null : { time: time + d / 1000, button, device: 'keyboard', deltaMs: d } };
    if (hold) n.hold = { duration: hold.duration, requiredSec: hold.duration - 0.15, status: hold.status, heldSec: hold.heldSec ?? null };
    return n;
  });
  return { schema: 'kiva-score/1', id, at, mode: 'manual', kind: 'full', chart: { hash: 'h1', title: 't', duration: 82.268 }, settings: { ...S }, rate: 1,
    notes: ns, extras: [], summary: { score: ns.reduce((a, n) => a + n.points, 0) }, ...extra };
}
const day = (y, m, d, hh = 12, mm = 0, ss = 0) => new Date(y, m - 1, d, hh, mm, ss).toISOString(); // 現地時間

test('改善量は絶対誤差の差（早押しと遅押しを相殺しない）: 基準 80ms 早い → 比較 20ms 遅い = 60ms 改善', () => {
  const b = observe(rec('a', day(2026, 10, 1), [['n1', 10, 'X', -80]]).notes[0]);
  const c = observe(rec('b', day(2026, 10, 2), [['n1', 10, 'X', 20]]).notes[0]);
  const ch = noteChange(b, c);
  assert.equal(ch.ms, 60); assert.equal(ch.kind, 'up'); assert.match(ch.label, /GOOD→PERFECT（60\.0ms 改善）/);
  assert.equal(noteChange(c, b).ms, -60); assert.equal(noteChange(c, b).kind, 'down');
});

test('入力なしの MISS は誤差 0ms として扱わない: 入力なし→GOOD は ms の改善量を作らない', () => {
  const b = observe(rec('a', day(2026, 10, 1), [['n1', 10, 'X', null]]).notes[0]);
  const c = observe(rec('b', day(2026, 10, 2), [['n1', 10, 'X', 90]]).notes[0]);
  assert.equal(b.d, null); assert.equal(b.noInput, true);
  const ch = noteChange(b, c);
  assert.equal(ch.ms, null); assert.equal(ch.kind, 'up'); assert.equal(ch.label, '入力なし→GOOD');
  const p = pool([b, c]);
  assert.equal(p.timed, 1); assert.equal(p.mae, 90); assert.equal(p.miss, 1); assert.equal(p.missNoInput, 1); assert.equal(p.n, 2);
});

test('ボタン違いはノーツの入力にならない（記録では余分な入力）ので誤差に入らない', () => {
  const r = rec('a', day(2026, 10, 1), [['n1', 10, 'X', null]]);
  r.extras = [{ time: 10.01, button: 'A', device: 'keyboard' }];
  const p = pool(r.notes.map(observe));
  assert.equal(p.timed, 0); assert.equal(p.mae, null); assert.equal(p.miss, 1);
});

test('長押し: 押し始めの精度と保持・解除の結果を分ける', () => {
  const b = observe(rec('a', day(2026, 10, 1), [['h1', 12, 'Y', 30, { duration: 2, status: 'early-release', heldSec: 1 }]]).notes[0]);
  const c = observe(rec('b', day(2026, 10, 2), [['h1', 12, 'Y', 50, { duration: 2, status: 'completed-released', heldSec: 2.2 }]]).notes[0]);
  assert.equal(noteChange(b, c).ms, -20); // 押し始めは 20ms 悪化
  assert.deepEqual(holdChange(b, c), { kind: 'up', label: '失敗→保持して成功' });
  const old = observe({ ...c, hold: undefined, id: 'h1', button: 'Y', time: 12, result: 'PERFECT', input: null });
  assert.equal(holdChange(b, { ...old, hold: { ok: null } }).label, '記録なし');
});

test('全体の平均誤差は入力の合算（平均の平均にしない）', () => {
  const r1 = rec('a', day(2026, 10, 1), [['n1', 1, 'X', 100]]);
  const r2 = rec('b', day(2026, 10, 2), [['n1', 1, 'X', 0], ['n2', 2, 'X', 0], ['n3', 3, 'X', 0]]);
  const p = pool([...r1.notes, ...r2.notes].map(observe));
  assert.equal(p.mae, 25); // 平均の平均なら 50
});

test('改善量と改善率: A 80ms → B 50ms = 30ms 改善・37.5% 減少。A が 0 なら率は計算しない', () => {
  const d = periodDiff({ n: 4, mae: 80, sd: 10, mean: -5, successRate: 0.5, perfectRate: 0.25, missRate: 0.5 }, { n: 4, mae: 50, sd: 8, mean: 5, successRate: 0.75, perfectRate: 0.5, missRate: 0.25 });
  assert.equal(d.maeImprove, 30); assert.equal(d.maeImprovePct, 37.5); assert.equal(d.successPt, 25); assert.equal(d.missPt, -25); assert.equal(d.status, 'up');
  const z = periodDiff({ n: 1, mae: 0 }, { n: 1, mae: 10 });
  assert.equal(z.maeImprove, -10); assert.equal(z.maeImprovePct, null);
  const none = periodDiff({ n: 0, mae: null }, { n: 3, mae: 10 });
  assert.equal(none.maeImprove, null); assert.equal(none.status, 'na');
});

test('期間は現地時間の日付で、終了日当日を含む（翌日 0 時は含まない）', () => {
  const p = periodRange('2026-10-01', '2026-10-07');
  assert.ok(inPeriod({ at: day(2026, 10, 1, 0, 0, 0) }, p));
  assert.ok(inPeriod({ at: day(2026, 10, 7, 23, 59, 59) }, p));
  assert.ok(!inPeriod({ at: day(2026, 10, 8, 0, 0, 0) }, p));
  assert.ok(!inPeriod({ at: day(2026, 9, 30, 23, 59, 59) }, p));
  assert.equal(periodRange('2026-10-07', '2026-10-01'), null);
  assert.equal(periodRange('2026-02-30', '2026-03-01'), null);
});

test('期間の選択肢: 前週と今週（月曜はじまり）・直近 7 日間とその前・前月と今月', () => {
  const now = new Date(2026, 9, 21, 15); // 2026-10-21（水）
  assert.deepEqual(presetPeriods('week', now), { A: ['2026-10-12', '2026-10-18'], B: ['2026-10-19', '2026-10-25'] });
  assert.deepEqual(presetPeriods('last7', now), { A: ['2026-10-08', '2026-10-14'], B: ['2026-10-15', '2026-10-21'] });
  assert.deepEqual(presetPeriods('month', now), { A: ['2026-09-01', '2026-09-30'], B: ['2026-10-01', '2026-10-31'] });
});

test('期間平均: AUTO・練習・途中終了・条件違いを除外し、重複した取り込みを数えない。期間の重複を示す', () => {
  const N = (d) => [['n1', 10, 'X', d], ['n2', 20, 'A', null]];
  const a1 = rec('a1', day(2026, 10, 2), N(-80));
  const a2 = rec('a2', day(2026, 10, 3), N(80));
  const b1 = rec('b1', day(2026, 10, 9), N(40));
  const dup = { ...structuredClone(b1), id: 'b1-copy' };  // JSON から取り込んだ同じプレイ（別 ID）
  const auto = rec('au', day(2026, 10, 9), N(0), { mode: 'auto' });
  const prac = rec('pr', day(2026, 10, 9), N(0), { kind: 'practice' });
  const abo = rec('ab', day(2026, 10, 9), N(0), { kind: 'aborted' });
  const slow = rec('sl', day(2026, 10, 9), N(0), { rate: 0.5 });
  const res = comparePeriods([a1, a2, b1, dup, auto, prac, abo, slow], { A: ['2026-10-01', '2026-10-07'], B: ['2026-10-08', '2026-10-14'], ref: b1 });
  assert.equal(res.A.plays, 2); assert.equal(res.B.plays, 1);
  assert.deepEqual(res.duplicates, ['b1-copy']);
  assert.deepEqual(res.excludedRecords, { AUTO: 1, 練習: 1, 途中終了: 1, '判定幅・速度・入力補正が違う': 1 });
  assert.equal(res.all.a.mae, 80); assert.equal(res.all.b.mae, 40); assert.equal(res.all.maeImprove, 40); assert.equal(res.all.maeImprovePct, 50);
  assert.equal(res.all.a.timed, 2); assert.equal(res.all.a.miss, 2); assert.equal(res.all.a.n, 4); // 入力なしは誤差に入れず MISS に数える
  assert.equal(res.all.a.mean, 0); // 早い −80 と遅い +80 の符号付き平均は 0（絶対誤差は 80）
  const n2 = res.notes.find((n) => n.id === 'n2');
  assert.equal(n2.a.mae, null); assert.equal(n2.status, 'na');
  assert.equal(res.score.a, 1000 / 2 + 500 / 2 > 0 ? (500 + 500) / 2 : 0); // GOOD 500 点 × 2 プレイの平均
  assert.equal(res.overlap.length, 0);
  // 期間が重なる: 同じ記録が両方に入ることを示す
  const ov = comparePeriods([a1, a2, b1], { A: ['2026-10-01', '2026-10-09'], B: ['2026-10-03', '2026-10-14'], ref: b1 });
  assert.deepEqual(ov.overlap.sort(), ['a2', 'b1']);
  // 含める設定にすると AUTO・練習も入る
  const inc = comparePeriods([b1, auto, prac], { A: ['2026-10-01', '2026-10-07'], B: ['2026-10-08', '2026-10-14'], ref: b1, includeAuto: true, includePractice: true });
  assert.equal(inc.B.plays, 3);
});

test('譜面が違う記録: 既定では混ぜない。混ぜる場合も時刻・コマンドが変わったノーツは除外して理由を示す', () => {
  const ref = rec('r', day(2026, 10, 9), [['n1', 10, 'X', 10], ['n2', 20, 'A', 10]]);
  const other = rec('o', day(2026, 10, 2), [['n1', 10, 'X', 100], ['n2', 21, 'A', 10]], { chart: { hash: 'h2', title: 't2' } });
  const a = comparePeriods([ref, other], { A: ['2026-10-01', '2026-10-07'], B: ['2026-10-08', '2026-10-14'], ref });
  assert.equal(a.A.plays, 0); assert.equal(a.excludedRecords['譜面が違う'], 1);
  const m = comparePeriods([ref, other], { A: ['2026-10-01', '2026-10-07'], B: ['2026-10-08', '2026-10-14'], ref, mixCharts: true });
  assert.equal(m.A.plays, 1); assert.equal(m.A.all.timed, 1); assert.equal(m.A.all.mae, 100);
  assert.equal(m.excludedNotes.length, 1); assert.match(m.excludedNotes[0].reason, /条件変更（時刻 20\.000→21\.000 秒）/);
});

test('複数の記録の比較: ID で対応（配列の順番ではない）・日時順の色と記号・基準の変更で改善量が変わる・条件変更／対応なし', () => {
  const r1 = rec('r1', day(2026, 10, 1), [['n1', 10, 'X', -80], ['n2', 20, 'A', null], ['n3', 30, 'B', 10]]);
  const r2 = rec('r2', day(2026, 10, 2), [['n3', 30, 'B', 30], ['n2', 20, 'A', 90], ['n1', 10, 'X', 20]]); // 順番が違う
  const r3 = rec('r3', day(2026, 10, 3), [['n1', 10.2, 'X', 0], ['n2', 20, 'A', 50]]);                     // n1 の時刻が変更・n3 なし
  const c = compareMany([r3, r1, r2]);
  assert.deepEqual(c.recs.map((x) => [x.rec.id, x.sym]), [['r1', 'A'], ['r2', 'B'], ['r3', 'C']]);
  assert.equal(c.base.rec.id, 'r1'); // 初期の基準は最も古い記録
  const cell = (row, id) => c.rows.find((r) => r.note.id === row).cells.find((x) => x.id === id);
  assert.equal(cell('n1', 'r2').change.ms, 60); assert.equal(cell('n1', 'r2').change.kind, 'up');
  assert.equal(cell('n2', 'r2').change.label, '入力なし→GOOD'); assert.equal(cell('n2', 'r2').change.ms, null);
  assert.equal(cell('n3', 'r2').change.ms, -20);
  assert.equal(cell('n1', 'r3').status, 'changed'); assert.match(cell('n1', 'r3').why, /条件変更/);
  assert.equal(cell('n3', 'r3').status, 'missing'); assert.match(cell('n3', 'r3').why, /対応なし/);
  const s2 = c.summary.find((x) => x.id === 'r2');
  assert.equal(s2.up, 2); assert.equal(s2.down, 1);
  assert.equal(s2.timed, 3); assert.equal(s2.mae, Math.round((90 + 30 + 20) / 3 * 10) / 10);
  // 基準を r2 に変えると改善量が変わる
  const d = compareMany([r1, r2, r3], 'r2');
  assert.equal(d.base.rec.id, 'r2');
  const dc = (row, id) => d.rows.find((r) => r.note.id === row).cells.find((x) => x.id === id);
  assert.equal(dc('n1', 'r1').change.ms, -60); assert.equal(dc('n2', 'r3').change.ms, 40); assert.equal(dc('n2', 'r1').change.label, 'GOOD→入力なし');
});

test('重複の除外は ID と内容の両方', () => {
  const r = rec('x', day(2026, 10, 1), [['n1', 1, 'X', 5]]);
  const { records, duplicates } = dedupe([r, r, { ...structuredClone(r), id: 'y' }, rec('z', day(2026, 10, 2), [['n1', 1, 'X', 5]])]);
  assert.deepEqual(records.map((x) => x.id), ['x', 'z']); assert.equal(duplicates.length, 2);
});

test('書き出し（CSV）: 見出し・全体・技・ノーツ。条件の文字と BOM', () => {
  const r = rec('r', day(2026, 10, 9), [['n1', 10, 'X', 10]]);
  const res = comparePeriods([r], { A: ['2026-10-01', '2026-10-07'], B: ['2026-10-08', '2026-10-14'], ref: r });
  const csv = periodCsv(res, 'cond');
  assert.ok(csv.startsWith('﻿# 期間平均の比較'));
  assert.match(csv, /改善量ms\(A-B\)/); assert.match(csv, /\r\nノーツ,n1,10\.000,構,,10,/);
  assert.equal(condKey(r), 'h1|60|120|180|120|150|0|1');
});

test('記録の対応付け: 同じ ID・同じ署名だけが ok', () => {
  const a = rec('a', day(2026, 10, 1), [['n1', 10, 'X', 5]]);
  assert.equal(matchNote(a.notes[0], a).status, 'ok');
  assert.equal(matchNote({ ...a.notes[0], id: 'zz' }, a).status, 'missing');
  assert.equal(matchNote({ ...a.notes[0], button: 'A' }, a).status, 'changed');
});
