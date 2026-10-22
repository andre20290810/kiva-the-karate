// 編集（コマンド種別・視覚エフェクト）・保存・呼吸の気・効果音がないこと・レーンの文字の大きさの確認（実素材が必要）:
//   npm start（別ターミナル）→ node tests/editor-fx-browser.mjs   （BASE=公開 URL でも可）
// - 流れる文字（息・構・撃・旋）と長押しの終端が、左端の判定の文字と同じ大きさ。長押しの両端は「息」で、間は直線
// - 誤って「撃」になっているノーツを「構」に変えると、文字・入力・エフェクトがそろう。ほかのノーツは変わらない
// - エフェクトを番号で選べる（No.0〜4 のプレビュー。No.5 は廃止）。向きを使わないエフェクトでは角度の設定が出ない。元に戻す／やり直す
// - 「この端末のデフォルトとして保存」→ 再読み込みで維持。通常プレイと AUTO で同じ設定。JSON の往復。「編集前に戻す」と「配布時の初期設定に戻す」
// - 保存済みの No.5（廃止）は 息→No.1、ほか→No.0 に置き換わり、ほかの編集内容は残る
// - 呼吸の気（No.1）: 人物の内側だけ（輪郭の外・体の隙間に出ない）。長押しで育ち、一時停止で止まり、シーク・リトライで残らない
// - 効果音: 手動・AUTO・編集のプレビューで鳴らない（効果音の音源を作らない・出力が無音）。BGM は鳴る
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
    // 最初の息の長押しの始端と終端が両方レーンに見える時刻
    const h = a.chart.notes.find((n) => n.button === 'Y'), t = h.time + h.duration - a.chart.settings.laneLeadSeconds + 0.15;
    a.seek(t); a.draw(t);
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
  const target = await p.evaluate(() => window.__app.chart.notes.find((n) => n.button === 'A'));
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
  check(thumbs.length === 5 && thumbs.every((t) => t.s > 0) && labels.includes('No.1 呼吸の気') && labels.includes('No.0 エフェクトなし') && !labels.some((l) => /No\.5|炎/.test(l)) && !(await p.$('[data-fx="5"]')),
    'エフェクト一覧に番号・名称・プレビュー（No.0〜4。No.5 は選べない）', labels.join(' / '));
  check(await p.$('#eAng') !== null, '打撃のエフェクトでは角度を設定できる');
  // 「撃」→「構」
  await p.selectOption('#nButton', 'X');
  const changed = await p.evaluate((id) => window.__app.chart.notes.find((n) => n.id === id), target.id);
  const fxAfter = await p.evaluate((id) => { const n = window.__app.chart.notes.find((x) => x.id === id); return import('/app/effects-catalog.js').then((m) => m.resolveEffect(n)); }, target.id);
  check(changed.button === 'X' && changed.action === 'stance' && changed.input === 'tap' && !changed.effect?.anchor && fxAfter.key === 'stance' && fxAfter.angle == null,
    '「撃」を「構」に変えると入力・動作・エフェクトが構えにそろい、打撃の方向・位置は残らない', JSON.stringify(changed.effect ?? null));
  check(await p.$('#eAng') === null && /向きを使いません/.test(await p.textContent('#edNoteBody')), '構えの発光では角度の設定が出ない');
  // エフェクトを番号で: No.1（呼吸の気）にし、強さを変える
  await p.click('[data-fx="1"]');
  await p.$eval('#eInt', (el) => { el.value = '1.4'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
  let ef = await p.evaluate((id) => window.__app.chart.notes.find((n) => n.id === id).effect, target.id);
  check(ef?.id === 1 && ef.intensity === 1.4, 'エフェクトを番号で指定し、強さを調整', JSON.stringify(ef));
  check(!!(await p.evaluate(() => window.__app.editor.preview)), '選んだエフェクトをその動作の画像ですぐ試す');
  // 元に戻す／やり直す
  await p.click('[data-act=undo]');
  ef = await p.evaluate((id) => window.__app.chart.notes.find((n) => n.id === id).effect, target.id);
  check(ef?.id === 1 && ef.intensity == null, '元に戻す（強さの変更を取り消し）', JSON.stringify(ef));
  await p.click('[data-act=redo]');
  ef = await p.evaluate((id) => window.__app.chart.notes.find((n) => n.id === id).effect, target.id);
  check(ef?.intensity === 1.4, 'やり直す', JSON.stringify(ef));
  const othersAfter = await p.evaluate((id) => JSON.stringify(window.__app.chart.notes.filter((n) => n.id !== id)), target.id);
  check(othersAfter === othersBefore, '特定のノーツだけ変えても、他のノーツは変わらない');
  // この端末のデフォルトとして保存 → 再読み込み
  check(/未保存の編集/.test(await p.textContent('#edSource')), '保存前は「未保存の編集」と表示');
  await p.click('[data-act=saveDefault]');
  check(/この端末のデフォルト/.test(await p.textContent('#edSource')) && /公式データ（ほかの利用者）は変わりません/.test(await p.textContent('#edFile'))
    && /個人用に保存/.test(await p.textContent('[data-act=saveDefault]')) && /公式データとして保存・公開/.test(await p.textContent('[data-act=official]')),
    '保存後は「この端末のデフォルト」と表示し、公式データは変わらないことを明示（「個人用に保存」と「公式データとして保存・公開」は別のボタン）');
  await p.goto(base); await ready(p);
  let st = await p.evaluate((id) => ({ src: window.__app.chartSource, n: window.__app.chart.notes.find((x) => x.id === id), status: document.querySelector('#status').textContent }), target.id);
  check(st.src === 'default' && st.n.button === 'X' && st.n.effect?.id === 1 && st.n.effect.intensity === 1.4 && /この端末のデフォルト/.test(st.status), '再読み込み後もこの端末のデフォルトで起動', st.status);
  // 通常プレイと AUTO で同じ設定（人物のエフェクト）。効果音はない
  const run = (auto) => p.evaluate(async ({ id, auto }) => {
    const a = window.__app, n = a.chart.notes.find((x) => x.id === id);
    if (a.autoMode !== auto) document.querySelector('#btnAuto').click();
    const got = {};
    const trig = a.fx.trigger.bind(a.fx); a.fx.trigger = (kind, o) => { if (Math.abs(o.frameIndex - a.store.indexAt(n.time)) < 1) got.fx = kind; return trig(kind, o); };
    got.sfx = a.sfx === undefined ? 'なし' : 'あり';
    a.seek(n.time - 0.6);
    if (a.state !== 'playing') a.togglePlay();
    await new Promise((r) => { const tick = () => (a.t > n.time + 0.3 ? r() : requestAnimationFrame(tick)); tick(); if (!auto) { const fire = () => { if (a.t >= n.time - 0.01) { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', key: 'x', bubbles: true })); setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX', key: 'x', bubbles: true })), 50); } else requestAnimationFrame(fire); }; fire(); } });
    a.pause(); a.fx.trigger = trig;
    return got;
  }, { id: target.id, auto });
  const gm = await run(false), ga = await run(true);
  check(gm.fx === 'breath' && ga.fx === 'breath' && gm.sfx === 'なし' && ga.sfx === 'なし', '手動と AUTO で同じ設定（呼吸の気。効果音なし）', JSON.stringify({ 手動: gm, AUTO: ga }));
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
  check(reverted.button === 'X' && reverted.effect?.intensity === 1.4, '編集前に戻す（この端末のデフォルトへ。配布時の初期設定とは別）');
  await p.click('[data-act=reset]');
  await p.evaluate((t) => window.__app.editor.importText(t, 'test.json'), text);
  const imported = await p.evaluate((id) => window.__app.chart.notes.find((n) => n.id === id), target.id);
  check(JSON.stringify(imported.effect) === JSON.stringify(exported.effect) && imported.button === 'X' && JSON.stringify(exported.effect) === JSON.stringify({ id: 1, intensity: 1.4 }),
    'JSON の書き出し → 読み込みで設定（コマンド・エフェクト番号・調整値）を保つ', JSON.stringify(imported.effect));
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await p.evaluate(() => localStorage.clear());
  await ctx.close();
}

// ---------- 3. 保存済みの No.5（廃止）の置き換え ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}?fresh=1`); await ready(p);
  // 下書きとして No.5 を含む譜面を保存（息と構に No.5、構は表示名も編集済み、frameOverrides あり）
  const plan = await p.evaluate(async () => {
    const { exportChart } = await import('/app/chart.js');
    const c = structuredClone(window.__app.initialChart);
    const y = c.notes.find((n) => n.button === 'Y'), x = c.notes.find((n) => n.button === 'X');
    y.effect = { id: 5, height: 1.4, intensity: 1.5 };
    x.effect = { id: 5, size: 1.2 }; x.label = '構え（編集済み）';
    c.display.frameOverrides = { 33: { dx: 0.02, dy: 0, scale: 1.04 } };
    const raw = JSON.parse(exportChart(c)); // exportChart は 5 を置き換えるので、保存する JSON に 5 を書き戻す
    raw.notes.find((n) => n.id === y.id).effect = { id: 5, height: 1.4, intensity: 1.5 };
    raw.notes.find((n) => n.id === x.id).effect = { id: 5, size: 1.2 };
    localStorage.setItem('kiva2d.v2.chart.default', JSON.stringify(raw));
    // 古い音声の設定（効果音の音量・ミュートつき）
    localStorage.setItem('kiva2d.v2.audio', JSON.stringify({ bgm: 'spear', levels: { voice: 0.55, bgm: 0.7, sfx: 0.9 }, mutes: { voice: false, bgm: false, sfx: false }, sfxReset: 'x' }));
    localStorage.setItem('kiva2d.prefs.v1', JSON.stringify({ volume: 0.8, sfx: 0.6, fxStrength: 1 }));
    return { y: { id: y.id, time: y.time, duration: y.duration }, x: { id: x.id, time: x.time } };
  });
  await p.goto(base); await ready(p);
  const got = await p.evaluate((plan) => {
    const a = window.__app, y = a.chart.notes.find((n) => n.id === plan.y.id), x = a.chart.notes.find((n) => n.id === plan.x.id);
    return { src: a.chartSource, y, x, ov: a.chart.display.frameOverrides, audio: JSON.parse(localStorage.getItem('kiva2d.v2.audio')), prefs: JSON.parse(localStorage.getItem('kiva2d.prefs.v1')), levels: a.clock.levels };
  }, plan);
  check(got.src === 'default' && JSON.stringify(got.y.effect) === JSON.stringify({ id: 1, intensity: 1.5 }) && JSON.stringify(got.x.effect) === JSON.stringify({ id: 0, size: 1.2 }),
    '保存済みの No.5 は 息→No.1、ほか→No.0 に置き換わる', JSON.stringify({ 息: got.y.effect, 構: got.x.effect }));
  check(got.y.time === plan.y.time && got.y.duration === plan.y.duration && got.x.time === plan.x.time && got.x.label === '構え（編集済み）' && got.ov['33']?.scale === 1.04,
    '置き換えても時刻・長押し時間・表示名・frameOverrides は残る');
  check(got.audio.bgm === 'spear' && got.audio.levels.voice === 0.55 && got.audio.levels.bgm === 0.7 && !('sfx' in got.audio.levels) && !('sfxReset' in got.audio) && !('sfx' in got.prefs) && !('sfx' in got.levels),
    '古い保存設定の効果音の項目は消え、BGM・元動画の音声の設定は残る', JSON.stringify(got.audio));
  // JSON の読み込みでも置き換わる
  await p.click('#btnEdit');
  const imp = await p.evaluate(async () => {
    const c = JSON.parse((await import('/app/chart.js')).exportChart(window.__app.initialChart));
    const b = c.notes.find((n) => n.button === 'B');
    b.effect = { id: 5, intensity: 0.7 };
    window.__app.editor.importText(JSON.stringify(c), 'old.json');
    return window.__app.chart.notes.find((n) => n.id === b.id).effect;
  });
  check(JSON.stringify(imp) === JSON.stringify({ id: 0, intensity: 0.7 }), 'No.5 を含む JSON も読み込め、旋→No.0 に置き換わる', JSON.stringify(imp));
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await p.evaluate(() => localStorage.clear());
  await ctx.close();
}

// ---------- 4. 呼吸の気（No.1）: 人物の内側だけ・長押しで育つ・一時停止で止まる・シーク／リトライで残らない ----------
for (const [label, vp] of [['縦 393x852', { width: 393, height: 852 }], ['横 852x393', { width: 852, height: 393 }]]) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}?fresh=1`); await ready(p);
  await p.click('#btnAuto');
  // 2 秒以上の息の長押し（譜面から）
  const H = await p.evaluate(() => { const n = window.__app.chart.notes.find((x) => x.button === 'Y' && x.duration >= 2); return { t: n.time, d: n.duration }; });
  await p.evaluate((t) => { const a = window.__app; a.seek(t); a.togglePlay(); }, H.t - 0.4);
  const at = (t) => p.waitForFunction((t) => window.__app.t > t, t, { timeout: 20000 });
  // 実際の画面で: 演出あり／なしの差が人物の外（アルファ 0）に出ていないか（長押し中・成功直後）
  const leak = () => p.evaluate(() => {
    const a = window.__app, t = a.t, c = a.canvas, g = c.getContext('2d');
    a.pause();
    const fi = a.store.indexAt(Math.max(0, t)), b = a.store.get(fi), T = a.transformFor(b.index), r = T.crop(), d = a.dpr;
    const box = [Math.max(0, Math.floor((r.x - r.w * 0.3) * d)), Math.max(0, Math.floor((r.y - r.h * 0.1) * d))];
    const bw = Math.min(c.width - box[0], Math.ceil(r.w * 1.6 * d)), bh = Math.min(c.height - box[1], Math.ceil(r.h * 1.2 * d));
    const grab = () => g.getImageData(box[0], box[1], bw, bh).data;
    a.draw(t); const on = grab();
    const list = a.fx.list, hold = a.fx.hold, gl = a.lanes.glyph.list, gh = a.lanes.glyph.hold;
    a.fx.list = []; a.fx.hold = null; a.fx.setHold = () => {}; const rh = a.fx.renderHold; a.fx.renderHold = () => {};
    a.draw(t); const off = grab();
    a.fx.list = list; a.fx.hold = hold; a.fx.renderHold = rh; delete a.fx.setHold; void gl; void gh;
    // 人物のアルファ（同じ位置・大きさ）
    const m = document.createElement('canvas'); m.width = c.width; m.height = c.height;
    const mg = m.getContext('2d'); mg.setTransform(d, 0, 0, d, 0, 0); mg.drawImage(b.bmp, r.x, r.y, r.w, r.h);
    const ma = mg.getImageData(box[0], box[1], bw, bh).data;
    let inside = 0, outside = 0;
    for (let i = 0; i < on.length; i += 4) {
      const diff = Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1]) + Math.abs(on[i + 2] - off[i + 2]);
      if (diff > 6) { if (ma[i + 3] > 0) inside++; else outside++; }
    }
    a.play();
    return { inside, outside, key: hold?.key ?? list[0]?.kind };
  });
  await at(H.t + H.d * 0.6);
  const l1 = await leak();
  await at(H.t + H.d + 0.05);
  const l2 = await leak();
  check(l1.key === 'breath' && l1.inside > 300 && l1.outside === 0 && l2.inside > 300 && l2.outside === 0, `${label}: 呼吸の気は人物の内側だけ（輪郭の外・体の隙間に 0 画素）`,
    `長押し中 内 ${l1.inside} / 外 ${l1.outside}、成功直後 内 ${l2.inside} / 外 ${l2.outside}`);
  await p.evaluate((t) => window.__app.seek(t), H.t - 0.4);
  await at(H.t + 0.4);
  const h1 = await p.evaluate(() => ({ key: window.__app.fx.hold?.key, progress: window.__app.fx.hold?.progress }));
  await at(H.t + H.d * 0.8);
  const h2 = await p.evaluate(() => ({ key: window.__app.fx.hold?.key, progress: window.__app.fx.hold?.progress }));
  check(h1.key === 'breath' && h2.progress > h1.progress + 0.3, `${label}: 長押し中は呼吸の気が育つ`, `${h1.progress?.toFixed(2)} → ${h2.progress?.toFixed(2)}`);
  await at(H.t + H.d + 0.1);
  await p.evaluate(() => window.__app.pause());
  await p.waitForTimeout(150);
  const shot = () => p.evaluate(() => { const c = window.__app.canvas; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0; return h; });
  const s1 = await shot(); await p.waitForTimeout(400); const s2 = await shot();
  check(s1 === s2, `${label}: 一時停止中は演出も止まる`);
  await p.evaluate(() => window.__app.seek(30));
  await p.waitForTimeout(100);
  let r = await p.evaluate(() => ({ list: window.__app.fx.list.length, hold: window.__app.fx.hold }));
  check(r.list === 0 && !r.hold, `${label}: シークで前の演出が残らない`);
  await p.evaluate((t) => { window.__app.seek(t); window.__app.play(); }, H.t + 0.3);
  await at(H.t + 0.8);
  await p.click('#btnRetry');
  await p.waitForTimeout(100);
  r = await p.evaluate(() => ({ list: window.__app.fx.list.length, hold: window.__app.fx.hold }));
  check(r.list === 0 && !r.hold, `${label}: リトライで前の演出が残らない`);
  check(errors.length === 0, `${label}: ページエラーなし`, errors.join(' / '));
  await ctx.close();
}

// ---------- 5. 効果音が鳴らない（手動・AUTO・編集のプレビュー）。BGM は鳴る ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // 効果音に使っていた音源（発振器・フィルター・歪み・パン）を作ったら数える
  await ctx.addInitScript(() => {
    window.__nodes = 0;
    const P = (window.BaseAudioContext || window.AudioContext).prototype;
    for (const k of ['createOscillator', 'createBiquadFilter', 'createWaveShaper', 'createStereoPanner']) {
      const f = P[k]; P[k] = function (...a) { window.__nodes++; return f.apply(this, a); };
    }
  });
  const p = await ctx.newPage();
  const errors = [], requests = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('request', (q) => requests.push(q.url()));
  await p.goto(`${base}?fresh=1`); await ready(p);
  await p.waitForFunction(() => window.__app?.bgmState?.status === 'ready', null, { timeout: 120000 });
  check(!(await p.$('#mixSfx, #muteSfx')) && !/効果音/.test(await p.textContent('#more')), '効果音の音量・ミュートの設定欄がない');
  await p.click('#bgmStart');
  await p.waitForFunction(() => window.__app.t > 1, null, { timeout: 15000 });
  const bgm = await p.evaluate(async () => {
    const an = window.__app.clock.bgmAnalyser, d = new Float32Array(an.fftSize); let m = 0;
    for (let k = 0; k < 20; k++) { an.getFloatTimeDomainData(d); for (const v of d) m = Math.max(m, Math.abs(v)); await new Promise((r) => setTimeout(r, 25)); }
    return m;
  });
  check(bgm > 0.01, 'BGM は鳴る', `peak ${bgm.toFixed(3)}`);
  // BGM・元動画の音声をミュートして、最終出力が無音のまま（成功・MISS・長押しでも鳴らない）
  await p.evaluate(() => { const c = window.__app.clock; c.setMute('bgm', true); c.setMute('voice', true); });
  const quiet = (label, fn) => p.evaluate(async ({ fn }) => {
    const a = window.__app, an = a.clock.outAnalyser, d = new Float32Array(an.fftSize);
    await new Promise((r) => setTimeout(r, 300)); // ミュートの切り替えが落ち着くまで
    let m = 0, judged0 = a.log.length;
    const stop = performance.now() + 3600;
    // eslint-disable-next-line no-new-func
    new Function('a', fn)(a);
    while (performance.now() < stop) { an.getFloatTimeDomainData(d); for (const v of d) m = Math.max(m, Math.abs(v)); await new Promise((r) => setTimeout(r, 10)); }
    return { peak: m, judged: a.log.length - judged0 };
  }, { fn }).then((r) => { check(r.peak < 1e-4 && r.judged > 0, `${label}: 判定があっても効果音は鳴らない（出力が無音）`, `peak ${r.peak.toExponential(1)}、判定 ${r.judged}`); });
  await p.evaluate(() => document.querySelector('#btnAuto').click());
  const H5 = await p.evaluate(() => { const n = window.__app.chart.notes.find((x) => x.button === 'Y' && x.duration >= 2), x = window.__app.chart.notes.find((k) => k.button === 'X'); return { y: n.time, x: x.time }; });
  await quiet('AUTO（息の長押しなど）', `a.seek(${H5.y - 0.4}); if (a.state !== 'playing') a.togglePlay();`);
  await p.evaluate(() => document.querySelector('#btnAuto').click());
  await quiet('手動（成功と MISS）', `a.seek(${H5.x - 0.4}); if (a.state !== 'playing') a.togglePlay(); const hit = () => { if (a.t >= ${H5.x}) { window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', key: 'x', bubbles: true })); setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyX', key: 'x', bubbles: true })), 50); } else requestAnimationFrame(hit); }; hit();`);
  // 編集のプレビュー
  await p.evaluate(() => window.__app.pause());
  await p.click('#btnEdit');
  const pv = await p.evaluate(async () => {
    const a = window.__app, e = a.editor, n = a.chart.notes.find((x) => x.button === 'Y');
    e.selected = new Set([n.id]); e.refresh(); e.tryEffect();
    const an = a.clock.outAnalyser, d = new Float32Array(an.fftSize); let m = 0;
    const stop = performance.now() + 1500;
    while (performance.now() < stop) { an.getFloatTimeDomainData(d); for (const v of d) m = Math.max(m, Math.abs(v)); await new Promise((r) => setTimeout(r, 10)); }
    return { peak: m, preview: !!e.preview || !!e.previewFx };
  });
  check(pv.preview && pv.peak < 1e-4, '編集のプレビューでも効果音は鳴らない', `peak ${pv.peak.toExponential(1)}`);
  const nodes = await p.evaluate(() => window.__nodes);
  check(nodes === 0 && !requests.some((u) => /sfx/.test(u)) && (await p.evaluate(() => window.__app.sfx === undefined && !('sfxBus' in window.__app.clock))),
    '効果音の生成・読み込み・再生の処理がない（音源を作らない・sfx を読み込まない）', `作った音源 ${nodes}`);
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await ctx.close();
}

await browser.close();
console.log(fails.length ? `\nNG ${fails.length} 件` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
