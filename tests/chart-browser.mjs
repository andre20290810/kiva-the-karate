// 公開版の初期設定（charts/seipai_v2.json、2026-10-21 採用の 59 ノーツ）の確認（実素材が必要）:
//   npm start（別ターミナル）→ node tests/chart-browser.mjs   （BASE=公開 URL でも可）
// - 新しいブラウザで 59 ノーツの設定が読み込まれる（時刻・長押し時間・エフェクト指定がファイルのまま）
// - AUTO で全編: 全ノーツが成功（同時入力・長押し中の別コマンドも）。各ノーツの人物のエフェクトが個別指定どおり
// - JSON の書き出し → 読み戻しで設定が変わらない。書き出しのファイル名に undefined が入らない
// - 既存の個人編集データは自動で消さず、「公開版の設定に切り替える」で切り替えられる（前の設定は控えに残る）
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const fails = [];
const check = (ok, msg, extra = '') => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}${extra ? ` ${extra}` : ''}`); if (!ok) fails.push(msg); };
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
const ready = (p) => p.waitForFunction(() => ['ready', 'paused', 'playing'].includes(window.__app?.state), null, { timeout: 120000 });

// ---------- 1. 新しいブラウザ: 59 ノーツ。AUTO で全編。JSON の往復 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(base); await ready(p);
  const r1 = await p.evaluate(async () => {
    const a = window.__app, { normalizeChart } = await import('/app/chart.js');
    const file = normalizeChart(await (await fetch('/charts/seipai_v2.json', { cache: 'no-store' })).json());
    return { src: a.chartSource, n: a.chart.notes.length, same: JSON.stringify(a.chart.notes) === JSON.stringify(file.notes) && JSON.stringify(a.chart.settings) === JSON.stringify(file.settings) && JSON.stringify(a.chart.display) === JSON.stringify(file.display),
      status: document.querySelector('#status').textContent, panel: !document.querySelector('#chartSrc').hidden };
  });
  check(r1.src === 'distributed' && r1.n === 59 && r1.same && /ノーツ 59/.test(r1.status) && !r1.panel, '新しいブラウザでは公開版の 59 ノーツ（ファイルのまま）で起動', r1.status);

  // AUTO で全編（時刻を 1/60 秒ずつ進め、通常と同じ判定・演出の処理を通す）
  await p.click('#btnAuto');
  const run = await p.evaluate(async () => {
    const a = window.__app, { resolveEffect } = await import('/app/effects-catalog.js');
    cancelAnimationFrame(a._raf); a.raf = () => {};
    const trig = [];
    const tr = a.fx.trigger.bind(a.fx);
    a.fx.trigger = (kind, o) => { trig.push({ kind, t: a.__T, fx: o.fx, dir: o.direction }); return tr(kind, o); };
    let T = -0.5; a.__T = T; a.clock.position = () => a.__T;
    a.seek(T); a.state = 'playing'; a.clock.state = 'playing';
    const maxHeld = { n: 0 };
    while (a.__T < a.duration - 0.05) {
      a.__T += 1 / 60; a.frame();
      const holding = a.judge.notes.filter((n) => n.holding).length; if (holding) maxHeld.n = Math.max(maxHeld.n, holding);
    }
    const res = a.judge.notes.map((n) => ({ id: n.id, result: n.result, time: n.time }));
    // 各ノーツのエフェクト: 判定の時刻に、そのノーツの指定を解決した値で出たか
    const notes = a.chart.notes, mism = [];
    for (const n of notes) {
      const want = resolveEffect(n), end = n.time + (n.duration || 0);
      const got = trig.find((g) => Math.abs(g.t - end) < 0.05 && g.kind === want.key && JSON.stringify(g.fx) === JSON.stringify(want));
      if (!got) mism.push(n.id);
    }
    return { res, mism, trig: trig.length, log: a.log.length, summary: a.judge.summary() };
  });
  const bad = run.res.filter((r) => r.result !== 'PERFECT');
  check(run.res.length === 59 && bad.length === 0, 'AUTO で全編: 59 ノーツすべて PERFECT', bad.map((b) => `${b.id}:${b.result}`).join(' '));
  const byId = Object.fromEntries(run.res.map((r) => [r.id, r.result]));
  check(byId.n065 === 'PERFECT' && byId.n066 === 'PERFECT', '同時入力（44.83 秒 構 n065 と 息 n066）が両方成功');
  check(['n061', 'n086', 'n064', 'n015', 'n071', 'n081', 'n083', 'n073'].every((id) => byId[id] === 'PERFECT'), '息の長押し中の別コマンド（30.04・36.4・64.3・71.64 秒など）も長押しも成功');
  check(run.mism.length === 0 && run.trig === 59, '各ノーツの人物のエフェクトが個別指定どおり（番号・発生位置・角度・位置調整・強さ）', run.mism.join(' '));
  // 代表的な個別指定の値
  const fx = await p.evaluate(async () => {
    const { resolveEffect } = await import('/app/effects-catalog.js'), a = window.__app, g = (id) => resolveEffect(a.chart.notes.find((n) => n.id === id));
    return { n075: g('n075'), n035: g('n035'), n008: g('n008'), n049: g('n049') };
  });
  check(fx.n075.key === 'strike' && fx.n075.angle === 90 && fx.n075.offset.x === 0.11 && fx.n075.offset.y === 0.18 && fx.n035.intensity === 0.2 && fx.n035.angle === 180 && fx.n035.offset.y === -0.2
    && Math.abs(fx.n008.direction.x - 0.044 / Math.hypot(0.044, 0.999)) < 1e-9 && fx.n049.key === 'breath',
  '個別指定の値（n075 角度 90・位置調整、n035 強さ 0.2、従来形式 n008 の向きはベクトルのまま、息は No.1）');

  // JSON の書き出し → 読み戻し
  await p.evaluate(() => { const a = window.__app; a.state = 'paused'; });
  await p.click('#btnEdit');
  const names = [];
  await p.exposeFunction('__dl', (n) => names.push(n));
  await p.evaluate(() => { const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dl(this.download); return orig.call(this); }; });
  await p.click('[data-act=export]');
  const rt = await p.evaluate(async () => {
    const a = window.__app, text = window.__lastExport, { normalizeChart } = await import('/app/chart.js');
    const before = JSON.stringify(normalizeChart(a.chart));
    const ok = a.editor.importText(text, 'roundtrip.json');
    return { ok, same: JSON.stringify(normalizeChart(a.chart)) === before, sameFile: JSON.stringify(normalizeChart(JSON.parse(text)).notes) === JSON.stringify(a.initialChart.notes) };
  });
  check(rt.ok && rt.same && rt.sameFile, 'JSON の書き出し → 読み戻しで設定が変わらない');
  check(names.length === 1 && /^seipai-v2-chart-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(names[0]) && !/undefined/.test(names[0]), '書き出しのファイル名に undefined が入らない', names[0]);
  // 配布時の初期設定に戻す
  p.on('dialog', (d) => d.accept());
  await p.evaluate(() => { const n = window.__app.chart.notes[0]; window.__app.editor.apply((c) => { c.notes.find((x) => x.id === n.id).time += 0.5; }, 'テスト'); });
  await p.click('[data-act=reset]');
  check(await p.evaluate(() => JSON.stringify(window.__app.chart.notes) === JSON.stringify(window.__app.initialChart.notes)), '「配布時の初期設定に戻す」で公開版の 59 ノーツに戻る');
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await ctx.close();
}

// ---------- 2. 既存の個人編集データ: 自動では消さず、切り替えられる ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.goto(base); await ready(p);
  // 前の公開版で作った個人の設定（下書きとデフォルト、公開版の指紋の記録なし）
  await p.evaluate(async () => {
    const { exportChart } = await import('/app/chart.js');
    const c = structuredClone(window.__app.initialChart);
    c.notes = c.notes.slice(0, 40); c.notes[0].label = '自分の編集';
    localStorage.setItem('kiva2d.v2.chart.default', exportChart(c));
    c.notes[1].label = '下書き';
    localStorage.setItem('kiva2d.v2.chart.autosave', exportChart(c));
  });
  await p.goto(base); await ready(p);
  let s = await p.evaluate(() => ({ src: window.__app.chartSource, n: window.__app.chart.notes.length, status: document.querySelector('#status').textContent, panel: !document.querySelector('#chartSrc').hidden, text: document.querySelector('#chartSrcText').textContent }));
  check(s.src === 'draft' && s.n === 40 && /更新されています/.test(s.status) && s.panel && /更新されています/.test(s.text), '既存の個人データはそのまま使い、公開版の更新を知らせる', s.status);
  await p.click('#more summary');
  await p.click('#btnUseDistributed');
  s = await p.evaluate(() => ({ src: window.__app.chartSource, n: window.__app.chart.notes.length, draft: localStorage.getItem('kiva2d.v2.chart.autosave'), def: localStorage.getItem('kiva2d.v2.chart.default'),
    backup: JSON.parse(localStorage.getItem('kiva2d.v2.chart.backup') || 'null'), panel: !document.querySelector('#chartSrc').hidden }));
  check(s.src === 'distributed' && s.n === 59 && !s.draft && !s.def && !s.panel, '「公開版の設定に切り替える」で 59 ノーツに切り替わる');
  check(s.backup && JSON.parse(s.backup.draft).notes.length === 40 && JSON.parse(s.backup.deviceDefault).notes[0].label === '自分の編集', '前の下書き・デフォルトは控えとして残る');
  await p.goto(base); await ready(p);
  s = await p.evaluate(() => ({ src: window.__app.chartSource, n: window.__app.chart.notes.length }));
  check(s.src === 'distributed' && s.n === 59, '再読み込み後も公開版の設定');
  // 新しい公開版の後に保存した設定では「更新」を知らせない
  await p.click('#btnEdit');
  await p.evaluate(() => { const a = window.__app; a.editor.apply((c) => { c.notes[0].label = '新しい編集'; }, 'テスト'); a.editor.saveDefault(); });
  await p.goto(base); await ready(p);
  s = await p.evaluate(() => ({ src: window.__app.chartSource, status: document.querySelector('#status').textContent }));
  check(s.src === 'default' && !/更新されています/.test(s.status), '公開版の更新後に保存した設定では更新の知らせを出さない', s.status);
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await ctx.close();
}

await browser.close();
console.log(fails.length ? `\nNG ${fails.length} 件` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
