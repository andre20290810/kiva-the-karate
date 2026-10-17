// ブラウザでの通し確認（Playwright）。サーバーを起動してから実行:
//   node tools/serve.mjs 8080 &
//   node tests/e2e.mjs [chart=tests/fixtures/synthetic/chart.json] [shotsDir]
// AUTO 全編 → 全ノーツ1回ずつ PERFECT、一時停止/再開/リスタートで重複なし、MANUAL で判定が変わることを確認する。
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const chart = process.argv[2] || 'tests/fixtures/synthetic/chart.json';
const shots = process.argv[3] || '';
const base = process.env.BASE || 'http://127.0.0.1:8177/';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const url = (q) => `${base}?chart=${encodeURIComponent(chart)}&debug${q}`;
const fail = [];
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'NG  '} ${msg}`); if (!cond) fail.push(msg); };

const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=user-gesture-required'] });

async function open(q, viewport = { width: 1280, height: 800 }) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => fail.push('pageerror: ' + e.message));
  await page.goto(url(q));
  await page.waitForFunction(() => window.__game?.state === 'ready' || window.__game?.state === 'error', null, { timeout: 120000 });
  const st = await page.evaluate(() => window.__game.state);
  if (st === 'error') throw new Error(await page.textContent('#status'));
  return page;
}
const waitEnd = (page, ms) => page.waitForFunction(() => window.__game.state === 'ended', null, { timeout: ms });
const durationMs = async (page) => (await page.evaluate(() => window.__game.clock.duration)) * 1000 + 15000;

// --- AUTO 全編 ---
{
  const page = await open('&mode=auto');
  const n = await page.evaluate(() => window.__game.chart.notes.length);
  // 判定の瞬間の元動画時刻と決め時刻の差を記録（累積ずれの確認）
  await page.evaluate(() => {
    window.__sync = [];
    const g = window.__game;
    const orig = g.onJudged.bind(g);
    g.onJudged = (e) => {
      orig(e);
      const n = g.chart.notes.find((x) => x.id === e.note.id);
      window.__sync.push({ id: n.id, noteT: n.t, judgedAt: e.time, kimeErr: g.chart.warp.map(e.time) - n.move.src.kime, lag: g.lastT - n.t });
    };
  });
  await page.click('#btnStart');
  await page.waitForTimeout(1500);
  if (shots) await page.screenshot({ path: `${shots}/auto_mid.png` });
  await waitEnd(page, await durationMs(page));
  const r = await page.evaluate(() => window.__lastResult);
  const sync = await page.evaluate(() => window.__sync);
  check(r.mode === 'auto', 'AUTO モードの結果');
  check(r.total === n && r.perfect === n && r.good === 0 && r.miss === 0, `AUTO 全 ${n} ノーツ PERFECT（P${r.perfect} G${r.good} M${r.miss}）`);
  check(new Set(r.log.map((x) => x.id)).size === n && r.log.length === n, 'AUTO 各ノーツ1回ずつ判定');
  check(r.log.every((x) => x.delta === 0 && x.source === 'auto'), 'AUTO 入力時刻＝ノーツ時刻（delta=0）');
  check(r.maxCombo === n, `最大コンボ ${r.maxCombo}`);
  const maxErr = Math.max(...sync.map((s) => Math.abs(s.kimeErr)));
  check(maxErr < 1e-6, `決めの元動画時刻と判定時刻の対応誤差 最大 ${(maxErr * 1000).toFixed(4)}ms（累積ずれなし）`);
  const lags = sync.map((s) => s.lag);
  console.log(`     判定処理された描画フレームの遅れ: 平均 ${(lags.reduce((a, b) => a + b, 0) / lags.length * 1000).toFixed(1)}ms / 最大 ${(Math.max(...lags) * 1000).toFixed(1)}ms（判定には影響しない）`);
  const badge = await page.textContent('#modeBadge');
  check(badge === 'AUTO DEMO', '画面に AUTO DEMO 表示');
  check((await page.textContent('#resultTitle')).includes('AUTO DEMO'), '結果画面で AUTO と明示');
  if (shots) await page.screenshot({ path: `${shots}/auto_result.png` });
  await page.close();
}

// --- 一時停止 / 再開 / リスタート ---
{
  const page = await open('&mode=auto');
  await page.click('#btnStart');
  await page.waitForTimeout(2600);
  await page.click('#btnPause');
  const t1 = await page.evaluate(() => window.__game.clock.now());
  const c1 = await page.evaluate(() => window.__game.judge.notes.filter((n) => n.result).length);
  await page.waitForTimeout(1500);
  const t2 = await page.evaluate(() => window.__game.clock.now());
  const c2 = await page.evaluate(() => window.__game.judge.notes.filter((n) => n.result).length);
  check(t1 === t2 && c1 === c2, `一時停止中は時刻・判定が進まない（${t1.toFixed(3)}s, ${c1}件）`);
  await page.click('#btnPause'); // 再開
  await page.waitForTimeout(1200);
  const t3 = await page.evaluate(() => window.__game.clock.now());
  check(t3 > t2 && t3 - t2 < 1.4, `再開後は停止位置から進む（+${(t3 - t2).toFixed(2)}s）`);
  // タブ非表示 → 自動一時停止
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  check(await page.evaluate(() => window.__game.state) === 'paused', 'タブ非表示で一時停止');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); });
  await page.click('#btnRestart');
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ t: window.__game.clock.now(), judged: window.__game.judge.notes.filter((n) => n.result).length }));
  check(after.t < 0.5, `リスタートで先頭へ（${after.t.toFixed(3)}s）`);
  await waitEnd(page, await durationMs(page));
  const r = await page.evaluate(() => window.__lastResult);
  check(r.log.length === r.total && r.perfect === r.total, `リスタート後も重複なく全 ${r.total} 件（log ${r.log.length}件）`);
  await page.close();
}

// --- MANUAL: 入力タイミングで判定が変わる ---
// 判定の期待値は「キーイベントの実際の時刻（event.timeStamp → 曲時刻）」から求める。
// テストがキーを送る時刻は描画負荷で遅れることがあるため、予定のずれではなく実測のずれで照合し、
// 送信の遅れは別に表示する（判定処理の誤りと、テストの送信遅れを区別するため）。
{
  // 描画負荷を下げて送信遅れを小さくする（判定処理は描画方式に依存しない）
  const page = await open(process.env.MANUAL_QUERY ?? '&mode=manual&canvas2d&quality=PERFORMANCE');
  await page.evaluate(() => {
    window.__keylog = [];
    window.addEventListener('keydown', (e) => {
      const g = window.__game;
      window.__keylog.push({ code: e.code, repeat: e.repeat, ts: e.timeStamp, song: g.clock.songTimeAtPerf(e.timeStamp) - g.inputLatency });
    }, true);
  });
  await page.click('#btnStart');
  const notes = await page.evaluate(() => window.__game.chart.notes.map((n) => ({ t: n.t, lane: window.__game.chart.commands.findIndex((c) => c.id === n.cmd) })));
  // レーン（譜面コマンド順）→ 既定のボタン A/B/X/Y → キー S/D/A/W（src/controls.js の一元表）
  const keys = ['KeyS', 'KeyD', 'KeyA', 'KeyW'];
  const plan = notes.slice(0, 8).map((n, i) => ({ ...n, i, off: [0, 0.12, null, 0, 0.03, -0.11, 0, 0.4][i] }));
  for (const p of plan) {
    if (p.off == null) continue;
    await page.waitForFunction((tt) => window.__game.clock.songTimeAtPerf(performance.now()) >= tt, p.t + p.off - 0.002, { timeout: 20000, polling: 1 });
    await page.keyboard.down(keys[p.lane]);
    await page.keyboard.up(keys[p.lane]);
  }
  // キー押しっぱなし（オートリピート）が複数の判定入力にならないこと
  const hold = notes[8];
  await page.waitForFunction((tt) => window.__game.clock.songTimeAtPerf(performance.now()) >= tt, hold.t - 0.02, { timeout: 20000, polling: 1 });
  const inBefore = await page.evaluate(() => window.__game.judge.consumedInputIds.size);
  await page.keyboard.down(keys[hold.lane]);
  for (let i = 0; i < 5; i++) await page.keyboard.down(keys[hold.lane]); // repeat=true
  await page.keyboard.up(keys[hold.lane]);
  await page.waitForTimeout(400);
  const inAfter = await page.evaluate(() => window.__game.judge.consumedInputIds.size);
  const res = await page.evaluate(() => window.__game.judge.notes.slice(0, 10).map((n) => ({ r: n.result, d: n.delta })));
  const log = (await page.evaluate(() => window.__keylog)).filter((k) => !k.repeat);
  const W = await page.evaluate(() => window.__game.judge.windows);
  console.log('     MANUAL 判定:', res.map((x) => `${x.r}${x.d != null ? `(${(x.d * 1000).toFixed(0)}ms)` : ''}`).join(' '));
  let k = 0;
  let consistent = true;
  const lags = [];
  for (const p of plan) {
    if (p.off == null) continue;
    const ev = log[k++];
    const actual = ev.song - p.t;
    lags.push(actual - p.off);
    const expect = Math.abs(actual) <= W.perfect ? 'PERFECT' : Math.abs(actual) <= W.good ? 'GOOD' : 'MISS';
    const got = res[p.i];
    const deltaOk = expect === 'MISS' ? got.d == null : Math.abs(got.d - actual) < 0.001;
    if (got.r !== expect || !deltaOk) consistent = false;
    console.log(`     ノーツ${p.i}: 予定 ${(p.off * 1000).toFixed(0)}ms / 実際のキー時刻 ${(actual * 1000).toFixed(1)}ms → 期待 ${expect} / 判定 ${got.r}${got.d != null ? ` ${(got.d * 1000).toFixed(1)}ms` : ''}`);
  }
  check(consistent, '各入力の判定が、キーイベントの実時刻から求めた期待値と一致（delta 誤差 <1ms）');
  console.log(`     テスト側のキー送信の遅れ: 平均 ${(lags.reduce((a, b) => a + b, 0) / lags.length * 1000).toFixed(1)}ms / 最大 ${(Math.max(...lags) * 1000).toFixed(1)}ms（判定処理の誤差ではない）`);
  check(res[2].r === 'MISS', '押さなかったノーツは MISS');
  check(res[7].r === 'MISS', '大きく遅れた入力（予定 +400ms）は MISS');
  check(new Set(res.slice(0, 8).map((x) => x.r)).size >= 2, 'タイミングによって判定が変わる');
  check(inAfter - inBefore === 1, `押しっぱなし／リピート5回でも判定への入力は1回（${inAfter - inBefore}回）`);
  if (shots) await page.screenshot({ path: `${shots}/manual.png` });
  await page.close();
}

// --- レイアウト（縦・横・PC）: 主要要素が画面内に収まり重ならない ---
for (const [name, vp] of [['portrait', { width: 390, height: 844 }], ['landscape', { width: 844, height: 390 }], ['pc', { width: 1280, height: 800 }], ['small-portrait', { width: 360, height: 640 }]]) {
  const page = await open('&mode=auto', vp);
  await page.click('#btnStart');
  await page.waitForTimeout(1200);
  const boxes = await page.evaluate(() => Object.fromEntries(['#stage', '#track', '#pad', '#controls', '#hud', '#btnStart', '#btnPause', '#btnRestart'].map((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return [s, { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }];
  })));
  const inside = Object.entries(boxes).every(([, b]) => b.x >= -0.5 && b.y >= -0.5 && b.r <= vp.width + 0.5 && b.w > 0 && b.h > 0);
  const scrollable = await page.evaluate(() => [...document.querySelectorAll('#side')].map((e) => e.scrollHeight > e.clientHeight + 1)[0]);
  const ov = (a, b) => a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;
  const s = boxes['#stage'];
  const noOverlap = !['#track', '#pad', '#controls', '#hud'].some((k) => ov(s, boxes[k]));
  const visibleBottom = ['#pad', '#track'].every((k) => boxes[k].b <= vp.height + 0.5);
  check(inside && noOverlap && visibleBottom && s.h >= 150, `レイアウト ${name}: 人物ステージ ${Math.round(s.w)}x${Math.round(s.h)}、要素が画面内・重なりなし${scrollable ? '（操作パネルはスクロール）' : ''}`);
  if (shots) await page.screenshot({ path: `${shots}/layout_${name}.png` });
  await page.close();
}

// --- 読み込み失敗の表示 ---
{
  const page = await browser.newPage();
  await page.goto(`${base}?chart=charts/does-not-exist.json`);
  await page.waitForFunction(() => window.__game?.state === 'error');
  const msg = await page.textContent('#status');
  check(msg.includes('404') && msg.includes('does-not-exist'), `読み込み失敗の原因を表示: 「${msg.split('\n')[0]}」`);
  await page.close();
}

await browser.close();
console.log(fail.length ? `\n失敗 ${fail.length} 件:\n- ${fail.join('\n- ')}` : '\nすべて成功');
process.exit(fail.length ? 1 : 0);
