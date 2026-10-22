// 編集・成績・設定の横幅の確認（実素材が必要）: npm start（別ターミナル）→ node tests/widths-browser.mjs（BASE=公開 URL でも可）
// - 成績（ダイアログ）と設定（⚙ のパネル）の左右の端が、編集画面（操作パネルの内側）と同じ（スマホ縦・横・PC。セーフエリアを含む）
// - 成績のグラフ・照合タイムライン・カード、設定の項目が広がった幅を使う（文字の大きさは同じ）
// - ページ全体の横スクロールなし（照合タイムラインとカードの列だけが横スクロール）。文字の重なり・欠けなし
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const fails = [];
const check = (ok, msg, extra = '') => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}${extra ? ` ${extra}` : ''}`); if (!ok) fails.push(msg); };
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}) });
const ready = (p) => p.waitForFunction(() => ['ready', 'paused', 'playing'].includes(window.__app?.state), null, { timeout: 120000 });

/** 決まった入力で最後まで進めて成績を出す（音声なし・コマ送り） */
const play = (p) => p.evaluate(() => {
  const a = window.__app;
  cancelAnimationFrame(a._raf); a.raf = () => {};
  a.__T = -1; a.clock.position = () => a.__T;
  a.startSession(-1); a.clock.stop(-1); a.newJudge(-1); a.state = 'playing'; a.clock.state = 'playing';
  const plan = [];
  a.chart.notes.forEach((n, i) => {
    if (i % 9 === 4) return;
    const d = ((i * 37) % 140 - 70) / 1000;
    plan.push({ t: n.time + d, b: n.button, down: true });
    plan.push({ t: n.input === 'hold' ? n.time + n.duration + 0.1 : n.time + d + 0.08, b: n.button, down: false });
  });
  plan.push({ t: 33, b: 'A', down: true }, { t: 33.05, b: 'A', down: false });
  plan.sort((x, y) => x.t - y.t);
  let k = 0, seq = 0;
  while (a.__T < a.duration && a.state !== 'ended') {
    a.__T = Math.min(a.duration, a.__T + 1 / 30);
    while (k < plan.length && plan[k].t <= a.__T) {
      const e = plan[k++], save = a.__T; a.__T = e.t;
      if (e.down) a.onPress(e.b, 0, { id: `w${++seq}`, source: 'key', device: 'keyboard' }); else a.onRelease(e.b, 0, { source: 'key', device: 'keyboard' });
      a.__T = save;
    }
    a.frame();
  }
  return a.state;
});

const VIEWS = [
  ['PC 1280x800', { width: 1280, height: 800 }, null],
  ['PC 1680x1000', { width: 1680, height: 1000 }, null],
  ['スマホ縦 393x852', { width: 393, height: 852 }, null],
  ['スマホ横 852x393（セーフエリア 左右 47px を想定）', { width: 852, height: 393 }, { l: 47, r: 47 }],
];
for (const [label, vp, safe] of VIEWS) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}?fresh=1`); await ready(p);
  if (safe) await p.evaluate((s) => { const r = document.documentElement.style; r.setProperty('--safe-l', `${s.l}px`); r.setProperty('--safe-r', `${s.r}px`); }, safe);
  const edges = (sel) => p.evaluate((q) => { const r = document.querySelector(q).getBoundingClientRect(); return { l: Math.round(r.left * 10) / 10, r: Math.round((window.innerWidth - r.right) * 10) / 10, w: r.width }; }, sel);
  const pageOver = () => p.evaluate(() => Math.max(document.scrollingElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);

  // 編集画面
  await p.evaluate(() => window.__app.setEdit(true));
  await p.waitForTimeout(300);
  const ed = await edges('#editor');
  const edOver = await pageOver();
  await p.evaluate(() => window.__app.setEdit(false));
  // 設定
  await p.evaluate(() => { document.querySelector('#more').open = true; });
  await p.waitForTimeout(300);
  const st = await edges('#more .settings');
  const stIn = await p.evaluate(() => {
    const s = document.querySelector('#more .settings'), R = s.getBoundingClientRect();
    const out = [...s.querySelectorAll('label, p, legend, button, input, select, .mixrow, fieldset')].filter((e) => e.offsetParent && (e.getBoundingClientRect().right > R.right + 0.5 || e.getBoundingClientRect().left < R.left - 0.5)).map((e) => e.id || e.tagName);
    const cols = new Set([...s.children].filter((c) => c.offsetParent).map((c) => Math.round(c.getBoundingClientRect().left))).size;
    const range = document.querySelector('#fxStrength').getBoundingClientRect().width;
    const fs = getComputedStyle(document.querySelector('#more .settings label')).fontSize;
    return { out, cols, range, fs, scroll: s.scrollWidth - s.clientWidth };
  });
  const stOver = await pageOver();
  await p.evaluate(() => { document.querySelector('#more').open = false; });
  // 成績
  const state = await play(p);
  await p.waitForTimeout(500);
  const rs = await edges('#result .card.results');
  const res = {};
  for (const tab of ['summary', 'timing', 'detail', 'compare', 'history']) {
    await p.click(`[data-tab=${tab}]`);
    await p.waitForTimeout(tab === 'detail' ? 1200 : 300);
    res[tab] = await p.evaluate(() => {
      const c = document.querySelector('#result .card.results'), body = document.querySelector('#resultBody');
      const bw = body.clientWidth;
      const g = document.querySelector('#resultBody > .res-graph, #resultBody svg.res-graph:not(.res-legend-icon):not(.tl-svg):not(.nc-axis)');
      const tl = document.querySelector('.tl-wrap'), sc = document.querySelector('.nc-scroller'), card = sc?.querySelector('.nc');
      // 文字の欠け: はみ出している要素（横スクロールの枠の中は除く）
      const clipped = [...body.querySelectorAll('p, span, b, small, td, th, li, dt, dd, button, label, h3, caption')].filter((e) => {
        if (!e.offsetParent || e.closest('.tl-scroll, .nc-scroller, .res-scroll')) return false;
        const r = e.getBoundingClientRect(), b = body.getBoundingClientRect();
        return r.right > b.right + 1 || r.left < b.left - 1;
      }).length;
      const axis = card?.querySelector('.nc-axis');
      return {
        inner: c.scrollWidth - c.clientWidth, bw, clipped,
        graphW: g ? Math.round(g.getBoundingClientRect().width) : null, graphVB: g ? +g.getAttribute('viewBox').split(' ')[2] : null,
        tlW: tl ? Math.round(tl.getBoundingClientRect().width) : null, tlScroll: tl ? document.querySelector('.tl-scroll').scrollWidth > document.querySelector('.tl-scroll').clientWidth : null,
        perView: card ? Math.round(sc.clientWidth / card.getBoundingClientRect().width * 10) / 10 : null,
        axisScale: axis ? Math.round(axis.getBoundingClientRect().width / +axis.getAttribute('viewBox').split(' ')[2] * 100) / 100 : null,
        tickFont: g ? getComputedStyle(g.querySelector('text')).fontSize : null,
      };
    });
    res[tab].over = await pageOver();
  }
  await p.click('[data-tab=detail]'); await p.waitForTimeout(800);
  // 照合タイムライン・カードの小さな時間軸の文字の重なり（広い幅でも）
  const overlap = await p.evaluate(() => {
    let bad = 0;
    for (const svg of document.querySelectorAll('.tl-scroll svg, .nc-axis')) {
      const ts = [...svg.querySelectorAll('text')].map((t) => t.getBBox());
      for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) { const a = ts[i], b = ts[j]; if (a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5) bad++; }
    }
    const cs = [...document.querySelectorAll('.nc')];
    const clip = cs.filter((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).length;
    return { bad, clip, heights: new Set(cs.map((c) => Math.round(c.getBoundingClientRect().height))).size };
  });

  const same = (a, b) => Math.abs(a.l - b.l) <= 1 && Math.abs(a.r - b.r) <= 1;
  const wantL = 10 + (safe?.l || 0), wantR = 10 + (safe?.r || 0);
  check(state === 'ended' && same(ed, rs) && same(ed, st) && Math.abs(ed.l - wantL) <= 1 && Math.abs(ed.r - wantR) <= 1,
    `${label}: 編集・成績・設定の左右の端がそろう（左 ${wantL}px・右 ${wantR}px = 10px ＋ セーフエリア）`, `編集 ${ed.l}/${ed.r} 成績 ${rs.l}/${rs.r} 設定 ${st.l}/${st.r}`);
  const overs = [edOver, stOver, ...Object.values(res).map((x) => x.over), ...Object.values(res).map((x) => x.inner)];
  check(overs.every((v) => v <= 0), `${label}: ページ全体・成績の枠に横スクロールなし`, overs.join(','));
  check(stIn.out.length === 0 && stIn.scroll <= 0 && stIn.fs === '14px' && (vp.width < 720 || stIn.cols === 2) && stIn.range > 120,
    `${label}: 設定の項目が広がった幅を使う（${stIn.cols} 列、文字は 14px のまま、はみ出しなし）`, JSON.stringify(stIn));
  const t = res.timing, d = res.detail;
  check(Math.abs(t.graphW - t.bw) <= 2 && t.graphVB === t.graphW && t.tickFont === '11px', `${label}: タイミングのグラフが成績の幅いっぱい（等倍で描くので文字の大きさは同じ）`, `グラフ ${t.graphW}px / 本文 ${t.bw}px`);
  check(Math.abs(d.tlW - d.bw) <= 2 && d.tlScroll, `${label}: 照合タイムラインが幅いっぱい（中は横スクロール）`, `${d.tlW}px / ${d.bw}px`);
  const wantCards = vp.width >= 1400 ? 4 : vp.width >= 1000 ? 3 : vp.width >= 620 ? 2 : 1;
  check(Math.abs(d.perView - wantCards) < 0.35 && d.axisScale === 1, `${label}: カードは ${wantCards} 枚ずつ並び、小さな時間軸は等倍（文字が拡大されない）`, `${d.perView} 枚分・倍率 ${d.axisScale}`);
  check(overlap.bad === 0 && overlap.clip === 0 && overlap.heights === 1 && Object.values(res).every((x) => x.clipped === 0), `${label}: 文字の重なり・欠けなし（カードの高さはそろう）`, JSON.stringify({ ...overlap, clipped: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.clipped])) }));
  check(errors.length === 0, `${label}: ページエラーなし`, errors.join(' / '));
  if (process.env.SHOTS) {
    const dir = process.env.SHOTS, tag = label.split(' ')[0] + vp.width;
    await p.screenshot({ path: `${dir}/${tag}_detail.png` });
    await p.click('[data-tab=timing]'); await p.waitForTimeout(300); await p.screenshot({ path: `${dir}/${tag}_timing.png` });
    await p.click('#btnResultClose');
    await p.evaluate(() => { document.querySelector('#more').open = true; }); await p.waitForTimeout(300); await p.screenshot({ path: `${dir}/${tag}_settings.png` });
    await p.evaluate(() => { document.querySelector('#more').open = false; window.__app.setEdit(true); }); await p.waitForTimeout(400);
    await p.evaluate(() => { const e = document.querySelector('#panel'); e.scrollTop = 0; }); await p.screenshot({ path: `${dir}/${tag}_editor.png` });
  }
  await ctx.close();
}

await browser.close();
console.log(fails.length ? `\nNG ${fails.length} 件` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
