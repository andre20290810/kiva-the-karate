// 編集（コマンド種別・視覚エフェクト）・保存・背後の炎・レーンの文字の大きさの確認（実素材が必要）:
//   npm start（別ターミナル）→ node tests/editor-fx-browser.mjs   （BASE=公開 URL でも可）
// - 流れる文字（息・構・撃・旋）と長押しの終端が、左端の判定の文字と同じ大きさ。長押しの両端は「息」で、間は直線
// - 誤って「撃」になっているノーツを「構」に変えると、文字・入力・効果音・エフェクトがそろう。ほかのノーツは変わらない
// - エフェクトを番号で選べる（6 種類のプレビュー）。向きを使わないエフェクトでは角度の設定が出ない。元に戻す／やり直す
// - 「この端末のデフォルトとして保存」→ 再読み込みで維持。通常プレイと AUTO で同じ設定。JSON の往復。「編集前に戻す」と「配布時の初期設定に戻す」
// - 背後の炎: 長押し中に育ち、成功で燃え上がる。一時停止で止まり、シーク・リトライで残らない
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const fails = [];
const check = (ok, msg, extra = '') => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}${extra ? ` ${extra}` : ''}`); if (!ok) fails.push(msg); };
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
const ready = (p) => p.waitForFunction(() => window.__app?.state === 'ready' || window.__app?.state === 'paused' || window.__app?.state === 'playing', null, { timeout: 120000 });

// ---------- 1. レーンの文字の大きさ・長押しの表示（縦・横） ----------
for (const [label, vp] of [['縦 393x852', { width: 393, height: 852 }], ['横 852x393', { width: 852, height: 393 }]]) {
  const ctx = await browser.newContext({ viewport: vp });
  const p = await ctx.newPage();
  await p.goto(`${base}?fresh=1`); await ready(p);
  const r = await p.evaluate(() => {
    const a = window.__app, g = a.lanes.glyph, calls = [], lines = [];
    const dn = g.drawNote.bind(g); g.drawNote = (ctx, ch, x, y, size, ...rest) => { calls.push({ ch, x, y, size }); return dn(ctx, ch, x, y, size, ...rest); };
    const hl = a.lanes._holdLine.bind(a.lanes); a.lanes._holdLine = (ctx, x0, x1, y, S, ...rest) => { lines.push({ x0, x1, y, S }); return hl(ctx, x0, x1, y, S, ...rest); };
    a.seek(4.6); a.draw(4.6);
    const jx = window.__debug.lanesInfo.jx;
    const head = calls.filter((c) => c.x < jx), flow = calls.filter((c) => c.x > jx);
    return { head: head.map((c) => c.size), flow: flow.map((c) => ({ ch: c.ch, size: c.size, y: c.y, x: c.x })), lines, tail: typeof g.drawTail };
  });
  const hs = new Set(r.head), fs = new Set(r.flow.map((f) => f.size));
  check(hs.size === 1 && fs.size === 1 && [...hs][0] === [...fs][0], `${label}: 流れる文字・長押しの終端が左端の判定の文字と同じ大きさ`, `判定 ${[...hs]} / 流れる ${[...fs]}`);
  const breath = r.flow.filter((f) => f.ch === '息');
  const ln = r.lines[0];
  check(breath.length === 2 && ln && breath.every((b) => Math.abs(b.y - ln.y) < 0.01) && ln.x1 > ln.x0 && r.tail === 'undefined',
    `${label}: 長押しの始端と終端はどちらも「息」、間はレーンに平行な直線（曲線の尾は廃止）`, `息 ${breath.length} 個、線 ${ln ? `${ln.x0.toFixed(0)}→${ln.x1.toFixed(0)} y=${ln.y.toFixed(1)}` : 'なし'}`);
  await ctx.close();
}

// ---------- 2. 編集: コマンド種別とエフェクト、他のノーツへの影響、元に戻す／やり直す、保存・再読み込み・JSON ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.goto(`${base}?fresh=1`); await ready(p);
  await p.evaluate(() => localStorage.clear());
  await p.goto(base); await ready(p);
  await p.click('#btnEdit');
  const target = await p.evaluate(() => window.__app.chart.notes.find((n) => n.button === 'A' && n.time > 15 && n.time < 16));
  const othersBefore = await p.evaluate((id) => JSON.stringify(window.__app.chart.notes.filter((n) => n.id !== id)), target.id);
  await p.evaluate((id) => { const e = window.__app.editor; e.selected = new Set([id]); e.refresh(); }, target.id);
  await p.waitForSelector('#nButton');
  const head = await p.textContent('.ed-noteid');
  check(head.includes(target.id) && head.includes(target.time.toFixed(2)), '選んだノーツの ID と時刻を表示', head.trim());
  const thumbs = await p.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 1500));
    return [...document.querySelectorAll('canvas[data-pv]')].map((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i]; return { id: c.dataset.pv, s }; });
  });
  const labels = await p.$$eval('.ed-fx span', (els) => els.map((e) => e.textContent));
  check(thumbs.length === 6 && thumbs.every((t) => t.s > 0) && labels.includes('No.5 背後にまとう炎') && labels.includes('No.0 エフェクトなし'), 'エフェクト一覧に番号・名称・プレビュー（6 種類）', labels.join(' / '));
  check(await p.$('#eAng') !== null, '打撃のエフェクトでは角度を設定できる');
  // 「撃」→「構」
  await p.selectOption('#nButton', 'X');
  const changed = await p.evaluate((id) => window.__app.chart.notes.find((n) => n.id === id), target.id);
  const fxAfter = await p.evaluate((id) => { const n = window.__app.chart.notes.find((x) => x.id === id); return import('/app/effects-catalog.js').then((m) => m.resolveEffect(n)); }, target.id);
  check(changed.button === 'X' && changed.action === 'stance' && changed.input === 'tap' && !changed.effect?.anchor && fxAfter.key === 'stance' && fxAfter.angle == null,
    '「撃」を「構」に変えると入力・動作・エフェクトが構えにそろい、打撃の方向・位置は残らない', JSON.stringify(changed.effect ?? null));
  check(await p.$('#eAng') === null && /向きを使いません/.test(await p.textContent('#edNoteBody')), '構えの発光では角度の設定が出ない');
  // エフェクトを番号で: No.5（背後にまとう炎）にし、炎の高さを変える
  await p.click('[data-fx="5"]');
  await p.$eval('#eH', (el) => { el.value = '1.4'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
  let ef = await p.evaluate((id) => window.__app.chart.notes.find((n) => n.id === id).effect, target.id);
  check(ef?.id === 5 && ef.height === 1.4, 'エフェクトを番号で指定し、炎の高さを調整', JSON.stringify(ef));
  check(!!(await p.evaluate(() => window.__app.editor.preview)), '選んだエフェクトをその動作の画像ですぐ試す');
  // 元に戻す／やり直す
  await p.click('[data-act=undo]');
  ef = await p.evaluate((id) => window.__app.chart.notes.find((n) => n.id === id).effect, target.id);
  check(ef?.id === 5 && ef.height == null, '元に戻す（高さの変更を取り消し）', JSON.stringify(ef));
  await p.click('[data-act=redo]');
  ef = await p.evaluate((id) => window.__app.chart.notes.find((n) => n.id === id).effect, target.id);
  check(ef?.height === 1.4, 'やり直す', JSON.stringify(ef));
  const othersAfter = await p.evaluate((id) => JSON.stringify(window.__app.chart.notes.filter((n) => n.id !== id)), target.id);
  check(othersAfter === othersBefore, '特定のノーツだけ変えても、他のノーツは変わらない');
  // この端末のデフォルトとして保存 → 再読み込み
  check(/未保存の編集/.test(await p.textContent('#edSource')), '保存前は「未保存の編集」と表示');
  await p.click('[data-act=saveDefault]');
  check(/この端末のデフォルト/.test(await p.textContent('#edSource')) && /公開版は変わりません/.test(await p.textContent('#edFile')), '保存後は「この端末のデフォルト」と表示し、公開版は変わらないことを明示');
  await p.goto(base); await ready(p);
  let st = await p.evaluate((id) => ({ src: window.__app.chartSource, n: window.__app.chart.notes.find((x) => x.id === id), status: document.querySelector('#status').textContent }), target.id);
  check(st.src === 'default' && st.n.button === 'X' && st.n.effect?.id === 5 && st.n.effect.height === 1.4 && /この端末のデフォルト/.test(st.status), '再読み込み後もこの端末のデフォルトで起動', st.status);
  // 通常プレイと AUTO で同じ設定（効果音の種類・人物のエフェクト）
  const run = (auto) => p.evaluate(async ({ id, auto }) => {
    const a = window.__app, n = a.chart.notes.find((x) => x.id === id);
    if (a.autoMode !== auto) document.querySelector('#btnAuto').click();
    const got = {};
    const trig = a.fx.trigger.bind(a.fx); a.fx.trigger = (kind, o) => { if (Math.abs(o.frameIndex - a.store.indexAt(n.time)) < 1) got.fx = kind; return trig(kind, o); };
    const play = a.sfx.play.bind(a.sfx); a.sfx.play = (k, g, o) => { got.sfx = k; return play(k, g, o); };
    a.seek(n.time - 0.6);
    if (a.state !== 'playing') a.togglePlay();
    await new Promise((r) => { const tick = () => (a.t > n.time + 0.3 ? r() : requestAnimationFrame(tick)); tick(); if (!auto) { const fire = () => { if (a.t >= n.time - 0.01) { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', key: 'x', bubbles: true })); setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX', key: 'x', bubbles: true })), 50); } else requestAnimationFrame(fire); }; fire(); } });
    a.pause(); a.fx.trigger = trig; a.sfx.play = play;
    return got;
  }, { id: target.id, auto });
  const gm = await run(false), ga = await run(true);
  check(gm.fx === 'backFire' && ga.fx === 'backFire' && gm.sfx === 'stance' && ga.sfx === 'stance', '手動と AUTO で同じ設定（構えの効果音・背後にまとう炎）', JSON.stringify({ 手動: gm, AUTO: ga }));
  // JSON の往復
  await p.click('#btnEdit');
  await p.click('[data-act=export]');
  const text = await p.evaluate(() => window.__lastExport);
  const exported = JSON.parse(text).notes.find((n) => n.id === target.id);
  await p.click('[data-act=reset]');
  const reset = await p.evaluate((id) => window.__app.chart.notes.find((n) => n.id === id), target.id);
  check(reset.button === 'A', '配布時の初期設定に戻す（公開版の譜面）');
  await p.click('[data-act=revert]');
  const reverted = await p.evaluate((id) => window.__app.chart.notes.find((n) => n.id === id), target.id);
  check(reverted.button === 'X' && reverted.effect?.height === 1.4, '編集前に戻す（この端末のデフォルトへ。配布時の初期設定とは別）');
  await p.click('[data-act=reset]');
  await p.evaluate((t) => window.__app.editor.importText(t, 'test.json'), text);
  const imported = await p.evaluate((id) => window.__app.chart.notes.find((n) => n.id === id), target.id);
  check(JSON.stringify(imported.effect) === JSON.stringify(exported.effect) && imported.button === 'X' && JSON.stringify(exported.effect) === JSON.stringify({ id: 5, height: 1.4 }),
    'JSON の書き出し → 読み込みで設定（コマンド・エフェクト番号・調整値）を保つ', JSON.stringify(imported.effect));
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await p.evaluate(() => localStorage.clear());
  await ctx.close();
}

// ---------- 3. 背後の炎: 育つ・燃え上がる・一時停止で止まる・シーク／リトライで残らない ----------
{
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}?fresh=1`); await ready(p);
  await p.click('#btnAuto');
  await p.evaluate(() => { const a = window.__app; a.seek(5.4); a.togglePlay(); });
  const at = (t) => p.waitForFunction((t) => window.__app.t > t, t, { timeout: 20000 });
  await at(6.2);
  const h1 = await p.evaluate(() => ({ ...window.__app.fx.hold, fx: undefined }));
  await at(7.6);
  const h2 = await p.evaluate(() => ({ ...window.__app.fx.hold, fx: undefined }));
  check(h1.key === 'backFire' && h2.key === 'backFire' && h2.progress > h1.progress + 0.3, '長押し中は背後の炎が育つ', `${h1.progress?.toFixed(2)} → ${h2.progress?.toFixed(2)}`);
  await at(8.55);
  const f = await p.evaluate(() => window.__app.fx.list.filter((e) => e.kind === 'backFire').map((e) => ({ hold: e.hold, t0: e.t0 })));
  check(f.length === 1 && f[0].hold, '成功の瞬間に背後の炎が 1 回だけ燃え上がる', JSON.stringify(f));
  // 一時停止: 炎の描画も止まる（同じ画面のまま）
  await p.evaluate(() => window.__app.pause());
  await p.waitForTimeout(150); // 一時停止した時刻で描き直されるのを待つ
  const shot = () => p.evaluate(() => { const c = window.__app.canvas; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0; return h; });
  const s1 = await shot(); await p.waitForTimeout(400); const s2 = await shot();
  check(s1 === s2, '一時停止中は炎のアニメーションも止まる');
  await p.evaluate(() => window.__app.play());
  await p.waitForTimeout(200);
  check(await shot() !== s2, '再開すると炎が続く');
  await p.evaluate(() => window.__app.seek(30));
  await p.waitForTimeout(100);
  let r = await p.evaluate(() => ({ list: window.__app.fx.list.length, hold: window.__app.fx.hold, sm: window.__app.fx.smother.length }));
  check(r.list === 0 && !r.hold && r.sm === 0, 'シークで前の炎が残らない', JSON.stringify(r));
  await p.evaluate(() => window.__app.seek(6.5));
  await at(7.0);
  await p.click('#btnRetry');
  await p.waitForTimeout(100);
  r = await p.evaluate(() => ({ list: window.__app.fx.list.length, hold: window.__app.fx.hold, sm: window.__app.fx.smother.length }));
  check(r.list === 0 && !r.hold && r.sm === 0, 'リトライで前の炎が残らない', JSON.stringify(r));
  // 手動: 途中で離すと燃え上がらずに消える
  await p.click('#btnAuto');
  await p.evaluate(() => window.__app.seek(5.5));
  await p.waitForFunction(() => window.__app.t >= 5.8, null, { timeout: 15000 });
  await p.keyboard.down('y');
  await at(6.8);
  await p.keyboard.up('y');
  await p.waitForTimeout(120);
  r = await p.evaluate(() => ({ list: window.__app.fx.list.filter((e) => e.kind === 'backFire').length, sm: window.__app.fx.smother.length, hold: !!window.__app.fx.hold }));
  check(r.list === 0 && r.sm === 1 && !r.hold, '途中で離すと燃え上がらず、育った炎は自然に消える', JSON.stringify(r));
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await ctx.close();
}

await browser.close();
console.log(fails.length ? `\nNG ${fails.length} 件` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
