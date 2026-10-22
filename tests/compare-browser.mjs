// 成績の比較（記録の比較・期間平均の比較）の確認（実素材が必要）: npm start（別ターミナル）→ node tests/compare-browser.mjs（BASE=公開 URL でも可）
// - 直近を含めず過去の 2 件以上を比較。3 件以上でもノーツは ID で対応。基準の変更で改善量が更新
// - 早押し／遅押し・MISS・ボタン違い・同時入力・長押しの比較。表示の件数・誤差・改善量が保存済みの記録と一致
// - 期間平均: 日付の境界（現地時間・終了日を含む）、AUTO・練習・途中終了・条件違い・重複の除外、合算の平均と改善率、書き出し、個別プレイへの移動
// - 文字の重なりなし・ページの横はみ出しなし（PC・スマホ縦）。既存の成績履歴は変わらない
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const fails = [];
const check = (ok, msg, extra = '') => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}${extra ? ` ${extra}` : ''}`); if (!ok) fails.push(msg); };
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
const ready = (p) => p.waitForFunction(() => ['ready', 'paused', 'playing'].includes(window.__app?.state), null, { timeout: 120000 });

/** 1 回プレイ（決まった入力。ボタン違い・同時入力・長押しの早離しを含む）→ 記録 */
async function playOnce(p) {
  return p.evaluate(() => {
    const a = window.__app;
    cancelAnimationFrame(a._raf); a.raf = () => {};
    const t0 = -a.chart.settings.leadInSeconds; // 最初から（途中から開始の練習にしない）
    a.__T = t0; a.clock.position = () => a.__T;
    a.startSession(t0); a.clock.stop(t0); a.newJudge(t0); a.state = 'playing'; a.clock.state = 'playing';
    const ev = [];
    a.chart.notes.forEach((n, i) => {
      if (n.id === 'n052') return; // 入力なし
      const d = n.id === 'n074' ? -0.03 : ((i * 37) % 120 - 60) / 1000; // 秒
      if (n.input === 'hold') { ev.push({ t: n.time + 0.02, b: 'Y', down: true }, { t: i % 2 ? n.time + n.duration * 0.5 : n.time + n.duration + 0.2, b: 'Y', down: false }); return; }
      ev.push({ t: n.time + d, b: n.button, down: true }, { t: n.time + d + 0.05, b: n.button, down: false });
    });
    ev.push({ t: 10.17 + 0.01, b: 'B', down: true }, { t: 10.2 + 0.01, b: 'B', down: false }); // ボタン違い（構の時刻に旋）
    const n052 = a.chart.notes.find((n) => n.id === 'n052');
    ev.push({ t: n052.time + 0.02, b: 'B', down: true }, { t: n052.time + 0.06, b: 'B', down: false }); // 入力なしの撃の時刻にボタン違い
    ev.sort((x, y) => x.t - y.t);
    let k = 0, seq = 0;
    while (a.__T < a.duration && a.state !== 'ended') {
      a.__T = Math.min(a.duration, a.__T + 1 / 30);
      while (k < ev.length && ev[k].t <= a.__T) {
        const e = ev[k++], save = a.__T; a.__T = e.t;
        if (e.down) a.onPress(e.b, 0, { id: `c${++seq}`, source: 'key', device: 'keyboard' }); else a.onRelease(e.b, 0, { source: 'key', device: 'keyboard' });
        a.__T = save;
      }
      a.frame();
    }
    return window.__lastRecord;
  });
}

/** 保存済みの記録から、入力を変えた過去の記録を作って履歴に入れる（同じ形式・同じ集計関数） */
async function addSynthetic(p) {
  return p.evaluate(async () => {
    const { summarize } = await import('/app/score.js');
    const a = window.__app, src = window.__lastRecord;
    const grade = (d, s) => (Math.abs(d) <= s.perfectWindowMs ? 'PERFECT' : Math.abs(d) <= s.goodWindowMs ? 'GOOD' : 'MISS');
    const at = (daysAgo, h = 12, m = 0, s = 0) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, s, 0); return d.toISOString(); };
    const mk = (id, when, deltas, extra = {}) => {
      const r = structuredClone(src);
      r.id = id; r.at = when; r.startedAt = when; r.kind = 'full'; r.practiceReasons = []; r.mode = 'manual';
      r.notes.forEach((n, i) => {
        if (n.hold) return; // 息は元の記録のまま（押し始め・保持の比較は別に確認）
        const d = deltas(n, i);
        if (d === undefined) return;
        if (d === null) { n.input = null; n.result = 'MISS'; n.reason = 'timeout'; n.points = 0; if (n.frames) n.frames.input = null; return; }
        n.input = { ...(n.input || { button: n.button, device: 'keyboard' }), button: n.button, time: Math.round((n.time + d / 1000) * 1e6) / 1e6, raw: Math.round((n.time + d / 1000) * 1e6) / 1e6, deltaMs: d, rawDeltaMs: d };
        n.result = grade(d, r.settings); n.points = n.result === 'PERFECT' ? 1000 : n.result === 'GOOD' ? 500 : 0; n.reason = null;
        if (n.frames) n.frames.input = { i: a.store.indexAt(n.input.time), t: a.store.frames[a.store.indexAt(n.input.time)].t };
      });
      r.extras = [];
      Object.assign(r, extra);
      r.judge.score = r.notes.reduce((s, n) => s + (n.points || 0), 0);
      r.summary = summarize(r);
      return r;
    };
    const base = (n, i) => (n.id === 'n074' ? -80 : n.id === 'n052' ? null : n.id === 'n053' ? 33 : ((i % 5) - 2) * 30);
    const mid = (n, i) => (n.id === 'n074' ? 20 : n.id === 'n052' ? 90 : n.id === 'n053' ? -40 : ((i % 5) - 2) * 15);
    const recs = [
      mk('cmp-r1', at(10), base),
      mk('cmp-r2', at(5), mid),
      mk('cmp-auto', at(4), (n, i) => 0, { mode: 'auto' }),
      mk('cmp-prac', at(4), (n, i) => 5, { kind: 'practice', practiceReasons: ['seek'] }),
      mk('cmp-slow', at(4), (n, i) => 5, { rate: 0.5 }),
      mk('cmp-edge-in', at(7, 23, 59, 59), (n, i) => 10),   // 期間 A の終了日 23:59:59（含む）
      mk('cmp-edge-out', at(6, 0, 0, 0), (n, i) => 70),     // 期間 B の開始日 0:00:00（B に入る）
    ];
    const dup = structuredClone(recs[0]); dup.id = 'cmp-r1-copy'; // JSON から取り込んだ同じプレイ（別 ID）
    for (const r of [...recs, dup]) a.history.add(r);
    return { ids: recs.map((r) => r.id), dup: dup.id, n: a.history.records.length };
  });
}

const overlapText = (p, sel) => p.evaluate((q) => {
  let bad = 0, n = 0;
  for (const svg of document.querySelectorAll(q)) {
    const ts = [...svg.querySelectorAll('text')].map((t) => t.getBBox()); n += ts.length;
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) { const a = ts[i], b = ts[j]; if (a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5) bad++; }
  }
  return { n, bad };
}, sel);
const pageOver = (p) => p.evaluate(() => ({ page: Math.max(document.scrollingElement.scrollWidth, document.body.scrollWidth) - window.innerWidth, card: (() => { const c = document.querySelector('#result .card.results'); return c.scrollWidth - c.clientWidth; })() }));

for (const [label, vp] of [['PC 1280x900', { width: 1280, height: 900 }], ['スマホ縦 393x852', { width: 393, height: 852 }]]) {
  const ctx = await browser.newContext({ viewport: vp });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}?fresh=1`); await ready(p);
  await p.evaluate(() => { localStorage.removeItem('kiva2d.v2.history'); window.__app.history.load(); });
  const R0 = await playOnce(p);
  const syn = await addSynthetic(p);
  const histBefore = await p.evaluate(() => localStorage.getItem('kiva2d.v2.history'));
  const pc = label.startsWith('PC');

  // ---------- 記録の比較: 直近（R0）を含めず、過去の 2 件 ----------
  await p.click('[data-tab=history]');
  await p.check('[data-sel="cmp-r1"]'); await p.check('[data-sel="cmp-r2"]');
  const btn = await p.textContent('[data-act=cmpSel]');
  await p.click('[data-act=cmpSel]');
  await p.waitForTimeout(400);
  let st = await p.evaluate(() => ({ ids: window.__app.results.cmp.ids, base: window.__app.results.cmp.data?.base.rec.id, legend: [...document.querySelectorAll('.cmp-legend li')].map((li) => li.textContent.replace(/\s+/g, ' ')), rows: window.__cmpTl?.rows.length }));
  check(/選択した 2 件を比較/.test(btn) && st.ids.length === 2 && !st.ids.includes(R0.id) && st.base === 'cmp-r1' && st.legend.length === 2 && /基準/.test(st.legend[0]) && st.rows === 6,
    `${label}: 直近を含めず過去の 2 件を比較（基準は最も古い記録。凡例に日時）`, JSON.stringify({ base: st.base, rows: st.rows }));
  // 比較画面から記録を追加（直近の記録）
  await p.evaluate(() => { document.querySelector('.cmp-pick').open = true; });
  await p.check(`[data-cpick="${R0.id}"]`);
  await p.click('[data-cact=apply]');
  await p.waitForTimeout(500);
  // 表示と保存済みの記録の一致（全ノーツ × 全記録）
  const verify = () => p.evaluate(() => {
    const V = window.__app.results.cmp, d = V.data, H = window.__app.history;
    const baseRec = H.get(d.base.rec.id);
    const fmt = (v) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}ms`;
    const bad = [];
    let cells = 0;
    for (const td of document.querySelectorAll('.cmx td[data-cnote]')) {
      cells++;
      const rec = H.get(td.dataset.crec), n = rec.notes.find((x) => x.id === td.dataset.cnote), b = baseRec.notes.find((x) => x.id === td.dataset.cnote);
      const t = td.textContent.replace(/\s+/g, ' ');
      if (!n) { if (!/対応なし/.test(t)) bad.push(`${td.dataset.cnote}: 対応なし`); continue; }
      if (n.input) { if (!t.includes(`${n.result} ${fmt(n.input.deltaMs)}`)) bad.push(`${n.id}@${rec.id}: ${t}`); }
      else if (!/入力なし/.test(t)) bad.push(`${n.id}@${rec.id}: 入力なし ${t}`);
      if (rec.id === baseRec.id) { if (!/基準/.test(t)) bad.push(`${n.id}: 基準`); continue; }
      const rank = { PERFECT: 2, GOOD: 1, MISS: 0 };
      if (n.input && b.input) {
        const imp = Math.round((Math.abs(b.input.deltaMs) - Math.abs(n.input.deltaMs)) * 10) / 10;
        const want = imp > 0 ? `${imp.toFixed(1)}ms 改善` : imp < 0 ? `${Math.abs(imp).toFixed(1)}ms 悪化` : null;
        if (want && !t.includes(want)) bad.push(`${n.id}@${rec.id}: 改善量 ${want} / ${t}`);
        if (!want && rank[n.result] === rank[b.result] && !/変化なし/.test(t)) bad.push(`${n.id}: 変化なし`);
      } else if (rank[n.result] !== rank[b.result]) {
        const tag = (o) => (!o.input && o.result === 'MISS' ? '入力なし' : o.result);
        if (!t.includes(`${tag(b)}→${tag(n)}`) || /ms 改善|ms 悪化/.test(t)) bad.push(`${n.id}@${rec.id}: 判定の変化 ${t}`);
      }
    }
    // 全体の集計（入力の合算）と表の値
    const sums = d.recs.map((x) => {
      const r = H.get(x.rec.id);
      const ds = r.notes.filter((n) => n.input && n.input.deltaMs != null).map((n) => Math.abs(n.input.deltaMs));
      return { id: r.id, mae: Math.round(ds.reduce((s, v) => s + v, 0) / ds.length * 10) / 10, timed: ds.length, miss: r.notes.filter((n) => n.result === 'MISS').length };
    });
    const sumText = document.querySelector('.cmp-sum').textContent;
    const sumOk = sums.every((s) => sumText.includes(`${s.mae.toFixed(1)}ms（入力 ${s.timed} 件）`) && sumText.includes(`（${s.miss} 件。`));
    return { bad, cells, sumOk, recs: d.recs.length, base: d.base.rec.id };
  });
  let v = await verify();
  check(v.recs === 3 && v.cells === 59 * 3 && v.bad.length === 0, `${label}: 3 件の比較で全 59 ノーツ × 3 記録が ID で対応し、判定・ずれ・改善量が保存済みの記録と一致`, v.bad.slice(0, 3).join(' / '));
  check(v.sumOk, `${label}: 記録ごとの平均絶対誤差（入力の合算）・誤差の件数・MISS 件数が保存済みの記録と一致`);
  // 基準の変更
  await p.check('[data-cbase="cmp-r2"]');
  await p.waitForTimeout(400);
  v = await verify();
  check(v.base === 'cmp-r2' && v.bad.length === 0, `${label}: 基準を変えると改善量が更新される（基準 = 2 件目）`, v.bad.slice(0, 3).join(' / '));
  await p.check('[data-cbase="cmp-r1"]');
  await p.waitForTimeout(300);
  // 具体例: 基準 80ms 早い → 20ms 遅い = 60ms 改善、入力なし→GOOD、ボタン違いは精度向上にしない
  const cell = (note, rec) => p.evaluate(([n, r]) => document.querySelector(`.cmx td[data-cnote="${n}"][data-crec="${r}"]`)?.textContent.replace(/\s+/g, ' '), [note, rec]);
  const c74 = await cell('n074', 'cmp-r2'), c52 = await cell('n052', 'cmp-r2'), c52r0 = await cell('n052', R0.id), c74r0 = await cell('n074', R0.id), c53 = await cell('n053', 'cmp-r2');
  check(/GOOD −80\.0ms/.test(await cell('n074', 'cmp-r1')) && /PERFECT \+20\.0ms/.test(c74) && /GOOD→PERFECT（60\.0ms 改善）/.test(c74), `${label}: 早押し 80ms → 遅押し 20ms は「60ms 改善」（相殺しない）`, c74);
  check(/GOOD \+90\.0ms/.test(c52) && /入力なし→GOOD/.test(c52) && !/ms 改善/.test(c52), `${label}: 入力なしの MISS → GOOD は「入力なし→GOOD」（ms の改善量を作らない）`, c52);
  check(/入力なし/.test(c52r0) && /＝ 変化なし|入力なし/.test(c52r0) && !/GOOD|PERFECT/.test(c52r0.split('入力なし')[0]), `${label}: 撃の時刻のボタン違い（旋）は撃の入力として扱わない（入力なしのまま）`, c52r0);
  check(/PERFECT −30\.0ms/.test(c74r0), `${label}: 構の時刻のボタン違い（旋）は構の精度に影響しない（構の入力 −30ms を採用）`, c74r0);
  check(/7\.0ms 悪化/.test(c53), `${label}: 遅押し 33ms → 早押し 40ms は「7ms 悪化」`, c53);
  // ノーツ別の詳細（画像つき）・長押し・同時入力
  await p.click('.cmx td[data-cnote="n074"][data-crec="cmp-r2"]');
  await p.waitForTimeout(600);
  await p.waitForFunction(() => [...document.querySelectorAll('.cmp-detail canvas')].every((c) => c.dataset.ready), null, { timeout: 8000 }).catch(() => {});
  st = await p.evaluate(() => ({ t: document.querySelector('.cmp-detail').textContent.replace(/\s+/g, ' '), rows: document.querySelectorAll('.cmp-dt tbody tr').length, imgs: [...document.querySelectorAll('.cmp-detail canvas')].map((c) => !!c.dataset.ready), sel: document.querySelector('.cmp-scroll .tl-item.is-sel')?.dataset.cnote }));
  check(st.rows === 3 && st.sel === 'n074' && /選択: n074/.test(st.t) && /−80\.0ms 早い/.test(st.t) && /80\.0ms/.test(st.t) && /\+20\.0ms 遅い/.test(st.t) && /60\.0ms 改善/.test(st.t) && st.imgs.length >= 3 && st.imgs.every(Boolean),
    `${label}: セルを選ぶと時間軸と詳細へ移り、全記録の入力・符号付き／絶対誤差・判定・改善量・正解時と入力時の画像を表示`, `${st.rows} 行・画像 ${st.imgs.filter(Boolean).length}`);
  const hold = await p.evaluate(() => { const r = window.__app.results.cmp.data.rows.find((x) => x.note.hold); window.__app.results.cmp.selectNote(r.note.id); return { id: r.note.id, t: document.querySelector('.cmp-detail').textContent.replace(/\s+/g, ' ') }; });
  check(/保持・解除/.test(hold.t) && /押し始め/.test(hold.t) && /(保持して成功|早離し)/.test(hold.t), `${label}: 長押しは押し始めの精度と保持・解除を分けて比較（${hold.id}）`);
  const simul = await p.evaluate(() => ['n065', 'n066'].map((id) => document.querySelector(`.cmx td[data-cnote="${id}"][data-crec="${window.__lastRecord.id}"]`)?.textContent.replace(/\s+/g, ' ')));
  check(simul.every((t) => /PERFECT|GOOD/.test(t || '')), `${label}: 同時入力（44.83 秒の構と息）はそれぞれのノーツで比較`, simul.join(' | '));
  // 全編の時間軸: 同じ時刻 = 同じ横位置（全行）、入力なし・余分な入力・長押し
  const tl = await p.evaluate(() => {
    const T = window.__cmpTl, H = window.__app.history, X = (t) => T.pad + t * T.pps;
    const bad = [];
    for (const g of document.querySelectorAll('.cmp-scroll g.tl-item[data-cnote]')) {
      const id = g.dataset.cnote, nm = g.querySelector('.tl-nmark'), ref = window.__app.results.cmp.data.rows.find((r) => r.note.id === id).note;
      if (Math.abs(+nm.getAttribute('x') + 3 - X(ref.time)) > 0.6) bad.push(`note ${id}`);
      for (const sh of g.querySelectorAll('g.cur')) {
        const b = sh.firstElementChild.getBBox(), cx = b.x + b.width / 2, cy = b.y + b.height / 2;
        const row = T.rows.find((r) => r.kind === 'rec' && cy > r.y && cy < r.y + r.h);
        const n = H.get(row.id).notes.find((x) => x.id === id);
        if (!n?.input || Math.abs(cx - X(n.input.time)) > 0.8) bad.push(`input ${id}@${row?.id}`);
      }
    }
    const noin = document.querySelectorAll('.cmp-scroll .cmp-noin-box').length;
    const want = window.__app.results.cmp.data.recs.reduce((s, x) => s + H.get(x.rec.id).notes.filter((n) => !n.input && n.result === 'MISS').length, 0);
    return { bad, noin, want, extras: document.querySelectorAll('.cmp-scroll g.g-extra').length, held: document.querySelectorAll('.cmp-scroll .tl-held').length, rows: T.rows.length, dur: T.dur };
  });
  check(tl.bad.length === 0 && tl.rows === 7 && tl.dur > 82, `${label}: 全編の時間軸（0〜${tl.dur.toFixed(1)} 秒）で正解と 3 記録の入力が同じ時刻 = 同じ横位置`, tl.bad.slice(0, 3).join(','));
  check(tl.noin === tl.want && tl.extras >= 2 && tl.held > 0, `${label}: 入力なし（${tl.noin}）・余分な入力（${tl.extras}）・長押しの区間を区別して表示`);
  for (let i = 0; i < 14; i++) await p.click('[data-czoom="1"]');
  const z = await p.evaluate(() => ({ pps: window.__cmpTl.pps, w: document.querySelector('.cmp-scroll svg').getAttribute('width'), lab: document.querySelector('.cmp-labels').getBoundingClientRect().left, scroll: document.querySelector('.cmp-scroll').scrollWidth }));
  const ovz = await overlapText(p, '.cmp-scroll svg');
  await p.click('[data-czoom="fit"]');
  const ovf = await overlapText(p, '.cmp-scroll svg');
  check(z.pps === 1000 && ovz.bad === 0 && ovf.bad === 0 && ovz.n > ovf.n, `${label}: 拡大（1 秒 = 1000px）・全体表示とも文字が重ならない（拡大すると ms の文字が出る）。全行が 1 つの時間軸で連動`, `文字 ${ovf.n}→${ovz.n}・重なり ${ovf.bad}/${ovz.bad}・${z.pps}px/秒`);
  // 比較表の絞り込み
  const fl = await p.evaluate(() => {
    const d = window.__app.results.cmp.data, out = {};
    for (const k of ['up', 'down', 'miss']) { document.querySelector(`[data-crow=${k}]`).click(); out[k] = [document.querySelectorAll('.cmx tbody tr').length, d.rows.filter((r) => (k === 'up' ? r.improved : k === 'down' ? r.worsened : r.hasMiss)).length]; }
    document.querySelector('[data-crow=all]').click();
    for (const b of ['X', 'A', 'B']) document.querySelector(`[data-ccmd=${b}]`).click();
    out.Y = [document.querySelectorAll('.cmx tbody tr').length, d.rows.filter((r) => r.note.button === 'Y').length];
    for (const b of ['X', 'A', 'B']) document.querySelector(`[data-ccmd=${b}]`).click();
    return out;
  });
  check(Object.values(fl).every(([a, b]) => a === b && a > 0), `${label}: 比較表を改善・悪化・MISS を含む・技（息）で絞り込み`, JSON.stringify(fl));
  st = await p.evaluate(() => ({ trend: document.querySelectorAll('.cmp-trend').length, cmd: document.querySelectorAll('.cmp-sum')[1]?.textContent.includes('▲') }));
  check(st.trend === 2 && st.cmd, `${label}: 技別の成功率・平均絶対誤差・改善／悪化したノーツ数、3 件以上で日時順の推移`);
  // 条件が違う記録・外す
  await p.evaluate(() => { document.querySelector('.cmp-pick').open = true; });
  await p.check('[data-cpick="cmp-slow"]'); await p.click('[data-cact=apply]'); await p.waitForTimeout(400);
  st = await p.evaluate(() => ({ legend: [...document.querySelectorAll('.cmp-legend li')].map((l) => l.textContent.replace(/\s+/g, ' ')).join(' | '), sum: document.querySelector('.cmp-sum').textContent }));
  check(/条件が違う: 再生速度 1→0\.5/.test(st.legend) && /※条件が違う/.test(st.sum), `${label}: 条件が違う記録は違いを明示し、同条件の改善と区別（※）`);
  await p.click('[data-crm="cmp-slow"]'); await p.waitForTimeout(300);
  check(await p.evaluate(() => window.__app.results.cmp.ids.length) === 3, `${label}: 比較画面から記録を外せる`);
  const ov = await pageOver(p);
  check(ov.page <= 0 && ov.card <= 0, `${label}: 記録の比較でページ・成績の枠に横スクロールなし（時間軸と表は枠内でスクロール）`, JSON.stringify(ov));

  // ---------- 期間平均の比較 ----------
  await p.click('[data-cmode=period]');
  await p.waitForTimeout(300);
  const ymd = (daysAgo) => p.evaluate((k) => { const d = new Date(); d.setDate(d.getDate() - k); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }, daysAgo);
  const setDate = async (k, val) => { await p.fill(`[data-pdate=${k}]`, val); await p.dispatchEvent(`[data-pdate=${k}]`, 'change'); await p.waitForTimeout(200); };
  await setDate('A0', await ymd(13)); await setDate('A1', await ymd(7)); await setDate('B0', await ymd(6)); await setDate('B1', await ymd(0));
  const per = await p.evaluate(() => {
    const V = window.__app.results.cmp, res = V.pdata, H = window.__app.history;
    const pool = (ids) => { const ds = ids.flatMap((id) => H.get(id).notes.filter((n) => n.input && n.input.deltaMs != null).map((n) => Math.abs(n.input.deltaMs))); return Math.round(ds.reduce((s, v) => s + v, 0) / ds.length * 10) / 10; };
    return { A: res.A.ids, B: res.B.ids, dup: res.duplicates, ex: res.excludedRecords, maeA: res.all.a.mae, maeB: res.all.b.mae, wantA: pool(res.A.ids), wantB: pool(res.B.ids), imp: res.all.maeImprove, pct: res.all.maeImprovePct,
      text: document.querySelector('#resultBody').textContent.replace(/\s+/g, ' '), overlap: res.overlap.length };
  });
  check(per.A.includes('cmp-r1') && per.A.includes('cmp-edge-in') && !per.A.includes('cmp-edge-out') && per.B.includes('cmp-edge-out') && per.B.includes('cmp-r2') && per.B.includes(R0.id),
    `${label}: 日付の境界（現地時間）: A の終了日 23:59:59 は A、B の開始日 0:00:00 は B`, `A ${per.A.join(',')} / B ${per.B.join(',')}`);
  check(!per.A.concat(per.B).some((id) => ['cmp-auto', 'cmp-prac', 'cmp-slow', 'cmp-r1-copy'].includes(id)) && per.dup.includes('cmp-r1-copy') && per.ex.AUTO === 1 && per.ex['練習'] === 1 && per.ex['判定幅・速度・入力補正が違う'] === 1,
    `${label}: AUTO・練習・条件違いを除外し、取り込んだ重複は 1 回だけ数える（理由と件数を表示）`, JSON.stringify(per.ex));
  const pct = Math.round((per.maeA - per.maeB) / per.maeA * 1000) / 10;
  check(per.maeA === per.wantA && per.maeB === per.wantB && per.imp === Math.round((per.maeA - per.maeB) * 10) / 10 && per.pct === pct
    && per.text.includes(`${Math.abs(per.imp).toFixed(1)}ms ${per.imp > 0 ? '改善' : '悪化'}・誤差 ${Math.abs(pct).toFixed(1)}%${pct >= 0 ? '減少' : '増加'}`),
    `${label}: 平均絶対誤差は期間内の入力を合算、改善量 = A − B、改善率 = 改善量 ÷ A`, `A ${per.maeA} B ${per.maeB} → ${per.imp}ms ${per.pct}%`);
  check(/プレイ \d+ 件・ノーツ \d+ 件・誤差の対象 \d+ 件・MISS \d+ 件/.test(per.text) && /ポイント(向上|低下|減少|増加|（変化なし）)/.test(per.text) && /有意性は判定していません/.test(per.text) && !/有意に向上/.test(per.text),
    `${label}: 件数（プレイ・ノーツ・誤差の対象・MISS）、率の差は「ポイント」、有意性を主張しない`);
  // 期間の重複
  await setDate('B0', await ymd(10));
  st = await p.evaluate(() => ({ ov: window.__app.results.cmp.pdata.overlap.length, t: document.querySelector('#resultBody').textContent }));
  check(st.ov > 0 && /期間 A と B が重なっています/.test(st.t), `${label}: 期間が重なると、同じ記録が両方に含まれることを表示`, `${st.ov} 件`);
  await setDate('B0', await ymd(6));
  // データなし: 期間 B に記録がない
  await setDate('B0', await ymd(40)); await setDate('B1', await ymd(35));
  st = await p.evaluate(() => ({ t: document.querySelector('#resultBody').textContent, plays: window.__app.results.cmp.pdata.B.plays, dots: document.querySelectorAll('.per-scroll .per-pb').length }));
  check(st.plays === 0 && /データなし/.test(st.t) && st.dots === 0, `${label}: データのない期間は「データなし」（0 として描かない）`);
  await setDate('B0', await ymd(6)); await setDate('B1', await ymd(0));
  // ノーツ別: 選択で画像と両期間の値、並べ替え、書き出し、個別プレイへ
  await p.evaluate(() => document.querySelector('.per-scroll [data-pnote="n074"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await p.waitForTimeout(500);
  await p.waitForFunction(() => document.querySelector('.per-sel canvas')?.dataset.ready, null, { timeout: 5000 }).catch(() => {});
  st = await p.evaluate(() => ({ t: document.querySelector('.per-sel').textContent.replace(/\s+/g, ' '), img: !!document.querySelector('.per-sel canvas')?.dataset.ready }));
  check(/選択: n074/.test(st.t) && /成功率/.test(st.t) && /ばらつき/.test(st.t) && /件/.test(st.t) && st.img, `${label}: ノーツを選ぶと正解時刻の画像と、両期間の平均誤差・ばらつき・成功率・件数`);
  const sorted = await p.evaluate(() => {
    const get = () => [...document.querySelectorAll('.per-notes-tbl tbody tr')].map((tr) => window.__app.results.cmp.pdata.notes.find((n) => n.id === tr.dataset.pnote));
    document.querySelector('[data-psort=up]').click(); const up = get().map((n) => n.maeImprove).filter((v) => v != null);
    document.querySelector('[data-psort=down]').click(); const down = get().map((n) => n.maeImprove).filter((v) => v != null);
    document.querySelector('[data-psort=time]').click(); const time = get().map((n) => n.time);
    const mono = (a, f) => a.every((v, i) => !i || f(a[i - 1], v));
    return { up: mono(up, (a, b) => a >= b), down: mono(down, (a, b) => a <= b), time: mono(time, (a, b) => a <= b), cols: document.querySelector('.per-notes-tbl thead').textContent };
  });
  check(sorted.up && sorted.down && sorted.time && /ノーツ時刻.*コマンド.*期間 A の平均.*期間 B の平均.*改善量.*件数/.test(sorted.cols), `${label}: ノーツ別の比較表（時刻・コマンド・A／B の平均・改善量・件数）を改善順・悪化順・時刻順に並べ替え`);
  await p.click('[data-pexp=csv]'); const csv = await p.evaluate(() => window.__lastScoreExport);
  await p.click('[data-pexp=json]'); const js = await p.evaluate(() => JSON.parse(window.__lastScoreExport));
  check(/^﻿# 期間平均の比較/.test(csv) && /改善量ms\(A-B\)/.test(csv) && csv.split('\r\n').length > 59 && js.schema === 'kiva-period-compare/1' && js.conditions.text && js.plays.A.length === per.A.length && js.all.maeImprove === per.imp,
    `${label}: 比較結果と集計条件を CSV・JSON で書き出し`);
  await p.evaluate(() => { document.querySelector('.per-plays').open = true; });
  await p.click('.per-plays [data-open="cmp-r1"]');
  st = await p.evaluate(() => ({ id: window.__app.results.rec?.id, tab: window.__app.results.tab }));
  check(st.id === 'cmp-r1' && st.tab === 'summary', `${label}: 期間平均の比較から集計対象の個別プレイへ移動`);
  // 既存の履歴は変わらない
  const histAfter = await p.evaluate(() => localStorage.getItem('kiva2d.v2.history'));
  check(histAfter === histBefore, `${label}: 比較の操作で成績履歴（保存データ）は変わらない`, `${JSON.parse(histAfter).records.length} 件`);
  check(errors.length === 0, `${label}: ページエラーなし`, errors.join(' / '));
  if (process.env.SHOTS) {
    const dir = process.env.SHOTS, tag = pc ? 'pc' : 'ph';
    await p.click('[data-tab=history]'); await p.check('[data-sel="cmp-r1"]'); await p.check('[data-sel="cmp-r2"]'); await p.check(`[data-sel="${R0.id}"]`);
    await p.screenshot({ path: `${dir}/${tag}_1_select.png` });
    await p.click('[data-act=cmpSel]'); await p.waitForTimeout(500);
    await p.screenshot({ path: `${dir}/${tag}_2_compare.png` });
    await p.evaluate(() => document.querySelector('.cmp-wrap').scrollIntoView({ block: 'start' })); await p.waitForTimeout(300);
    await p.screenshot({ path: `${dir}/${tag}_3_timeline.png` });
    await p.click('.cmx td[data-cnote="n074"][data-crec="cmp-r2"]'); await p.waitForTimeout(800);
    await p.evaluate(() => document.querySelector('.cmp-detail').scrollIntoView({ block: 'start' })); await p.waitForTimeout(500);
    await p.screenshot({ path: `${dir}/${tag}_4_note.png` });
    await p.evaluate(() => document.querySelector('.cmx-wrap').scrollIntoView({ block: 'start' })); await p.waitForTimeout(300);
    await p.screenshot({ path: `${dir}/${tag}_5_matrix.png` });
    for (let i = 0; i < 7; i++) await p.click('[data-czoom="1"]');
    await p.evaluate(() => window.__app.results.cmp.selectNote('n052', { scroll: false }));
    await p.evaluate(() => document.querySelector('.cmp-wrap').scrollIntoView({ block: 'start' })); await p.waitForTimeout(300);
    await p.screenshot({ path: `${dir}/${tag}_6_timeline_zoom.png` });
    await p.click('[data-cmode=period]'); await p.waitForTimeout(400);
    await setDate('A0', await ymd(13)); await setDate('A1', await ymd(7)); await setDate('B0', await ymd(6)); await setDate('B1', await ymd(0));
    await p.screenshot({ path: `${dir}/${tag}_7_period.png` });
    await p.evaluate(() => document.querySelector('.per-big').scrollIntoView({ block: 'start' })); await p.waitForTimeout(300);
    await p.screenshot({ path: `${dir}/${tag}_8_period_overall.png` });
    await p.evaluate(() => { document.querySelector('.per-scroll [data-pnote="n074"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); document.querySelector('.per-wrap').scrollIntoView({ block: 'start' }); }); await p.waitForTimeout(700);
    await p.screenshot({ path: `${dir}/${tag}_9_period_notes.png` });
  }
  await ctx.close();
}

await browser.close();
console.log(fails.length ? `\nNG ${fails.length} 件` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
