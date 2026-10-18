// 3 モードの表示・切替・3D エフェクトの確認（Chromium。WebGL はソフトウェア描画）。
//   npm start（別ターミナル）→ node tests/three-modes.mjs [出力フォルダ]
// 確認: 各モードへ切替できる / 3D はスキン付き人体モデルを読む / 判定で手足に結び付いたエフェクトが出る /
//       モード切替で音声時刻・スコア・判定数が変わらない / 縦横・PC 画面でページエラーなし。スクリーンショットを保存。
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const out = process.argv[2] || 'test-results/three-modes';
const chart = 'tests/fixtures/synthetic/chart.json';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}`); if (!ok) fails.push(msg); };
const VIEWS = { pc: { width: 1280, height: 800 }, portrait: { width: 390, height: 844 }, landscape: { width: 844, height: 390 } };

for (const [vname, viewport] of Object.entries(VIEWS)) {
  const ctx = await browser.newContext({ viewport });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}?chart=${encodeURIComponent(chart)}&mode=auto`);
  await p.waitForFunction(() => window.__game?.state === 'ready', null, { timeout: 120000 });
  await p.click('#btnStart');
  for (const mode of ['kiva-video', 'kiva-3d', 'alexandre-3d']) {
    const before = await p.evaluate(() => ({ t: window.__game.clock.position(), judged: window.__game.log.length }));
    await p.selectOption('#displayMode', mode);
    await p.waitForFunction((m) => window.__game.displayMode === m, mode, { timeout: 60000 });
    const after = await p.evaluate(() => ({ t: window.__game.clock.position(), judged: window.__game.log.length, asset: window.__game.threeStage?.asset }));
    check(after.t >= before.t && after.t - before.t < 30, `${vname}/${mode}: 切替で音声時刻が戻らない（${before.t.toFixed(2)}→${after.t.toFixed(2)} s）`);
    if (mode.endsWith('-3d')) check(['skinned', 'demo'].includes(after.asset?.kind), `${vname}/${mode}: スキン付き人体モデルを使用（${after.asset?.kind}: ${after.asset?.path}）`);
    // 判定が出てエフェクトが生成されるまで待つ
    let fx = null;
    for (let i = 0; i < 40; i++) {
      await p.waitForTimeout(250);
      fx = await p.evaluate(() => ({ s: window.__game.threeStage?.vfx?.stats, j: window.__game.log.length }));
      if (mode === 'kiva-video' || (fx.s && fx.s.sparks > 0)) break;
    }
    if (mode.endsWith('-3d')) check(fx.s && fx.s.sparks > 0, `${vname}/${mode}: 判定で 3D エフェクト（火花 ${fx.s?.sparks}、イベント ${fx.s?.events}）`);
    await p.screenshot({ path: `${out}/${vname}_${mode}.png` });
  }
  check(errors.length === 0, `${vname}: ページエラーなし ${errors.slice(0, 2).join(' | ')}`);
  await ctx.close();
}
await browser.close();
console.log(fails.length ? `\n${fails.length} 件 NG` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
