// 視覚品質確認用のスクリーンショット取得（自動判定ではなく、人が見て確認するための画像）。
// 指定した瞬間に一時停止してから撮影するので、撮影の遅れで演出を取り逃さない。
//   npm start  (別ターミナル)
//   node tests/visual-shots.mjs [出力先=source/visual-shots] [譜面]
import { mkdirSync, existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const out = process.argv[2] || 'source/visual-shots';
const chart = process.argv[3] || 'tests/fixtures/synthetic/chart.json';
const base = process.env.BASE || 'http://127.0.0.1:8177/';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const quality = process.env.QUALITY || 'NORMAL';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });

async function open(vp, mode, extra = '') {
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 1, hasTouch: vp.width < 1100 });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`${base}?chart=${encodeURIComponent(chart)}&mode=${mode}&quality=${quality}${extra}`);
  await page.waitForFunction(() => ['ready', 'error'].includes(window.__game?.state), null, { timeout: 120000 });
  return page;
}
/** 音声時刻 tt に達したフレームで一時停止（撮影時刻は shoot で指定） */
const pauseAt = async (page, tt) => {
  await page.waitForFunction((x) => {
    const g = window.__game;
    if (g.state === 'playing' && g.lastT >= x) { g.pause(); return true; }
    return false;
  }, tt, { timeout: 60000, polling: 'raf' });
  page.__shotT = tt;
};
const resume = async (page) => {
  await page.click('#btnPause');
  await page.waitForFunction(() => window.__game.state === 'playing');
};
async function shoot(page, name) {
  // 一時停止でボタン表示が変わりレイアウトが動くため、落ち着いてから撮影時刻を描く。
  // 撮影専用: 時計（clock）・lastT・判定状態は変更せず「描画だけ」行う。これは見た目の確認用で、
  // 同期の正しさの証拠ではない（同期は tests/sync-probe.mjs で時刻を変えずに検証する）。
  await page.waitForTimeout(150);
  const t = page.__shotT;
  const drawn = await page.evaluate((x) => {
    const g = window.__game;
    if (x != null && g.state === 'paused') g.render(Math.min(x, g.displayTime()));
    return window.__debug?.t;
  }, t ?? null);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('saved', name, drawn != null ? `t=${drawn.toFixed(3)}` : '');
  page.__shotT = null;
}

// 1) AUTO: 待機・通常表示・PERFECT の時間経過
{
  const page = await open({ width: 1280, height: 800 }, 'auto');
  await shoot(page, '01_ready_pc');
  await page.click('#btnStart');
  const notes = await page.evaluate(() => window.__game.chart.notes.map((n) => ({ t: n.t, tech: n.move.vfx || 'generic' })));
  await pauseAt(page, notes[0].t - 0.3); await shoot(page, '02_auto_stage_pc');
  await resume(page);
  for (const [i, dt] of [[1, 0.0], [1, 0.06], [1, 0.16], [1, 0.32], [1, 0.6]]) {
    await pauseAt(page, notes[i].t + dt); await shoot(page, `03_perfect_${notes[i].tech}_${Math.round(dt * 1000)}ms`);
    await resume(page);
  }
  for (const i of [2, 3, 4, 5]) {
    await pauseAt(page, notes[i].t + 0.05); await shoot(page, `04_tech_${notes[i].tech}`);
    await resume(page);
  }
  await page.waitForFunction(() => window.__game.state === 'ended', null, { timeout: 60000 });
  await shoot(page, '09_result_auto');
  await page.close();
}

// 2) MANUAL: GOOD と MISS（共通の判定処理に入力を渡す）
{
  const page = await open({ width: 1280, height: 800 }, 'manual');
  await page.click('#btnStart');
  const notes = await page.evaluate(() => window.__game.chart.notes.map((n) => ({ t: n.t, cmd: n.cmd })));
  // 撮影用: ノーツ到達前に「ノーツ時刻+off に押した」入力を共通の判定処理へ渡す
  // （ヘッドレスの遅い描画で期限を過ぎて MISS になるのを避けるため。時計は変更しない）
  const hitAt = (i, off) => page.waitForFunction(({ n, off }) => {
    const g = window.__game;
    if (g.lastT >= n.t - 0.5) { g.judge.input({ cmd: n.cmd, time: n.t + off, source: 'visual-test', id: `v${n.t}` }); return true; }
    return false;
  }, { n: notes[i], off }, { polling: 'raf', timeout: 30000 });
  await hitAt(0, 0.11);
  await pauseAt(page, notes[0].t + 0.11 + 0.05); await shoot(page, '05_good_pc');
  await resume(page);
  // notes[1] は押さない → MISS
  await pauseAt(page, notes[1].t + 0.15 + 0.06); await shoot(page, '06_miss_pc');
  await page.close();
}

// 3) 縦画面・横画面（スマートフォン）
for (const [name, vp] of [['07_portrait_390x844', { width: 390, height: 844 }], ['08_landscape_844x390', { width: 844, height: 390 }]]) {
  const page = await open(vp, 'auto');
  await page.click('#btnStart');
  const t = await page.evaluate(() => window.__game.chart.notes[2].t);
  await pauseAt(page, t + 0.07); await shoot(page, name);
  await page.close();
}
await browser.close();
