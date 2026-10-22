// 入力ログの再現・判定ロジックの版・公式デモの確認（DOM 不要）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Judge } from '../app/judge.js';
import { simulate, verifyRecord, replayable, rebuildRecord, snapshotNotes, applyEvent, eventClock, JUDGE_VERSION, REPLAY_MISSING } from '../app/replay.js';
import { buildRecord } from '../app/score.js';
import { normalizeChart, DEFAULT_SETTINGS } from '../app/chart.js';

const root = resolve(import.meta.dirname, '..');
const chart = normalizeChart(JSON.parse(readFileSync(resolve(root, 'charts/seipai_v2.json'), 'utf8')));
const demos = JSON.parse(readFileSync(resolve(root, 'charts/official-demos.json'), 'utf8')).records;
const S = { ...DEFAULT_SETTINGS, inputOffsetMs: 20 };

/** 実際のプレイの流れ（描画ごとの update と、その間の入力）を、決まった描画間隔で再現する */
function livePlay(events, frameDt, settings = S) {
  const j = new Judge(chart.notes, settings);
  j.resetFrom(-2);
  let t = -2, k = 0;
  while (t < 83) {
    t += frameDt;
    while (k < events.length && events[k].raw <= t) {
      const e = events[k++];
      const time = e.raw - settings.inputOffsetMs / 1000; // 入力補正（main.js と同じ）
      if (e.down) j.press(e.b, time, { id: `x${k}`, raw: e.raw, device: 'keyboard', source: 'key' });
      else j.release(e.b, time, { raw: e.raw, device: 'keyboard', source: 'key' });
    }
    j.update(t);
  }
  return j;
}
/** 決まった入力: 長押しの早離し・同時入力・余分な入力・入力なし・範囲外を含む */
function sampleEvents() {
  const ev = [];
  chart.notes.forEach((n, i) => {
    if (i % 7 === 3) return; // 入力なし
    const d = ((i * 41) % 260 - 130) / 1000;
    if (n.input === 'hold') { ev.push({ raw: n.time + d / 3, b: 'Y', down: true }, { raw: i % 2 ? n.time + n.duration * 0.4 : n.time + n.duration + 0.15, b: 'Y', down: false }); return; }
    ev.push({ raw: n.time + d, b: n.button, down: true }, { raw: n.time + d + 0.07, b: n.button, down: false });
  });
  ev.push({ raw: 33.3, b: 'A', down: true }, { raw: 33.35, b: 'A', down: false });
  return ev.sort((a, b) => a.raw - b.raw);
}
const ctx = (j) => ({ chart, settings: S, rate: 1, mode: 'manual', kind: 'full', startT: -2, endT: j.lastUpdate, duration: 82.268, id: 'x' });
const pick = (r) => JSON.stringify({ n: r.notes.map((n) => [n.id, n.result, n.points, n.input?.time, n.input?.deltaMs, n.hold?.status, n.hold?.releasedAt]), s: r.summary, x: r.extras });

test('判定ロジックの版 2: 期限の来た判定は期限の時刻の順（描画の間隔が違っても同じ結果・コンボ・スコア）', () => {
  const ev = sampleEvents();
  const a = livePlay(ev, 1 / 60), b = livePlay(ev, 1 / 23), c = livePlay(ev, 0.25);
  const ra = buildRecord(a, ctx(a)), rb = buildRecord(b, ctx(b)), rc = buildRecord(c, ctx(c));
  assert.equal(pick(ra), pick(rb)); assert.equal(pick(ra), pick(rc));
  assert.equal(JUDGE_VERSION, 2);
});

test('入力ログ: プレイ中の判定の呼び出しを記録し、ログを通すと同じ判定・コンボ・スコア・誤差になる（入力補正は二重にしない）', () => {
  const live = livePlay(sampleEvents(), 1 / 60);
  assert.ok(live.log.length > 100);
  assert.ok(live.log.every((e) => ['d', 'u', 'c'].includes(e[0])));
  const e0 = live.log.find((e) => e[0] === 'd');
  assert.ok(Math.abs(e0[3] - e0[2] - 0.02) < 1e-9); // raw − 判定時刻 = 入力補正 20ms（記録した判定時刻をそのまま使う）
  const { judge } = simulate({ notes: snapshotNotes(chart.notes), settings: S, startT: -2, events: live.log, endT: live.lastUpdate });
  assert.equal(pick(buildRecord(judge, ctx(judge))), pick(buildRecord(live, ctx(live))));
  assert.equal(judge.maxCombo, live.maxCombo);
});

test('途中まで進めて続けても（シーク後の再構築）同じ結果。同じ時刻の入力も記録した順', () => {
  const live = livePlay(sampleEvents(), 1 / 60);
  const notes = snapshotNotes(chart.notes);
  const full = simulate({ notes, settings: S, startT: -2, events: live.log, endT: live.lastUpdate }).judge;
  for (const until of [10, 20.8, 44.83, 60]) {
    const part = simulate({ notes, settings: S, startT: -2, events: live.log, until });
    // 再生を続ける: 残りの入力を同じ規則で
    for (let k = part.next; k < live.log.length; k++) applyEvent(part.judge, live.log[k], k);
    part.judge.update(live.lastUpdate);
    assert.equal(pick(buildRecord(part.judge, ctx(part.judge))), pick(buildRecord(full, ctx(full))), `until ${until}`);
  }
  // 同じ時刻の入力（44.83 秒の構と息）は記録した順
  const same = live.log.filter((e) => e[0] === 'd' && Math.abs(e[3] - 44.83) < 0.2);
  assert.ok(same.length >= 2);
});

test('公式デモ 3 件: 入力ログから計算し直すと保存された判定・成功件数・スコア・コンボ・誤差と一致', () => {
  assert.deepEqual(demos.map((r) => r.id), ['official-demo-90', 'official-demo-70', 'official-demo-50']);
  const want = { 'official-demo-90': 53, 'official-demo-70': 41, 'official-demo-50': 30 };
  for (const r of demos) {
    const v = verifyRecord(r);
    assert.ok(v.ok, `${r.id}: ${v.diffs.join(' / ')}`);
    const ok = r.summary.perfect + r.summary.good;
    assert.equal(ok, want[r.id]); assert.equal(r.summary.total, 59);
    assert.equal(r.mode, 'demo'); assert.equal(r.demo.official, true); assert.match(r.demo.label, /^公式デモ：正答率 約(90|70|50)％$/);
    assert.equal(r.demo.successes, ok);
    // 失敗の種類と分散
    const miss = r.notes.filter((n) => n.result === 'MISS');
    assert.ok(miss.some((n) => !n.input) && miss.some((n) => n.input && n.input.deltaMs < 0) && miss.some((n) => n.input && n.input.deltaMs > 0) && miss.some((n) => n.reason === 'early-release'), r.id);
    assert.ok(r.extras.length >= 1, `${r.id}: ボタン違い`);
    assert.ok(new Set(miss.map((n) => n.button)).size === 4, `${r.id}: 4 種類のコマンドに失敗`);
    assert.ok(miss.some((n) => n.time < 41) && miss.some((n) => n.time >= 41), `${r.id}: 前半と後半の両方に失敗`);
    assert.ok(r.notes.some((n) => n.result === 'GOOD') && r.notes.some((n) => n.result === 'PERFECT'));
  }
  assert.ok(demos[0].summary.maeMs < demos[1].summary.maeMs && demos[1].summary.maeMs < demos[2].summary.maeMs); // 90% 版は誤差が小さい
});

test('結果だけを書き換えた記録・入力ログのない古い記録・違う版の記録は再現しない（推測で作らない）', () => {
  const t = structuredClone(demos[0]); t.notes[5].result = t.notes[5].result === 'MISS' ? 'PERFECT' : 'MISS';
  assert.equal(verifyRecord(t).ok, false);
  const old = structuredClone(demos[0]); delete old.replay;
  assert.deepEqual(replayable(old), { ok: false, reason: REPLAY_MISSING });
  const v1 = structuredClone(demos[0]); v1.replay.judgeVersion = 1;
  assert.match(replayable(v1).reason, /判定ロジックの版 1/);
  assert.equal(verifyRecord(v1).ok, false);
  assert.equal(rebuildRecord(demos[1]).summary.score, demos[1].summary.score);
  assert.equal(eventClock(['d', 'X', 1.0, 1.02, 0.99, 'k', 'key']), 1.02);
});
