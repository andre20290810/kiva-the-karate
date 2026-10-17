// キャラクター切替の確認（ブラウザ実行）。npm start 後に: node tests/character-switch.mjs [撮影先]
// 切替は表示する人物画像だけを変え、音声時刻・判定・AUTO に影響しないことを確認する。
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const shots = process.argv[2] || '';
const base = process.env.BASE || 'http://127.0.0.1:8177/';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
if (shots) mkdirSync(shots, { recursive: true });
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}`); if (!ok) fails.push(msg); };
const open = async (chart, vp = { width: 1280, height: 800 }, extra = '') => {
  const p = await browser.newPage({ viewport: vp });
  p.on('pageerror', (e) => fails.push('pageerror: ' + e.message));
  await p.goto(`${base}?chart=${encodeURIComponent(chart)}&mode=auto${extra}`);
  await p.waitForFunction(() => window.__game?.state === 'ready' && window.__character && window.__character.status !== 'loading', null, { timeout: 120000 });
  return p;
};
const state = (p) => p.evaluate(() => ({ ...window.__character, label: document.querySelector('#charBtn .who').textContent, notice: document.querySelector('#charNotice').hidden ? '' : document.querySelector('#charNotice').textContent, drawnScene: window.__game.scene.last?.drawn }));
const click = async (p) => {
  await p.click('#charBtn');
  await p.waitForFunction(() => window.__character.status !== 'loading', null, { timeout: 60000 });
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
};

// 1) 本番と同じ構成（KIVA ⇄ ALEXANDRE、ALEXANDRE のフレームは未作成）
{
  const p = await open('tests/fixtures/synthetic/chart.json');
  const geo = await p.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    return { btn: r('#charBtn'), stage: r('#stageWrap'), hud: r('#hud') };
  });
  check(geo.btn.left - geo.stage.left < 20 && geo.btn.top - geo.stage.top < 20 && geo.btn.width > geo.btn.height * 1.8 && geo.btn.height <= 34,
    `ゲーム画面の左上に小さな横長ボタン（${Math.round(geo.btn.width)}x${Math.round(geo.btn.height)}、ステージ左上から ${Math.round(geo.btn.left - geo.stage.left)},${Math.round(geo.btn.top - geo.stage.top)}）`);
  let s = await state(p);
  check(s.label === 'KIVA' && s.drawn && s.status === 'ready' && s.notice === '', `初期: ${s.label}・人物を描画`);
  if (shots) await p.screenshot({ path: `${shots}/char_kiva.png` });
  await click(p);
  s = await state(p);
  check(s.label === 'ALEXANDRE' && !s.drawn && s.drawnScene === false && /未完成/.test(s.notice) && /未作成/.test(s.notice),
    `1回押す: ${s.label}・人物を描かず「未完成」を表示（${s.notice.slice(0, 40)}…）`);
  if (shots) await p.screenshot({ path: `${shots}/char_alexandre_pending.png` });
  await click(p);
  s = await state(p);
  check(s.label === 'KIVA' && s.drawn && s.notice === '', `もう1回押す: ${s.label} に戻る`);

  // 再生中に何度切り替えても、音声時刻・判定・AUTO は変わらない
  await p.click('#btnStart');
  await p.waitForFunction(() => window.__game.lastT > 0.8);
  const jumps = [];
  for (let i = 0; i < 9; i++) {
    const r = await p.evaluate(async () => {
      const g = window.__game;
      const a = g.clock.position(); const n0 = g.judge.notes.filter((n) => n.result).length;
      document.querySelector('#charBtn').click();
      const b = g.clock.position(); const n1 = g.judge.notes.filter((n) => n.result).length;
      return { dt: b - a, state: g.state, judgedSame: n0 === n1 };
    });
    jumps.push(r);
    await p.waitForTimeout(700);
  }
  check(jumps.every((j) => j.state === 'playing' && j.judgedSame && j.dt >= 0 && j.dt < 0.01), `再生中の切替9回: 再生継続・切替前後の曲時刻差 最大 ${(Math.max(...jumps.map((j) => j.dt)) * 1000).toFixed(2)}ms・判定数不変`);
  await p.waitForFunction(() => window.__game.state === 'ended', null, { timeout: 120000 });
  const r = await p.evaluate(() => window.__lastResult);
  check(r.perfect === r.total && r.log.length === r.total && new Set(r.log.map((x) => x.id)).size === r.total, `切替を挟んでも AUTO 全 ${r.total} 件を1回ずつ PERFECT`);
  await p.close();
}

// 2) 読み込める別キャラクター・時間軸が合わないキャラクターの扱い（検証用の譜面）
{
  const p = await open('tests/fixtures/synthetic/chart-switch.json');
  await p.evaluate(() => localStorage.removeItem('kiva.character'));
  await p.reload();
  await p.waitForFunction(() => window.__game?.state === 'ready' && window.__character?.status !== 'loading', null, { timeout: 120000 });
  const seen = [];
  for (let i = 0; i < 4; i++) { seen.push(await state(p)); await click(p); }
  seen.push(await state(p));
  console.log('     順序:', seen.map((x) => `${x.label}(${x.status}${x.drawn ? '・描画' : ''})`).join(' → '));
  check(seen.map((x) => x.label).join(',') === 'KIVA,ALEXANDRE,TEST-ALT,TEST-BAD,KIVA', '押すたびに定義順に切替、最後に先頭へ戻る');
  check(seen[2].status === 'ready' && seen[2].drawn, '時間軸が一致するキャラクターは読み込んで描画');
  check(seen[3].status === 'unavailable' && !seen[3].drawn && /フレーム数/.test(seen[3].notice), '枚数が合わないキャラクターは描かず理由を表示');
  const stored = await p.evaluate(() => localStorage.getItem('kiva.character'));
  check(stored === 'kiva', `選択を保存（${stored}）`);
  await p.close();
}

// 3) 小さい画面でもボタンが HUD・操作部と重ならない
for (const vp of [{ width: 320, height: 480 }, { width: 568, height: 320 }, { width: 390, height: 844 }, { width: 1920, height: 1080 }]) {
  const p = await open('tests/fixtures/synthetic/chart.json', vp);
  const g = await p.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const ov = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const btn = r('#charBtn');
    return { inStage: btn.top >= r('#stageWrap').top - 0.5 && btn.right <= r('#stageWrap').right + 0.5, hud: ov(btn, r('#hud')), side: ov(btn, r('#side')), judge: ov(btn, r('#judgeText')) };
  });
  check(g.inStage && !g.hud && !g.side, `${vp.width}x${vp.height}: ボタンはステージ内・HUD/操作部と重ならない`);
  await p.close();
}

await browser.close();
console.log(fails.length ? `\n失敗 ${fails.length} 件` : '\nすべて成功');
process.exit(fails.length ? 1 : 0);
