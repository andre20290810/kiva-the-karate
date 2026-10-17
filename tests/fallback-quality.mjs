// WebGL2 が使えない環境の Canvas2D 切替と、画質切替時の曲時刻・床位置の連続性（ブラウザ実行）。
//   npm start (別ターミナル) → node tests/fallback-quality.mjs [譜面]
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const chart = process.argv[2] || 'tests/fixtures/synthetic/chart.json';
const base = process.env.BASE || 'http://127.0.0.1:8177/';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}`); if (!ok) fails.push(msg); };
const url = `${base}?chart=${encodeURIComponent(chart)}&mode=auto`;

// 1) WebGL2 非対応を再現（getContext('webgl2') が null を返す）
{
  const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const orig = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) { return type === 'webgl2' ? null : orig.call(this, type, ...rest); };
  });
  await page.goto(url);
  await page.waitForFunction(() => ['ready', 'error'].includes(window.__game?.state), null, { timeout: 120000 });
  const info = await page.evaluate(() => ({ state: window.__game.state, kind: window.__game.scene?.rendererKind, label: document.querySelector('#rendererInfo').textContent, q: window.__game.scene?.q.name }));
  check(info.state === 'ready' && info.kind === 'canvas2d', `WebGL2 なし → ${info.kind}（表示: ${info.label}、画質 ${info.q}）`);
  await page.click('#btnStart');
  await page.waitForFunction(() => window.__game.state === 'ended', null, { timeout: 120000 });
  const r = await page.evaluate(() => window.__lastResult);
  check(r.perfect === r.total && r.log.length === r.total, `Canvas2D でも AUTO 全 ${r.total} 件を1回ずつ PERFECT`);
  check(errors.length === 0, `Canvas2D 実行中のスクリプトエラー ${errors.length} 件${errors.length ? ': ' + errors[0] : ''}`);
  // 画面が真っ黒でないこと（描画が実際に行われている）
  const lum = await page.evaluate(() => {
    const c = document.querySelector('#stage'); const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data; let s = 0;
    for (let i = 0; i < d.length; i += 400) s += d[i] + d[i + 1] + d[i + 2];
    return s / (d.length / 400) / 3;
  });
  check(lum > 8, `Canvas2D の画面平均輝度 ${lum.toFixed(1)}（>8 = 描画されている）`);
  await page.close();
}

// 2) 画質切替: 曲時刻・判定に影響せず、床の流れた量が不連続にならない
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(url + '&quality=CINEMATIC');
  await page.waitForFunction(() => window.__game?.state === 'ready', null, { timeout: 120000 });
  check(await page.evaluate(() => window.__game.scene.rendererKind) === 'webgl2', 'WebGL2 環境では WebGL2 で描画');
  await page.click('#btnStart');
  await page.waitForFunction(() => window.__game.lastT > 2.0);
  const res = await page.evaluate(() => {
    const g = window.__game; const st = g.scene.st;
    const out = [];
    for (const q of ['PERFORMANCE', 'NORMAL', 'CINEMATIC', 'AUTO']) {
      const t = g.lastT;
      const before = { scroll: st.scroll(t), speed: st.speed, pos: g.clock.position(), judged: g.judge.notes.filter((n) => n.result).length };
      g.scene.setQuality(q, t);
      document.querySelector('#quality').value = q;
      const after = { scroll: st.scroll(t), speed: st.speed, pos: g.clock.position(), judged: g.judge.notes.filter((n) => n.result).length, name: g.scene.q.name };
      out.push({ q, t, before, after });
    }
    return out;
  });
  for (const r of res) {
    check(Math.abs(r.after.scroll - r.before.scroll) < 1e-9, `画質 ${r.q}（${r.after.name}）: 床速度 ${r.before.speed}→${r.after.speed}、床位置の差 ${(r.after.scroll - r.before.scroll).toExponential(1)}`);
    check(r.after.judged === r.before.judged && r.after.pos - r.before.pos < 0.05 && r.after.pos >= r.before.pos, `画質 ${r.q}: 曲時刻 ${r.before.pos.toFixed(3)}→${r.after.pos.toFixed(3)}（同一処理内の経過のみ）・判定数不変`);
  }
  await page.waitForFunction(() => window.__game.state === 'ended', null, { timeout: 120000 });
  const r = await page.evaluate(() => window.__lastResult);
  check(r.perfect === r.total && r.log.length === r.total, `画質切替後も AUTO 全 ${r.total} 件 PERFECT・重複なし`);
  await page.close();
}

await browser.close();
console.log(fails.length ? `\n失敗 ${fails.length} 件` : '\nすべて成功');
process.exit(fails.length ? 1 : 0);
