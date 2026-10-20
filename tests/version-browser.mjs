// バージョン切り替えの確認（実素材が必要）: npm start（別ターミナル）→ node tests/version-browser.mjs
// 保存内容がバージョン間で混ざらないこと、切り替えで画像・音声が混ざらないこと、未保存の編集の保存／破棄、
// 別バージョンの JSON を読み込まないこと、最後に選んだバージョンを覚えることを、実際の画面操作で確かめる。
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const fails = [];
const check = (ok, msg, extra = '') => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}${extra ? ` ${extra}` : ''}`); if (!ok) fails.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const p = await ctx.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
let reqs = [];
p.on('request', (r) => reqs.push(new URL(r.url()).pathname));
const ready = () => p.waitForFunction(() => document.documentElement.dataset.state === 'ready', null, { timeout: 120000 });
const info = () => p.evaluate(() => {
  const a = window.__app;
  return { version: a.version, badge: document.querySelector('#verBadge').textContent, manifest: a.initialChart.source.frameManifest,
    audio: a.audioSrc, t: a.t, state: a.state, notes: a.chart.notes.length, chartVersion: a.chart.gameVersion,
    status: document.querySelector('#status').textContent };
});
const ls = (k) => p.evaluate((k) => localStorage.getItem(k), k);
const openSettings = async () => { if (!(await p.evaluate(() => document.querySelector('#more').open))) await p.click('#more summary'); };

// 0. 以前からの保存内容（ver1 の自動保存とプレイ記録）がある状態を作る
await p.goto(base);
await p.evaluate(() => localStorage.clear());
await p.goto(base);
await ready();
let s = await info();
check(s.version === 'v1' && s.badge === 'ver1' && s.manifest === 'assets/seipai/manifest.json' && s.chartVersion === 'v1', '保存なし・URL 指定なしは ver1（従来の素材・譜面）', JSON.stringify(s).slice(0, 120));
await p.click('#btnEdit');
const v1Edit = await p.evaluate(() => { const ed = window.__app.editor; const n = window.__app.chart.notes[1]; ed.apply((c) => { c.notes.find((x) => x.id === n.id).time = 12.3; }, 'テスト'); return n.id; });
await p.evaluate(() => localStorage.setItem('kiva2d.best.manual', JSON.stringify({ score: 12345, auto: false })));
await sleep(500);
const v1Saved = await ls('kiva2d.chart.autosave.v1');
check(!!v1Saved && JSON.parse(v1Saved).notes.find((n) => n.id === v1Edit).time === 12.3, 'ver1 の編集は従来のキーに自動保存');

// 1. 再生中に ver2 へ切り替え → 先頭（開始前）から、ver2 の素材だけを読む
await p.click('#btnEdit');
await p.click('#btnPlay');
await p.waitForFunction(() => window.__app.t > 1.5, null, { timeout: 20000 });
await openSettings();
reqs = [];
await Promise.all([p.waitForURL(/[?&]v=v2/), p.selectOption('#gameVersion', 'v2')]);
await ready();
s = await info();
check(s.version === 'v2' && s.badge === 'ver2' && s.manifest === 'assets/seipai_v2/manifest.json' && s.chartVersion === 'v2', '再生中でも ver2 に切り替わる（素材・譜面・表示）');
check(s.state === 'ready' && s.t < 0 && /ver2 に切り替えました/.test(s.status), '切り替え後は先頭（開始前）から', `t=${s.t.toFixed(2)} ${s.status.slice(0, 40)}`);
const v1Assets = reqs.filter((u) => /\/assets\/seipai\//.test(u));
const v2Cuts = reqs.filter((u) => /\/assets\/seipai_v2\/cut\//.test(u)).length;
check(v1Assets.length === 0 && v2Cuts === 412 && /seipai_v2\/audio/.test(s.audio), '切り替え後に読むのは ver2 の画像 412 枚と ver2 の音声だけ', `ver1 の素材 ${v1Assets.length} 件、ver2 の画像 ${v2Cuts} 件、音声 ${s.audio}`);
check(s.notes === 46 && !(await p.evaluate(() => window.__app.chart.notes.some((n) => n.time === 12.3))), 'ver2 に ver1 の編集内容が入らない');

// 2. ver2 で編集 → ver2 のキーに保存。ver1 の保存内容は変わらない
await p.click('#btnEdit');
await p.evaluate(() => window.__app.editor.apply((c) => { c.notes[0].duration = 2.2; }, 'テスト'));
await sleep(500);
const v2Saved = await ls('kiva2d.v2.chart.autosave');
check(!!v2Saved && JSON.parse(v2Saved).gameVersion === 'v2' && JSON.parse(v2Saved).notes[0].duration === 2.2, 'ver2 の編集は ver2 のキーに保存（gameVersion: v2）');
check((await ls('kiva2d.chart.autosave.v1')) === v1Saved && JSON.parse(await ls('kiva2d.best.manual')).score === 12345, 'ver1 の自動保存・プレイ記録はそのまま');

// 3. ver2 で ver1 の JSON を読み込もうとすると拒否（今の編集内容はそのまま）
const rej = await p.evaluate((text) => { const before = JSON.stringify(window.__app.chart); const ok = window.__app.editor.importText(text, 'ver1.json'); return { ok, same: before === JSON.stringify(window.__app.chart), msg: document.querySelector('#edMsg').textContent }; }, v1Saved);
check(!rej.ok && rej.same && /ver1 用/.test(rej.msg), '別バージョン（ver1）の JSON は読み込まない', rej.msg.slice(0, 60));
const legacy = await p.evaluate(() => fetch('charts/seipai.json').then((r) => r.text()));
const rej2 = await p.evaluate((text) => window.__app.editor.importText(text, 'legacy.json'), legacy);
check(!rej2, 'バージョン指定のない従来の JSON は ver1 扱い（ver2 には読み込まない）');

// 4. 未保存の編集（補正欄の未適用の入力）がある → 切り替え時に保存／破棄／キャンセルを選べる
const box = '#editor';
await p.fill(`${box} #fDx`, '0.04');
await sleep(150);
await openSettings();
await p.selectOption('#gameVersion', 'v1');
await p.waitForSelector('#verDialog:not([hidden])');
check(/未適用の補正/.test(await p.textContent('#verDialogBody')), '未保存の編集があると確認を出す', (await p.textContent('#verDialogBody')).slice(0, 50));
await p.click('#verCancel');
s = await info();
check(s.version === 'v2' && (await p.inputValue('#gameVersion')) === 'v2' && (await p.inputValue(`${box} #fDx`)) === '0.04', 'キャンセルで切り替えず、入力も残る');
await p.selectOption('#gameVersion', 'v1');
await p.waitForSelector('#verDialog:not([hidden])');
const draftFrame = await p.evaluate(() => window.__app.editor.frameDraft.frame);
await Promise.all([p.waitForURL(/[?&]v=v1/), p.click('#verSave')]);
await ready();
const v2After = JSON.parse(await ls('kiva2d.v2.chart.autosave'));
check(v2After.display.frameOverrides[draftFrame]?.dx === 0.04, '「保存して切り替え」で未適用の補正を ver2 に保存', JSON.stringify(v2After.display.frameOverrides));
s = await info();
check(s.version === 'v1' && (await p.evaluate((id) => window.__app.chart.notes.find((n) => n.id === id).time, v1Edit)) === 12.3, 'ver1 に戻ると ver1 の編集内容が復元');
check(!(await p.evaluate(() => Object.keys(window.__app.chart.display.frameOverrides).length)), 'ver1 に ver2 の補正値が入らない');
// 破棄
await p.click('#btnEdit');
await p.fill(`${box} #fDy`, '0.02');
await sleep(150);
await openSettings();
await p.selectOption('#gameVersion', 'v2');
await p.waitForSelector('#verDialog:not([hidden])');
await Promise.all([p.waitForURL(/[?&]v=v2/), p.click('#verDiscard')]);
await ready();
const v1After = JSON.parse(await ls('kiva2d.chart.autosave.v1'));
check(!Object.keys(v1After.display.frameOverrides || {}).length, '「破棄して切り替え」で未適用の補正を保存しない');

// 5. 最後に選んだバージョンを覚える（URL の指定なしで開くと ver2）
await p.goto(base);
await ready();
s = await info();
check(s.version === 'v2' && s.badge === 'ver2', '最後に選んだバージョン（ver2）で開く');
check(errors.length === 0, 'ページエラーなし', errors.join(' / '));

await p.evaluate(() => localStorage.clear());
await browser.close();
console.log(fails.length ? `\nNG ${fails.length} 件` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
