// 一時停止・再開の時刻検証（ブラウザ実行。時刻の強制変更は一切しない）。
//   npm start  (別ターミナル)
//   node tests/sync-probe.mjs [譜面]
//
// 曲時刻の算出元: AudioBufferSourceNode は再生位置を直接返さないため、
//   clock.now()            = offset + (ctx.currentTime - startCtxTime)   … 音声ハードウェア時計
//   clock.songTimeAtPerf() = offset + (getOutputTimestamp 由来の ctx 時刻 - startCtxTime) … 判定の入力時刻
// で求めている。ゲームは毎フレーム lastT = max(songTimeAtPerf(now), lastT) を
// 判定（judge.update / AUTO）・人物（warp.map）・VFX の共通時刻として使う。
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const chart = process.argv[2] || 'tests/fixtures/synthetic/chart.json';
const base = process.env.BASE || 'http://127.0.0.1:8177/';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}`); if (!ok) fails.push(msg); };

// 許容差（固定。失敗を通すために広げない）
const TOL = {
  pausedDrift: 0.0005,   // 停止中に曲時刻が動いてよい量（秒）: 実質ゼロ
  resumeJump: 0.050,     // 再開直後の曲時刻 − 停止時の曲時刻 の上限（再開予約 30ms + 計測誤差）
  rate: 0.03,            // 再生中の 曲時刻の進み / 壁時計の進み − 1 の許容（±3%）
  pauseEdge: 0.002,      // 停止の瞬間に表示・判定時刻が跳ぶ量の上限
  resumeLead: 0.030,     // 再開は 30ms 先に予約して開始する（clock.play）。この分は再生されない
  advance: 0.015,        // 再開後の進み と (壁時計 − 30ms) の差の許容（音声スレッドの更新粒度）
};

const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
page.on('pageerror', (e) => fails.push('pageerror: ' + e.message));
await page.goto(`${base}?chart=${encodeURIComponent(chart)}&mode=auto&quality=PERFORMANCE`);
await page.waitForFunction(() => window.__game?.state === 'ready', null, { timeout: 120000 });
await page.click('#btnStart');
await page.waitForFunction(() => window.__game.state === 'playing' && window.__game.lastT > 0.5);

const result = await page.evaluate(async (TOL) => {
  const g = window.__game;
  const c = g.clock;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = (label) => ({
    label,
    perf: performance.now(),
    ctxTime: c.ctx.currentTime,
    clockState: c.state,
    gameState: g.state,
    offset: c.offset,
    now: c.now(),                                    // 音声時計による曲時刻（音源の予約位置）
    position: c.position(),                          // 画面・判定・VFX が使う聞こえている位置
    judgeInputTime: c.songTimeAtPerf(performance.now()), // 入力判定が使う時刻
    lastT: g.lastT,                                  // 判定更新・人物・VFX が使う時刻
    judged: g.judge.notes.filter((n) => n.result).length,
    autoFired: g.auto?.fired ?? null,
    frame: window.__debug?.frame,
  });
  // 描画間隔（requestAnimationFrame）を別に記録し、時計の誤差と区別する
  const raf = [];
  let lastTs = 0, sampling = true;
  const sampler = (ts) => { if (lastTs) raf.push(ts - lastTs); lastTs = ts; if (sampling) requestAnimationFrame(sampler); };
  requestAnimationFrame(sampler);
  const cycles = [];
  for (let k = 0; k < 4; k++) {
    // 再生中の進み方（壁時計との比）
    const a = snap('playing-a'); await sleep(600); const b = snap('playing-b');
    const before = snap('before-pause');
    g.pause();
    const p0 = snap('paused-0');
    await sleep(400); const p1 = snap('paused-400ms');
    await sleep(800 + k * 400); const p2 = snap('paused-end');
    const tResumeCall = performance.now();
    await g.resume();                       // 非同期処理（AudioContext.resume）の完了を待つ
    const r0 = snap('resumed-0');
    await sleep(500); const r1 = snap('resumed-500ms');
    cycles.push({ k, a, b, before, p0, p1, p2, tResumeCall, r0, r1, pausedWallMs: r0.perf - p0.perf });
  }
  sampling = false;
  raf.sort((x, y) => x - y);
  cycles.raf = { n: raf.length, median: raf[raf.length >> 1], p95: raf[Math.floor(raf.length * 0.95)], max: raf[raf.length - 1] };
  return { cycles, raf: cycles.raf };
}, TOL).then((r) => { r.cycles.raf = r.raf; return r.cycles; });

for (const cy of result) {
  const { a, b, p0, p1, p2, r0, r1 } = cy;
  const rate = (b.now - a.now) / ((b.perf - a.perf) / 1000);
  check(Math.abs(rate - 1) <= TOL.rate, `#${cy.k} 再生中の曲時刻の進み/壁時計 = ${rate.toFixed(4)}（期待 1±${TOL.rate}）`);
  check(p0.clockState === 'paused' && p0.gameState === 'paused', `#${cy.k} 停止状態 clock=${p0.clockState} game=${p0.gameState}`);
  const drift = Math.max(Math.abs(p1.now - p0.now), Math.abs(p2.now - p0.now), Math.abs(p2.lastT - p0.lastT), Math.abs(p2.judgeInputTime - p0.judgeInputTime));
  check(drift <= TOL.pausedDrift, `#${cy.k} 停止中 ${((p2.perf - p0.perf) / 1000).toFixed(2)}s の曲時刻・lastT・判定時刻の変化 ${(drift * 1000).toFixed(3)}ms（期待 ≤${TOL.pausedDrift * 1000}ms）`);
  check(Math.abs(p0.position - cy.before.judgeInputTime) <= TOL.pauseEdge, `#${cy.k} 停止の瞬間に表示時刻が跳ばない（${((p0.position - cy.before.judgeInputTime) * 1000).toFixed(2)}ms、期待 ≤${TOL.pauseEdge * 1000}ms）`);
  check(p2.judged === p0.judged && p2.autoFired === p0.autoFired, `#${cy.k} 停止中に判定・AUTO入力が増えない（${p0.judged}→${p2.judged}）`);
  check(r0.clockState === 'playing' && r0.gameState === 'playing', `#${cy.k} 再開完了後の状態 clock=${r0.clockState} game=${r0.gameState}`);
  const jump = r0.now - p0.offset;
  check(jump >= -0.001 && jump <= TOL.resumeJump, `#${cy.k} 再開直後の曲時刻 − 停止位置 = ${(jump * 1000).toFixed(1)}ms（停止 ${(cy.pausedWallMs / 1000).toFixed(2)}s が加算されていない。期待 0〜${TOL.resumeJump * 1000}ms）`);
  // 再開後 500ms: 曲時刻の進み ≈ 壁時計の進み − 再開予約(30ms)
  const adv = r1.now - p0.offset;
  const expect = (r1.perf - cy.tResumeCall) / 1000 - TOL.resumeLead;
  check(Math.abs(adv - expect) <= TOL.advance, `#${cy.k} 再開後の進み ${(adv * 1000).toFixed(1)}ms / 期待 壁時計−30ms ${(expect * 1000).toFixed(1)}ms（差 ≤${TOL.advance * 1000}ms）`);
  const contAdv = r1.position - p0.position;
  check(Math.abs(contAdv - expect) <= TOL.advance, `#${cy.k} 表示時刻（position）の進み ${(contAdv * 1000).toFixed(1)}ms も同じ（停止時間は含まない）`);
}

// 最後まで再生して、AUTO の二重判定・取りこぼしがないこと
await page.waitForFunction(() => window.__game.state === 'ended', null, { timeout: 120000 });
const end = await page.evaluate(() => {
  const g = window.__game; const r = window.__lastResult;
  return { total: r.total, perfect: r.perfect, miss: r.miss, logLen: r.log.length, unique: new Set(r.log.map((x) => x.id)).size, deltas: r.log.map((x) => x.delta), fired: g.auto.fired };
});
check(end.logLen === end.total && end.unique === end.total && end.perfect === end.total && end.miss === 0 && end.fired === end.total,
  `停止/再開4回後も AUTO 全${end.total}件が1回ずつ PERFECT（log ${end.logLen}・重複なし ${end.unique}・AUTO発火 ${end.fired}）`);
check(end.deltas.every((d) => d === 0), 'AUTO の入力時刻 = ノーツ時刻（delta 0）');

// リスタート直後: 前回の判定が持ち越されない
await page.click('#btnResultClose');
// リスタート処理の完了直後に、同じタスク内で測る（画面ポーリングの遅れを混ぜない）
const rs = await page.evaluate(async () => {
  const g = window.__game;
  await g.restart();
  return { state: g.state, t: g.clock.position(), now: g.clock.now(), lastT: g.lastT, judged: g.judge.notes.filter((n) => n.result).length, fired: g.auto.fired };
});
check(rs.state === 'playing' && rs.now <= 0.001 && rs.t <= 0.001 && rs.lastT === 0 && rs.judged === 0 && rs.fired === 0,
  `リスタート直後 state=${rs.state} 曲時刻 ${rs.now.toFixed(4)}s 表示 ${rs.t.toFixed(4)}s lastT ${rs.lastT} 判定済み ${rs.judged} AUTO発火 ${rs.fired}`);
await page.waitForFunction(() => window.__game.lastT > 1.6);
const rs2 = await page.evaluate(() => ({ judged: window.__game.judge.notes.filter((n) => n.result).length, perfect: window.__game.judge.counts.PERFECT, fired: window.__game.auto.fired, due: window.__game.chart.notes.filter((n) => n.t <= window.__game.lastT).length }));
check(rs2.judged === rs2.due && rs2.fired === rs2.due && rs2.perfect === rs2.due, `リスタート後 1.6s までのノーツ ${rs2.due}件が1回ずつ判定（判定 ${rs2.judged}・AUTO ${rs2.fired}）`);

console.log(`\n描画間隔（rAF）: ${result.raf.n} 回 中央値 ${result.raf.median.toFixed(1)}ms / 95% ${result.raf.p95.toFixed(1)}ms / 最大 ${result.raf.max.toFixed(1)}ms`);
console.log('  → 描画が遅くても、上の「曲時刻の進み/壁時計」は音声時計から直接測っているため、描画間隔の影響を受けない');
console.log('\n記録（1回目のサイクル）:');
for (const k of ['before', 'p0', 'p1', 'p2', 'r0', 'r1']) {
  const s = result[0][k];
  console.log(`  ${s.label.padEnd(14)} perf=${s.perf.toFixed(1)} ctx=${s.ctxTime.toFixed(4)} clock=${s.clockState} game=${s.gameState} offset=${s.offset.toFixed(4)} now=${s.now.toFixed(4)} position=${s.position.toFixed(4)} judgeIn=${s.judgeInputTime.toFixed(4)} lastT=${s.lastT.toFixed(4)} judged=${s.judged} frame=${s.frame}`);
}
await browser.close();
console.log(fails.length ? `\n失敗 ${fails.length} 件` : '\nすべて成功');
process.exit(fails.length ? 1 : 0);
