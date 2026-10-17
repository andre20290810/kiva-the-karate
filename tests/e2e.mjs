// ブラウザでの通し確認（Playwright）。サーバーを起動してから実行:
//   node tools/serve.mjs 8080 &
//   node tests/e2e.mjs [chart=tests/fixtures/synthetic/chart.json] [shotsDir]
// AUTO 全編 → 全ノーツ1回ずつ PERFECT、一時停止/再開/リスタートで重複なし、MANUAL で判定が変わることを確認する。
const { chromium } = await import('playwright').catch(() => import('/opt/node-tools/node_modules/playwright/index.mjs'));

const chart = process.argv[2] || 'tests/fixtures/synthetic/chart.json';
const shots = process.argv[3] || '';
const base = process.env.BASE || 'http://localhost:8080/';
const url = (q) => `${base}?chart=${encodeURIComponent(chart)}&debug${q}`;
const fail = [];
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'NG  '} ${msg}`); if (!cond) fail.push(msg); };

const browser = await chromium.launch({ args: ['--autoplay-policy=user-gesture-required'] });

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
{
  const page = await open('&mode=manual');
  await page.click('#btnStart');
  // ノーツ時刻に対して ずれ 0ms / +120ms / 押さない / 違うキー を順に与える
  const notes = await page.evaluate(() => window.__game.chart.notes.map((n) => ({ t: n.t, lane: window.__game.chart.commands.findIndex((c) => c.id === n.cmd) })));
  const keys = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];
  const plan = notes.slice(0, 8).map((n, i) => ({ ...n, off: [0, 0.12, null, 0, 0.03, -0.11, 0, 0.4][i] }));
  for (const p of plan) {
    if (p.off == null) continue;
    await page.waitForFunction((tt) => window.__game.clock.songTimeAtPerf(performance.now()) >= tt, p.t + p.off - 0.002, { timeout: 20000, polling: 1 });
    await page.keyboard.down(keys[p.lane]);
    await page.keyboard.up(keys[p.lane]);
  }
  // キー押しっぱなし（オートリピート）が複数判定にならないこと
  const hold = notes[8];
  await page.waitForFunction((tt) => window.__game.clock.songTimeAtPerf(performance.now()) >= tt, hold.t - 0.01, { timeout: 20000, polling: 1 });
  const strayBefore = await page.evaluate(() => window.__game.judge.strayInputs);
  await page.keyboard.down(keys[hold.lane]);
  for (let i = 0; i < 5; i++) await page.keyboard.down(keys[hold.lane]); // repeat=true
  await page.keyboard.up(keys[hold.lane]);
  await page.waitForTimeout(400);
  const res = await page.evaluate(() => window.__game.judge.notes.slice(0, 10).map((n) => ({ r: n.result, d: n.delta })));
  console.log('     MANUAL 判定:', res.map((x) => `${x.r}${x.d != null ? `(${(x.d * 1000).toFixed(0)}ms)` : ''}`).join(' '));
  check(res[2].r === 'MISS', '押さなかったノーツは MISS');
  check(res[7].r === 'MISS', '大きく遅れた入力（+400ms）は MISS');
  check(new Set(res.slice(0, 8).map((x) => x.r)).size >= 2, 'タイミングによって判定が変わる');
  check(res[1].r === 'GOOD', '+120ms は GOOD');
  const strayAfter = await page.evaluate(() => window.__game.judge.strayInputs);
  check(res[8].r && res[8].r !== 'MISS' && strayAfter === strayBefore, `押しっぱなし／リピートは1回の入力として扱う（空振り増加 ${strayAfter - strayBefore}）`);
  const combo = await page.evaluate(() => window.__game.judge.combo);
  if (shots) await page.screenshot({ path: `${shots}/manual.png` });
  console.log(`     現在コンボ ${combo}`);
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
