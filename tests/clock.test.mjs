import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioClock } from '../src/clock.js';

// 音声ハードウェア時計を手動で進められる擬似 AudioContext（実機の音声出力ではない）
function rig({ latency = 0.04 } = {}) {
  let perf = 1000; // ms
  const ctx = {
    currentTime: 5,
    state: 'running',
    // 出力は currentTime より latency 秒遅れて聞こえる
    getOutputTimestamp: () => ({ contextTime: ctx.currentTime - latency, performanceTime: perf }),
    createBufferSource: () => ({ connect() {}, start(when, off) { this.when = when; this.off = off; }, stop() {}, disconnect() {}, onended: null }),
  };
  const c = new AudioClock();
  c.ctx = ctx; c.gain = {}; c.buffer = { duration: 60 };
  globalThis.performance = { now: () => perf };
  const advance = (sec) => { ctx.currentTime += sec; perf += sec * 1000; };
  return { c, ctx, advance, perfNow: () => perf };
}

test('停止中は曲時刻（表示・判定用）が進まず、再開で停止時間が加算されない', () => {
  const { c, advance } = rig();
  c.play(0);
  advance(0.03 + 2.0);                       // 予約 30ms 後から 2 秒再生
  const heardBefore = c.position();
  assert.ok(Math.abs(heardBefore - (2.0 - 0.04)) < 1e-9);
  c.pause();
  assert.equal(c.state, 'paused');
  const p0 = c.position();
  assert.ok(Math.abs(p0 - heardBefore) < 1e-9, '停止した瞬間に表示時刻が先へ跳ばない');
  advance(7.5);                              // 7.5 秒停止
  assert.equal(c.position(), p0);
  assert.equal(c.songTimeAtPerf(123456), p0, '停止中の入力時刻も停止位置');
  assert.ok(Math.abs(c.offset - 2.0) < 1e-9, '音声は予約済み位置で止まり、そこから再開');
  c.resume();
  advance(0.03);
  // 再開直後: 聞こえ始めるのは offset − 出力遅延（= 停止前に聞こえていた位置）
  assert.ok(Math.abs(c.position() - p0) < 1e-9, `再開直後 ${c.position()} vs 停止時 ${p0}`);
  advance(1.0);
  assert.ok(Math.abs(c.position() - (p0 + 1.0)) < 1e-9, '再開後は壁時計と同じ速さで進む（停止時間 7.5s は含まない）');
});

test('停止/再開を繰り返しても累積ずれがない', () => {
  const { c, advance } = rig();
  c.play(0);
  advance(0.03);
  let played = 0;
  for (let i = 0; i < 50; i++) {
    advance(0.37); played += 0.37;
    c.pause();
    advance(1 + (i % 3));
    c.resume();
    advance(0.03);                           // 再開時の予約分は再生されない
  }
  advance(0.5); played += 0.5;
  assert.ok(Math.abs(c.position() - (played - 0.04)) < 1e-6, `${c.position()} vs ${played - 0.04}`);
});

test('リスタートで先頭に戻り、停止位置を持ち越さない', () => {
  const { c, advance } = rig();
  c.play(0); advance(3); c.pause();
  c.restart();
  assert.equal(c.state, 'idle');
  assert.equal(c.position(), 0);
  c.play(0);
  assert.equal(c.now(), 0);
});
