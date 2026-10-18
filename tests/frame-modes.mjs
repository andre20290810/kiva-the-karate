// 連番画像モード（KIVA FRAME ANIMATION / ALEXANDRE 2D FRAME ANIMATION）の確認（本番譜面・実素材が必要）。
//   npm start（別ターミナル）→ node tests/frame-modes.mjs [撮影先]
// 確認: 両モードの画像列が読み込まれて描画される / 切替で音声時刻が戻らない / 表示中のコマ番号が KIVA と同じ /
//       PC・縦・横でページエラーなし。スクリーンショットを保存。
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const out = process.argv[2] || 'test-results/frame-modes';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}`); if (!ok) fails.push(msg); };
const VIEWS = { pc: { width: 1280, height: 800 }, portrait: { width: 390, height: 844 }, landscape: { width: 844, height: 390 } };

for (const [vname, viewport] of Object.entries(VIEWS)) {
  const p = await browser.newPage({ viewport });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}?mode=auto`);
  await p.waitForFunction(() => window.__game?.state === 'ready', null, { timeout: 180000 });
  await p.click('#btnStart');
  for (const [mode, who, at] of [['kiva-frames', 'kiva', 14], ['alexandre-frames', 'alexandre', 14]]) {
    const before = await p.evaluate(() => window.__game.clock.position());
    await p.selectOption('#displayMode', mode);
    await p.waitForFunction((w) => window.__game.displayMode && window.__character?.id === w && window.__character.status !== 'loading', who, { timeout: 120000 });
    const st = await p.evaluate(() => ({ t: window.__game.clock.position(), ch: window.__character, frame: window.__debug?.frame, shown: window.__debug?.shown }));
    check(st.ch.status === 'ready' && st.ch.drawn, `${vname}/${mode}: ${who} の画像列を描画（${st.ch.status}）`);
    check(st.t >= before - 0.05, `${vname}/${mode}: 切替で音声時刻が戻らない（${before.toFixed(2)}→${st.t.toFixed(2)} s）`);
    await p.waitForTimeout(1500);
    const s2 = await p.evaluate(() => ({ frame: window.__debug?.frame, shown: window.__debug?.shown }));
    check(Number.isInteger(s2.shown) && Math.abs(s2.shown - s2.frame) <= 1, `${vname}/${mode}: 表示コマ ${s2.shown} = 時間軸のコマ ${s2.frame}`);
    await p.screenshot({ path: `${out}/${vname}_${mode}.png` });
  }
  check(errors.length === 0, `${vname}: ページエラーなし ${errors.slice(0, 2).join(' | ')}`);
  await p.close();
}
await browser.close();
console.log(fails.length ? `\n${fails.length} 件 NG` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
