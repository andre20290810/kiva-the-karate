// ブラウザでの確認（実素材が必要）: npm start（別ターミナル）→ node tests/game2d-browser.mjs [撮影先]
// 完了条件のうち、画面とプレイに関わるものを実際に操作して確かめる。スクリーンショットを撮影先に保存する。
import { mkdirSync, readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const out = process.argv[2] || 'test-results/game2d';
mkdirSync(out, { recursive: true });
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}`); if (!ok) fails.push(msg); };
const VIEWS = { '390x844': { width: 390, height: 844 }, '844x390': { width: 844, height: 390 }, '1366x768': { width: 1366, height: 768 } };

async function open(viewport, q = '?fresh=1') {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true, hasTouch: viewport.width < 900 });
  const p = await ctx.newPage();
  const errors = [], requests = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  p.on('request', (r) => requests.push(r.url()));
  await p.goto(base + q);
  await p.waitForFunction(() => ['ready', 'error'].includes(document.documentElement.dataset.state), null, { timeout: 90000 });
  return { ctx, p, errors, requests };
}

/** ページ内で、時間軸の時刻 t ちょうどにキーを押す／離す（Playwright の往復遅延を判定に混ぜない） */
const keyAt = (p, code, t, type = 'keydown') => p.evaluate(([code, t, type]) => new Promise((res) => {
  const tick = () => {
    if (window.__app.t >= t) { window.dispatchEvent(new KeyboardEvent(type, { code, key: code.slice(3).toLowerCase(), bubbles: true })); res(window.__app.t); }
    else setTimeout(tick, 1);
  };
  tick();
}), [code, t, type]);

// ---------- 1. 3 つの画面サイズ: 背景・配置・ボタン ----------
for (const [name, vp] of Object.entries(VIEWS)) {
  const { ctx, p, errors, requests } = await open(vp);
  const st = await p.evaluate(() => document.documentElement.dataset.state);
  check(st === 'ready', `${name}: 読み込み完了（${st}）`);
  await p.click('#btnPlay');
  await p.waitForTimeout(300);
  await p.evaluate(() => window.__app.seek(15.0));
  await p.waitForTimeout(700);
  const d = await p.evaluate(() => {
    const D = window.__debug;
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && r.width > 30 && r.height > 30; };
    return {
      orient: D.orient, bg: D.bg, bgDraw: D.bgDraw, lanes: D.lanes, cssW: window.__app.cssW, cssH: window.__app.cssH,
      vis: (() => { const a = window.__app, G = a.geometry(), hs = []; for (let i = 0; i < a.store.count; i++) hs.push(a.visibleBox(i, G).h / a.cssH); hs.sort((x, y) => x - y); return hs[hs.length >> 1]; })(), subject: D.subject, anchor: D.anchor,
      img: window.__app.bgImages[D.orient === 'landscape' ? 0 : 1].src.split('/').pop(),
      pads: [...document.querySelectorAll('#pad [data-b]')].map(vis),
      transport: ['#btnPlay', '#btnRetry', '#btnAuto', '#btnEdit'].map((s) => vis(document.querySelector(s))),
    };
  });
  const expect = vp.width >= vp.height ? 'IMG_7441.JPG' : 'IMG_7439.JPG';
  check(d.img === expect, `${name}: 背景 ${d.img}（期待 ${expect}）`);
  check(d.pads.every(Boolean), `${name}: Y/X/A/B ボタンが画面内に全部見える ${JSON.stringify(d.pads)}`);
  check(d.transport.every(Boolean), `${name}: 再生・リトライ・AUTO・編集が見える ${JSON.stringify(d.transport)}`);
  if (d.orient === 'portrait') {
    const cx = d.bg.x + d.bg.w / 2, cy = d.bg.y + d.bg.h / 2;
    check(Math.abs(d.anchor[0] - cx) < 0.5 && Math.abs(d.anchor[1] - cy) < 0.5, `${name}: 胴体の中心が背景の中央 (${d.anchor.map((v) => v.toFixed(1))}) vs (${cx.toFixed(1)}, ${cy.toFixed(1)})`);
  } else {
    const g = d.bgDraw;
    check(g.x <= 0.5 && g.y <= 0.5 && g.x + g.w >= d.cssW - 0.5 && g.y + g.h >= d.cssH - 0.5, `${name}: 横向きの背景が表示領域を余白なく埋める ${JSON.stringify(g)}`);
    check(Math.abs(d.anchor[0] - d.cssW / 2) < 0.5, `${name}: 人物は左右の中央`);
    check(d.vis >= 0.7 && d.vis <= 0.85, `${name}: 人物の見える高さ（412 コマの中央値）が表示領域の 70〜85%（${(d.vis * 100).toFixed(1)}%）`);
    // 表示順: 背景 → レーンの背景・枠 → 人物 → ノーツ・判定線（人物の頭がレーンの面に隠れない）
    const order = await p.evaluate(() => {
      const a = window.__app, seq = [], ctx = a.ctx;
      const back = a.lanes.drawBack, front = a.lanes.draw, di = ctx.drawImage;
      a.lanes.drawBack = function (...x) { seq.push('laneBack'); return back.apply(this, x); };
      a.lanes.draw = function (...x) { seq.push('laneFront'); return front.apply(this, x); };
      ctx.drawImage = function (img, ...x) { seq.push(img === a.bgImages[0] || img === a.bgImages[1] ? 'bg' : 'image'); return di.call(this, img, ...x); };
      a.draw(a.t);
      a.lanes.drawBack = back; a.lanes.draw = front; ctx.drawImage = di;
      return seq.filter((v, i) => v !== seq[i - 1]).join(' → ');
    });
    check(/^bg → laneBack → image( → image)* → laneFront/.test(order), `${name}: 表示順 ${order}`);
  }
  check(d.lanes.y >= d.bg.y && d.lanes.y + d.lanes.h <= d.bg.y + d.bg.h * 0.35, `${name}: 4 レーンが背景の上部`);
  await p.screenshot({ path: `${out}/layout_${name}.png` });
  check(!requests.some((u) => /\.glb|three|vendor\/|\/src\//i.test(u)), `${name}: 旧 3D の素材・コードを読み込まない`);
  check(errors.length === 0, `${name}: ページエラーなし ${errors.slice(0, 2).join(' | ')}`);
  await ctx.close();
}

// ---------- 2. 旧設定が残っていても 3D に戻らない ----------
{
  const ctx = await browser.newContext({ viewport: VIEWS['1366x768'] });
  await ctx.addInitScript(() => { try { localStorage.setItem('kiva.quality', 'CINEMATIC'); localStorage.setItem('kiva.displayMode', 'kiva-3d'); } catch { /* */ } });
  const p = await ctx.newPage();
  const req = [];
  p.on('request', (r) => req.push(r.url()));
  await p.goto(base + '?fresh=1&mode=kiva-3d&view=3d');
  await p.waitForFunction(() => document.documentElement.dataset.state === 'ready', null, { timeout: 90000 });
  const r = await p.evaluate(() => ({ sel: !!document.querySelector('#displayMode, [data-mode=three]'), q: localStorage.getItem('kiva.quality') }));
  check(!r.sel && r.q === null, '旧設定（kiva.quality など）を消し、3D の切替 UI が無い');
  check(!req.some((u) => /\.glb|three/i.test(u)), '旧 URL パラメータでも 3D 素材を要求しない');
  await ctx.close();
}

// ---------- 3. 全コマの通し再生（AUTO、等速）: 全コマを順番どおり表示・取りこぼし／二重判定なし ----------
{
  const { ctx, p, errors } = await open(VIEWS['1366x768']);
  // 描画ごとに表示したコマを記録（ページ内で数える）
  await p.evaluate(() => { window.__shown = []; const f = () => { const d = window.__debug; if (d && d.shown != null && window.__app.state === 'playing') window.__shown.push(d.shown); requestAnimationFrame(f); }; requestAnimationFrame(f); });
  await p.click('#btnAuto');
  await p.click('#btnPlay');
  // 等速（1×）で通し再生
  await p.waitForFunction(() => window.__app.state === 'ended', null, { timeout: 120000, polling: 500 });
  const r = await p.evaluate(() => window.__lastResult);
  const shown = await p.evaluate(() => window.__shown);
  const total = JSON.parse(readFileSync(new URL('../charts/seipai.json', import.meta.url))).notes.length;
  check(r && r.auto === true, 'AUTO の記録として区別される');
  check(r && r.perfect === total && r.miss === 0 && r.judged === total, `AUTO 全編: PERFECT ${r?.perfect}/${total}、MISS ${r?.miss}`);
  const ids = r.log.map((x) => x.id);
  check(new Set(ids).size === ids.length && ids.length === total, `二重判定なし（判定 ${ids.length} 回、ノーツ ${total}）`);
  const uniq = new Set(shown);
  let back = 0;
  for (let k = 1; k < shown.length; k++) if (shown[k] < shown[k - 1]) back++;
  const nFrames = await p.evaluate(() => window.__app.store.count);
  const missing = [...Array(nFrames).keys()].filter((i) => !uniq.has(i));
  check(uniq.size === nFrames && back === 0, `${nFrames} 枚すべてを順番どおりに表示（${uniq.size} 種、逆行 ${back} 回${missing.length ? `、未表示 ${missing.slice(0, 5)}` : ''}）`);
  await p.screenshot({ path: `${out}/auto_end.png` });
  check(errors.length === 0, `AUTO 通し: ページエラーなし ${errors.slice(0, 2).join(' | ')}`);
  // フレーム落ち: 描画を 250ms ずつ止めながら AUTO で 20〜45 秒を再生しても取りこぼさない
  await p.click('#btnRetry');
  await p.evaluate(() => window.__app.seek(20));
  const jank = setInterval(() => p.evaluate(() => { const t = performance.now(); while (performance.now() - t < 250); }).catch(() => {}), 400);
  await p.waitForFunction(() => window.__app.t > 45, null, { timeout: 60000, polling: 300 });
  clearInterval(jank);
  const j = await p.evaluate(() => { const ns = window.__app.judge.notes.filter((n) => n.time >= 20 && n.time < 44.8); return { n: ns.length, ok: ns.filter((n) => n.result === 'PERFECT').length }; });
  check(j.n > 5 && j.ok === j.n, `描画が止まっても判定時刻をまたいだノーツを取りこぼさない（${j.ok}/${j.n}）`);
  await ctx.close();
}

// ---------- 4. 手動: Y 長押し・早すぎる離し・X・A 2 回・自動リピート無視 ----------
{
  const { ctx, p } = await open(VIEWS['1366x768']);
  const notes = JSON.parse(readFileSync(new URL('../charts/seipai.json', import.meta.url))).notes;
  const y1 = notes.find((n) => n.button === 'Y');
  await p.click('#btnPlay');
  await p.evaluate((t) => window.__app.seek(t), y1.time - 1.0);
  await keyAt(p, 'KeyY', y1.time + 0.02);
  // 長押しの途中で一時停止（実時間を足さない）→ 再開
  await p.waitForFunction((t) => window.__app.t > t, y1.time + 0.8);
  await p.evaluate(() => window.__app.pause());
  const tp = await p.evaluate(() => window.__app.t);
  await p.waitForTimeout(1500);
  const holdMid = await p.evaluate((id) => { const n = window.__app.judge.byId.get(id); return { holding: n.holding, result: n.result, t: window.__app.t }; }, y1.id);
  check(holdMid.holding && !holdMid.result && Math.abs(holdMid.t - tp) < 1e-6, `一時停止中は長押しが進まない（時刻 ${tp.toFixed(2)} のまま、保持中）`);
  await p.evaluate(() => window.__app.play());
  await p.waitForFunction((t) => window.__app.t > t, y1.time + y1.duration + 0.05);
  await keyAt(p, 'KeyY', 0, 'keyup');
  const yRes = await p.evaluate((id) => window.__app.judge.byId.get(id).result, y1.id);
  check(yRes === 'PERFECT', `Y 長押しを最後まで保持 → ${yRes}`);
  // 早すぎる離し
  await p.evaluate((t) => window.__app.seek(t), y1.time - 0.8);
  await keyAt(p, 'KeyY', y1.time);
  await keyAt(p, 'KeyY', y1.time + 0.5, 'keyup');
  const yEarly = await p.evaluate((id) => { const n = window.__app.judge.byId.get(id); return `${n.result}/${n.reason}`; }, y1.id);
  check(yEarly === 'MISS/early-release', `Y を早く離す → ${yEarly}`);
  // A を 2 回（別々の時刻の 2 個のノーツ）
  const aa = notes.filter((n) => n.button === 'A');
  const pair = aa.find((n, i) => aa[i + 1] && aa[i + 1].time - n.time < 1);
  const pair2 = aa[aa.indexOf(pair) + 1];
  await p.evaluate((t) => window.__app.seek(t), pair.time - 0.8);
  await keyAt(p, 'KeyA', pair.time);
  // 押したまま自動リピート（repeat:true）を送っても 2 回目にならない
  await p.evaluate(() => { for (let k = 0; k < 5; k++) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', repeat: true, bubbles: true })); });
  const afterRepeat = await p.evaluate((id) => window.__app.judge.byId.get(id).result, pair2.id);
  check(afterRepeat === null, '押しっぱなしの自動リピートでは次の A が成立しない');
  await keyAt(p, 'KeyA', pair.time + 0.1, 'keyup');
  await keyAt(p, 'KeyA', pair2.time);
  await keyAt(p, 'KeyA', pair2.time + 0.1, 'keyup');
  const ab = await p.evaluate(([a, b]) => [a, b].map((id) => window.__app.judge.byId.get(id).result), [pair.id, pair2.id]);
  check(ab.every((r) => r === 'PERFECT' || r === 'GOOD'), `A 2 回が 2 つのノーツとして判定（${pair.time}s, ${pair2.time}s → ${ab}）`);
  // 画面ボタン（タッチとクリックが二重にならない）
  const xn = notes.find((n) => n.button === 'X' && n.time > 30);
  await p.evaluate((t) => window.__app.seek(t), xn.time - 0.6);
  await p.waitForFunction((t) => window.__app.t >= t, xn.time - 0.02);
  const before = await p.evaluate(() => window.__app.judge.summary().judged);
  await p.click('#pad [data-b=X]');
  const after = await p.evaluate(() => window.__app.judge.summary().judged);
  check(after - before === 1, `画面の X ボタン 1 回で判定 1 回（${after - before}）`);
  // 編集用の入力欄にフォーカスがある間は Y/X/A/B を操作として扱わない
  await p.click('#btnEdit');
  await p.evaluate(() => document.querySelector('#edShift').focus());
  const s0 = await p.evaluate(() => window.__app.judge.stray + window.__app.judge.summary().judged);
  await p.keyboard.type('YXAB');
  const s1 = await p.evaluate(() => window.__app.judge.stray + window.__app.judge.summary().judged);
  check(s0 === s1, '入力欄にフォーカス中はキーがゲーム操作にならない');
  await ctx.close();
}

// ---------- 5. シーク・ループ・速度変更・一時停止・回転 ----------
{
  const { ctx, p } = await open(VIEWS['844x390']);
  await p.click('#btnAuto');
  await p.click('#btnPlay');
  await p.evaluate(() => { const a = window.__app; a.loop = { a: 20.5, b: 23.0, on: true }; a.seek(20.5); });
  const counts = [];
  for (let k = 0; k < 3; k++) {
    await p.waitForFunction(() => window.__app.t > 22.9, null, { timeout: 15000 });
    counts.push(await p.evaluate(() => window.__app.judge.summary().perfect));
    await p.waitForFunction(() => window.__app.t < 21.5, null, { timeout: 15000 });
  }
  check(counts.every((c) => c === counts[0]) && counts[0] >= 2, `A–B ループを繰り返しても同じノーツを二重に加点しない（各周の PERFECT ${counts}）`);
  await p.evaluate(() => { window.__app.loop.on = false; });
  // 速度 0.5×
  await p.evaluate(() => window.__app.setRate(0.5));
  const a1 = await p.evaluate(() => [window.__app.t, performance.now()]);
  await p.waitForTimeout(1000);
  const a2 = await p.evaluate(() => [window.__app.t, performance.now()]);
  const rate = (a2[0] - a1[0]) / ((a2[1] - a1[1]) / 1000);
  check(Math.abs(rate - 0.5) < 0.05, `0.5× で時間軸が 0.5 倍で進む（${rate.toFixed(3)}）`);
  const fr = await p.evaluate(() => [window.__debug.frame, window.__app.store.indexAt(window.__app.t)]);
  check(fr[0] === fr[1], `表示コマ = 時間軸のコマ（${fr}）`);
  await p.evaluate(() => window.__app.setRate(1));
  // 回転（横 → 縦）: 時刻・AUTO・譜面を失わない
  const beforeRot = await p.evaluate(() => ({ t: window.__app.t, auto: window.__app.autoMode, n: window.__app.chart.notes.length, st: window.__app.state }));
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(600);
  const afterRot = await p.evaluate(() => ({ t: window.__app.t, auto: window.__app.autoMode, n: window.__app.chart.notes.length, st: window.__app.state, orient: window.__debug.orient }));
  check(afterRot.orient === 'portrait' && afterRot.auto && afterRot.n === beforeRot.n && afterRot.st === 'playing' && afterRot.t > beforeRot.t, `回転しても再生・AUTO・譜面が続く（${beforeRot.t.toFixed(2)} → ${afterRot.t.toFixed(2)}）`);
  await p.screenshot({ path: `${out}/rotated_portrait.png` });
  // 一時停止 → 再開で時刻が飛ばない
  await p.evaluate(() => window.__app.pause());
  const tp = await p.evaluate(() => window.__app.t);
  await p.waitForTimeout(800);
  const tp2 = await p.evaluate(() => window.__app.t);
  await p.evaluate(() => window.__app.play());
  await p.waitForTimeout(150);
  const tp3 = await p.evaluate(() => window.__app.t);
  check(tp === tp2 && tp3 >= tp && tp3 - tp < 0.4, `一時停止中は止まり、再開で続きから（${tp.toFixed(3)} → ${tp3.toFixed(3)}）`);
  // シーク後にエフェクトが残らない
  await p.evaluate(() => window.__app.seek(40));
  await p.waitForTimeout(50);
  const fx = await p.evaluate(() => window.__app.fx.list.length);
  check(fx === 0, `シークで過去のエフェクトを消す（${fx}）`);
  await ctx.close();
}

// ---------- 6. 編集: 時刻変更・追加・削除・長押し時間・JSON 書き出し → 開き直す → 読み込み ----------
{
  const { ctx, p } = await open(VIEWS['1366x768']);
  await p.click('#btnEdit');
  await p.evaluate(() => window.__app.seek(30.0));
  await p.click('#editor [data-add=A]');
  await p.waitForSelector('#nTime');
  const added = await p.evaluate(() => [...window.__app.editor.selected][0]);
  await p.fill('#nTime', '30.37');
  await p.dispatchEvent('#nTime', 'change');
  await p.selectOption('#nAction', 'kick');
  const yId = await p.evaluate(() => window.__app.chart.notes.find((n) => n.button === 'Y').id);
  await p.evaluate((id) => { window.__app.editor.selected = new Set([id]); window.__app.editor.refresh(); }, yId);
  await p.fill('#nDur', '3.1');
  await p.dispatchEvent('#nDur', 'change');
  const delId = await p.evaluate(() => window.__app.chart.notes.find((n) => n.button === 'B').id);
  await p.evaluate((id) => { window.__app.editor.selected = new Set([id]); window.__app.editor.act('del'); }, delId);
  await p.evaluate(() => window.__app.seek(50.0));
  await p.waitForFunction(() => /コマ 250/.test(document.querySelector('#edFrameBody').textContent));
  await p.fill('#fDx', '0.02'); await p.fill('#fSc', '1.05');
  await p.click('#edFrameBody [data-f=apply]');
  const st1 = await p.evaluate(([a, y, d]) => {
    const c = window.__app.chart;
    return { a: c.notes.find((n) => n.id === a), y: c.notes.find((n) => n.id === y).duration, del: c.notes.some((n) => n.id === d), ov: c.display.frameOverrides[250], n: c.notes.length };
  }, [added, yId, delId]);
  check(st1.a?.time === 30.37 && st1.a.action === "kick" && st1.y === 3.1 && !st1.del && st1.ov?.scale === 1.05, `編集が反映（追加 A 30.37s 蹴り、Y 3.1 秒、B 削除、コマ 250 の補正）${JSON.stringify(st1).slice(0, 300)}`);
  // Undo / Redo
  await p.evaluate(() => window.__app.editor.undo());
  const undone = await p.evaluate(() => !window.__app.chart.display.frameOverrides[250]);
  await p.evaluate(() => window.__app.editor.redo());
  const redone = await p.evaluate(() => window.__app.chart.display.frameOverrides[250]?.scale === 1.05);
  check(undone && redone, '元に戻す／やり直す');
  await p.screenshot({ path: `${out}/editor_1366.png` });
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#editor [data-act=export]')]);
  const file = `${out}/exported.json`;
  await dl.saveAs(file);
  const exported = readFileSync(file, 'utf8');
  // 自動保存を消して開き直す（初期譜面に戻る）→ ファイルを読み込む
  await p.evaluate(() => localStorage.clear());
  await p.goto(base + '?fresh=1');
  await p.waitForFunction(() => document.documentElement.dataset.state === 'ready', null, { timeout: 90000 });
  const fresh = await p.evaluate(() => window.__app.chart.notes.length);
  await p.click('#btnEdit');
  await p.setInputFiles('#edImport', file);
  await p.waitForTimeout(300);
  const st2 = await p.evaluate(([a, y]) => {
    const c = window.__app.chart;
    return { a: c.notes.find((n) => n.id === a)?.time, y: c.notes.find((n) => n.id === y).duration, ov: c.display.frameOverrides[250], n: c.notes.length };
  }, [added, yId]);
  void fresh;
  check(st2.a === 30.37 && st2.y === 3.1 && st2.ov?.scale === 1.05 && st2.n === st1.n, `JSON の読み込みで編集結果を再現（ノーツ ${st2.n}）`);
  const [dl2] = await Promise.all([p.waitForEvent('download'), p.click('#editor [data-act=export]')]);
  await dl2.saveAs(`${out}/reexported.json`);
  check(readFileSync(`${out}/reexported.json`, 'utf8') === exported, '書き出し → 読み込み → 再書き出しで内容が一致');
  // 不正な JSON は読み込まず、今の編集内容を壊さない
  const bad = await p.evaluate(() => { const before = JSON.stringify(window.__app.chart); const ok = window.__app.editor.importText('{"schemaVersion": 1, "notes": [{"id":"x"}]}'); return { ok, same: before === JSON.stringify(window.__app.chart), msg: document.querySelector('#edMsg').textContent }; });
  check(!bad.ok && bad.same && /読み込めません/.test(bad.msg), `不正な JSON はメッセージを出して拒否（${bad.msg.slice(0, 40)}…）`);
  // 自動保存 → 開き直すと復元
  await p.waitForTimeout(500);
  await p.goto(base);
  await p.waitForFunction(() => document.documentElement.dataset.state === 'ready', null, { timeout: 90000 });
  const restored = await p.evaluate((a) => window.__app.chart.notes.some((n) => n.id === a), added);
  check(restored, '自動保存した編集内容を開き直しても復元');
  await p.click('#btnEdit');
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${out}/editor_390.png` });
  await p.evaluate(() => localStorage.clear());
  await ctx.close();
}

// ---------- 6b. 補正の入力中にコマが変わっても値が消えない（通常の操作: クリックとキー入力だけ） ----------
{
  const { ctx, p } = await open(VIEWS['1366x768']);
  await p.click('#btnEdit');
  await p.evaluate(() => window.__app.seek(40.0));
  await p.waitForFunction(() => /コマ 200/.test(document.querySelector('#edFrameBody').textContent));
  // 編集パネルの ▶ で再生してから、補正欄をクリックして入力する
  await p.click('#edPlay');
  await p.waitForTimeout(300);
  await p.click('#fDx', { clickCount: 3 });
  await p.keyboard.type('0.03');
  const target = await p.evaluate(() => window.__app.store.indexAt(window.__app.t));
  const st1 = await p.evaluate(() => window.__app.state);
  // 他の場所を操作してコマを進める（入力欄からフォーカスが外れる）
  await p.click('#editor [data-act=nextF]');
  await p.click('#editor [data-act=nextF]');
  await p.click('#edPlay');           // 再生（背景でコマが変わり続ける）
  await p.waitForTimeout(1200);
  await p.click('#edPlay');           // 停止
  const shown = await p.evaluate(() => window.__app.store.indexAt(window.__app.t));
  const kept = await p.inputValue('#fDx');
  check(st1 === 'paused', `補正欄の編集を始めると再生が一時停止する（${st1}）`);
  check(kept === '0.03' && shown !== target, `入力中の値がコマの移動・再生で消えない（表示コマ ${shown}、入力値 ${kept}）`);
  await p.click('#fSc', { clickCount: 3 });
  await p.keyboard.type('1.08');
  await p.click('#edFrameBody [data-f=apply]');
  const ov = await p.evaluate(() => window.__app.chart.display.frameOverrides);
  check(ov[target]?.dx === 0.03 && ov[target]?.scale === 1.08 && !ov[shown], `適用は入力を始めたコマ ${target} に入る（${JSON.stringify(ov)}）`);
  // 取り消し
  await p.click('#fDy', { clickCount: 3 });
  await p.keyboard.type('0.02');
  await p.click('#edFrameBody [data-f=cancel]');
  const after = await p.evaluate(() => ({ n: Object.keys(window.__app.chart.display.frameOverrides).length, dy: document.querySelector('#fDy').value }));
  check(after.n === 1 && Number(after.dy) === 0, `未適用の補正を取り消せる（${JSON.stringify(after)}）`);
  await p.evaluate(() => localStorage.clear());
  await ctx.close();
}

// ---------- 7. リトライを繰り返してもメモリ（デコード済み画像・エフェクト）が増え続けない ----------
{
  const { ctx, p } = await open(VIEWS['390x844']);
  await p.click('#btnAuto');
  const sizes = [];
  for (let k = 0; k < 6; k++) {
    await p.click('#btnRetry');
    await p.evaluate((t) => window.__app.seek(t), 10 + k * 11);
    await p.waitForTimeout(700);
    sizes.push(await p.evaluate(() => ({ dec: window.__app.store.bitmaps.size, fx: window.__app.fx.list.length, cache: window.__app.fx.sil.size })));
  }
  check(sizes.every((s) => s.dec <= 48 && s.fx <= 24 && s.cache <= 24), `デコード済み画像・エフェクト・シルエットのキャッシュが上限内 ${JSON.stringify(sizes.at(-1))}`);
  await ctx.close();
}

await browser.close();
console.log(fails.length ? `\n${fails.length} 件 NG` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
