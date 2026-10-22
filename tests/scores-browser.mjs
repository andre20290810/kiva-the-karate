// タイミング判定の設定・入力の記録・成績画面・履歴と比較の確認（実素材が必要）:
//   npm start（別ターミナル）→ node tests/scores-browser.mjs   （BASE=公開 URL でも可）
// 時間軸を 1/60 秒ずつ手で進め、決まった時刻に入力する（実際の入力と同じ onPress / onRelease を通す）。
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const fails = [];
const check = (ok, msg, extra = '') => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}${extra ? ` ${extra}` : ''}`); if (!ok) fails.push(msg); };
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
const ready = (p) => p.waitForFunction(() => ['ready', 'paused', 'playing'].includes(window.__app?.state), null, { timeout: 120000 });

/** ページに「手で時間を進める」仕組みを入れる */
async function harness(p) {
  await p.evaluate(() => {
    const a = window.__app;
    cancelAnimationFrame(a._raf); a.raf = () => {};
    a.__T = -2; a.clock.position = () => a.__T;
    const play = a.clock.play.bind(a.clock), pause = a.clock.pause.bind(a.clock);
    a.clock.play = (t) => { a.clock.state = 'playing'; return undefined; }; void play;
    a.clock.pause = () => { a.clock.state = 'paused'; }; void pause;
    a.clock.unlock = async () => false;
    a.clock.stop = (t) => { a.__T = t; a.clock.state = 'stopped'; };
    a.clock.seek = (t) => { a.__T = t; };
    a.clock.setRate = (r) => { a.clock.rate = r; };
    /** to まで進める。events: [{t, b, down, device}]（時刻順でなくてよい） */
    window.__run = (to, events = [], { stopAtEnd = true } = {}) => {
      const ev = events.slice().sort((x, y) => x.t - y.t);
      let i = 0, n = 0;
      while (a.__T < to - 1e-9) {
        a.__T = Math.min(to, a.__T + 1 / 60);
        while (i < ev.length && ev[i].t <= a.__T + 1e-9) {
          const e = ev[i++], keep = a.__T; a.__T = e.t;
          if (e.down) a.onPress(e.b, 0, { id: `t${Date.now()}:${++n}:${Math.random()}`, source: e.source || 'key', device: e.device || 'keyboard' });
          else a.onRelease(e.b, 0, { source: e.source || 'key', device: e.device || 'keyboard' });
          a.__T = keep;
        }
        a.frame();
        if (stopAtEnd && a.state === 'ended') break;
      }
    };
  });
}
const openMore = null; void openMore;
const startPlay = (p) => p.evaluate(async () => { const a = window.__app; a.state = a.state === 'playing' ? a.state : 'ready'; a.needsBgmOverride = true; Object.defineProperty(a, 'needsBgm', { get: () => false, configurable: true }); await a.play(); });

// ---------- 1. タイミング判定の設定 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}`); await ready(p);
  await p.evaluate(() => { document.querySelector('#more').open = true; });
  const meaning = await p.textContent('[data-mean="perfectWindowMs"]');
  check(/±60ms＝正解時刻の 0\.06 秒前〜0\.06 秒後/.test(meaning), '設定値の意味を表示（±60ms＝正解時刻の 0.06 秒前〜0.06 秒後）', meaning);
  await p.fill('#winPerfect', '130'); await p.dispatchEvent('#winPerfect', 'input');
  let st = await p.evaluate(() => ({ dis: document.querySelector('#timingSave').disabled, err: document.querySelector('#timingErr').textContent, cur: window.__app.chart.settings.perfectWindowMs }));
  check(st.dis && /PERFECT は GOOD 以下/.test(st.err) && st.cur === 60, '大小関係が不正なら保存できない（PERFECT 130 > GOOD 120）', st.err);
  await p.fill('#winPerfect', '50'); await p.fill('#winGood', '100'); await p.fill('#winHoldStart', '90'); await p.fill('#winRelease', '200');
  await p.dispatchEvent('#winRelease', 'input');
  await p.click('#timingSave');
  st = await p.evaluate(() => ({ s: window.__app.chart.settings, draft: JSON.parse(localStorage.getItem('kiva2d.v2.chart.autosave') || 'null')?.settings ?? null, j: window.__app.judge.ms }));
  check(st.s.perfectWindowMs === 50 && st.s.goodWindowMs === 100 && st.s.holdStartWindowMs === 90 && st.s.holdReleaseWindowMs === 200 && st.j.perfect === 50, '正しい設定は保存され、プレイしていないときはすぐ使う', JSON.stringify(st.j));
  await p.waitForTimeout(400);
  st = await p.evaluate(() => JSON.parse(localStorage.getItem('kiva2d.v2.chart.autosave') || 'null')?.settings ?? null);
  check(st?.perfectWindowMs === 50 && st.holdStartWindowMs === 90, '設定は譜面（JSON）と同じところに保存（再読み込み後も残る）');
  await p.reload(); await ready(p);
  st = await p.evaluate(() => window.__app.chart.settings);
  check(st.perfectWindowMs === 50 && st.goodWindowMs === 100, '再読み込み後も設定が残る');
  // プレイ中の変更は次のプレイから
  await harness(p); await startPlay(p);
  await p.evaluate(() => window.__run(3));
  await p.evaluate(() => { document.querySelector('#more').open = true; });
  await p.fill('#winGood', '150'); await p.dispatchEvent('#winGood', 'input'); await p.click('#timingSave');
  st = await p.evaluate(() => ({ j: window.__app.judge.ms.good, s: window.__app.chart.settings.goodWindowMs, sess: window.__app.session.settings.goodWindowMs, state: document.querySelector('#timingState').textContent }));
  check(st.j === 100 && st.sess === 100 && st.s === 150 && /次のプレイから/.test(st.state), 'プレイ中に保存した設定は今のプレイの判定を変えず、次のプレイから', JSON.stringify(st));
  await p.evaluate(() => window.__app.retry());
  st = await p.evaluate(() => window.__app.judge.ms.good);
  check(st === 150, 'リトライ（次のプレイ）で新しい設定を使う');
  await p.evaluate(() => { document.querySelector('#more').open = true; });
  await p.click('#timingReset');
  st = await p.evaluate(() => window.__app.chart.settings);
  check(st.perfectWindowMs === 60 && st.goodWindowMs === 120 && st.missWindowMs === 180 && st.holdStartWindowMs === 120 && st.holdReleaseWindowMs === 150 && st.inputOffsetMs === 0, '「初期設定に戻す」で初期値に戻して保存');
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await p.evaluate(() => localStorage.clear());
  await ctx.close();
}

// ---------- 2. 入力の記録・成績画面・履歴・比較 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.goto(base); await ready(p);
  await harness(p);
  const notes = await p.evaluate(() => window.__app.chart.notes.map((n) => ({ id: n.id, t: n.time, b: n.button, input: n.input, d: n.duration })));
  const byId = Object.fromEntries(notes.map((n) => [n.id, n]));
  // 予定: ずれ（ms）。境界の直前・上・直後、入力なし、余分な入力、同時入力、長押しの早離し・完了後に離す
  const D = { n074: -60, n050: 60.1, n004: 120, n051: 120.1, n052: -180.1, n075: -25, n053: 33, n055: null, n076: 0 };
  const ev = [];
  for (const n of notes) {
    if (n.input === 'hold') continue;
    const d = n.id in D ? D[n.id] : ((n.t * 1000) % 7) * 5 - 15;
    if (d == null) continue;
    ev.push({ t: n.t + d / 1000, b: n.b, down: true, device: n.b === 'A' ? 'touch' : 'keyboard', source: n.b === 'A' ? 'pointer' : 'key' }, { t: n.t + d / 1000 + 0.05, b: n.b, down: false, source: n.b === 'A' ? 'pointer' : 'key' });
  }
  const holds = notes.filter((n) => n.input === 'hold');
  holds.forEach((h, i) => {
    ev.push({ t: h.t + 0.02, b: 'Y', down: true });
    ev.push({ t: i === 0 ? h.t + h.d * 0.5 : h.t + h.d + 0.3, b: 'Y', down: false }); // 最初の息は早離し、ほかは完了の 0.3 秒後に離す
  });
  ev.push({ t: 33.5, b: 'A', down: true }, { t: 33.55, b: 'A', down: false }); // 余分な入力
  ev.push({ t: 10.17, b: 'B', down: true }, { t: 10.2, b: 'B', down: false });  // 間違ったボタン（構の時刻に 旋）
  ev.push({ t: byId.n055.t + 0.03, b: 'B', down: true }, { t: byId.n055.t + 0.08, b: 'B', down: false }); // 入力なしの構の時刻にボタン違い
  await startPlay(p);
  await p.evaluate((ev) => window.__run(90, ev), ev);
  const R = await p.evaluate(() => window.__lastRecord);
  const m = Object.fromEntries(R.notes.map((n) => [n.id, n]));
  check(R.kind === 'full' && R.mode === 'manual' && R.notes.length === 59, '最後まで: 手動の通しプレイとして 59 ノーツを記録', `${R.kind} ${R.mode} ${R.notes.length}`);
  check(m.n074.result === 'PERFECT' && m.n074.input.deltaMs === -60 && m.n050.result === 'GOOD' && m.n050.input.deltaMs === 60.1 && m.n004.result === 'GOOD' && m.n004.input.deltaMs === 120,
    '境界: −60ms は PERFECT（境界上）、+60.1ms は GOOD（直後）、+120ms は GOOD（境界上）', `${m.n074.result} ${m.n050.result} ${m.n004.result}`);
  check(m.n051.result === 'MISS' && m.n051.input?.deltaMs === 120.1 && m.n052.result === 'MISS' && m.n052.input === null,
    '+120.1ms は入力ありの MISS、−180.1ms（許容限界の外）は余分な入力になり、ノーツは入力なしの MISS', `${m.n051.input?.deltaMs} / ${JSON.stringify(m.n052.input)}`);
  check(m.n075.input.deltaMs === -25 && m.n053.input.deltaMs === 33, '早い入力はマイナス、遅い入力はプラス（ms）');
  check(m.n055.result === 'MISS' && m.n055.input === null && m.n055.reason === 'timeout', '入力なしの MISS に時刻・ずれを入れない');
  check(m.n052.input === null && R.extras.some((x) => x.button === 'A' && Math.abs(x.time - (byId.n052.t - 0.1801)) < 1e-3) && R.extras.some((x) => x.button === 'A' && x.time === 33.5) && R.extras.some((x) => x.button === 'B' && x.time === 10.17),
    '余分な入力（判定範囲外・間違ったボタン）を記録し、ノーツに付け替えない', `${R.extras.length} 件`);
  check(m.n065.result === 'PERFECT' && m.n066.result !== 'MISS' && m.n086.input && m.n081.input, '同時入力（44.83 秒 構と息）・長押し中の別ボタン（30.04・64.3 秒）もそれぞれ記録');
  const h0 = m[holds[0].id].hold, h1 = m[holds[1].id].hold;
  check(m[holds[0].id].result === 'MISS' && h0.status === 'early-release' && Math.abs(h0.releasedAt - (holds[0].t + holds[0].d * 0.5)) < 1e-3, '長押しの早離し: 離した時刻と途中解除を記録', JSON.stringify(h0));
  check(m[holds[1].id].result !== 'MISS' && h1.status === 'completed-released' && Math.abs(h1.releasedAt - (holds[1].t + holds[1].d + 0.3)) < 1e-3 && Math.abs(h1.completedAt - (holds[1].t + holds[1].d)) < 1e-3 && Math.abs(h1.heldSec - (holds[1].d + 0.28)) < 1e-3,
    '長押しの完了: 完了の時刻と、実際に離した時刻・保持時間を分けて記録', JSON.stringify(h1));
  check(R.devices.includes('keyboard') && R.devices.includes('touch') && m.n052.input === null && m.n075.input.device === 'touch', '入力方法（キーボード・タッチ）を記録');
  // 成績画面の数値 = 記録から数えた値
  const ui = await p.evaluate(() => [...document.querySelectorAll('.res-grid > div')].map((d) => d.textContent.replace(/\s+/g, ' ').trim()));
  const s = R.summary;
  const cnt = (r) => R.notes.filter((n) => n.result === r).length;
  const deltas = R.notes.filter((n) => n.input).map((n) => n.input.deltaMs);
  const mae = Math.round(deltas.reduce((a, v) => a + Math.abs(v), 0) / deltas.length * 10) / 10;
  check(s.perfect === cnt('PERFECT') && s.good === cnt('GOOD') && s.miss === cnt('MISS') && s.maeMs === mae && s.timed === deltas.length, '集計値が入力記録と一致（件数・平均絶対誤差・対象件数）', `MAE ${s.maeMs}`);
  const has = (re) => ui.some((t) => re.test(t));
  check(has(new RegExp(`PERFECT\\s*${s.perfect}$`)) && has(new RegExp(`GOOD\\s*${s.good}$`)) && has(new RegExp(`MISS\\s*${s.miss}\\s*入力なし ${s.missNoInput}・範囲外の入力 ${s.missWithInput}`)) && has(new RegExp(`平均絶対誤差\\s*${s.maeMs.toFixed(1)}ms`)),
    '成績画面の表示が記録の集計と一致', ui.slice(3, 7).join(' | '));
  await p.click('[data-tab=timing]');
  const g = await p.evaluate(() => ({ pts: document.querySelectorAll('.res-graph g[data-note]').length, none: document.querySelector('.res-none b').textContent, perfect: document.querySelectorAll('.res-graph g.g-perfect[data-note]').length }));
  check(g.pts === s.timed && new RegExp(`${s.missNoInput} 件`).test(g.none) && g.perfect === s.perfect, 'グラフ: 入力のあったノーツだけ点で描き、入力なしの MISS は別に表示', `${g.pts} 点 / ${g.none}`);
  await p.click('[data-filter=X]'); await p.click('[data-filter=A]'); await p.click('[data-filter=B]');
  const gy = await p.evaluate(() => document.querySelectorAll('.res-graph g[data-note]').length);
  check(gy === s.byCmd.Y.timed, '技で絞り込み（息だけ）', `${gy}`);
  await p.click('[data-filter=X]'); await p.click('[data-filter=A]'); await p.click('[data-filter=B]');
  // 凡例（グラフと同じ表示設定から）
  const lg = await p.evaluate(() => ({ text: document.querySelector('.res-legend')?.textContent || '', cls: [...document.querySelectorAll('.res-legend g')].map((g) => g.getAttribute('class')) }));
  check(/● PERFECT/.test(lg.text) && /▲ GOOD/.test(lg.text) && /✕ MISS/.test(lg.text) && /PERFECT の範囲（±60ms）/.test(lg.text) && /GOOD の範囲（±120ms）/.test(lg.text) && /正解の時刻（0ms）/.test(lg.text) && /早押し/.test(lg.text) && /遅押し/.test(lg.text)
    && lg.cls.includes('g-perfect cur') && lg.cls.includes('g-good cur') && lg.cls.includes('g-miss cur'), 'タイミングの凡例: 記号・色（グラフと同じクラス）・判定範囲・0ms・早い／遅い', lg.text.slice(0, 80));
  // ノーツ詳細（画像つきカード）
  await p.click('[data-tab=detail]');
  await p.waitForTimeout(1500);
  const card = (id) => p.evaluate((id) => { const c = document.querySelector(`.nc[data-note="${id}"]`); return c ? { text: c.textContent.replace(/\s+/g, ' '), frames: [...c.querySelectorAll('canvas')].map((x) => Number(x.dataset.frame)), none: !!c.querySelector('.nc-none') } : null; }, id);
  const det = await p.evaluate(() => ({ n: document.querySelectorAll('.nc').length, pos: document.querySelector('.nc-pos').textContent, ready: [...document.querySelectorAll('.nc canvas')].filter((c) => c.dataset.ready).length,
    over: document.scrollingElement.scrollWidth - window.innerWidth, inner: (() => { const c = document.querySelector('.card.results'); return c.scrollWidth - c.clientWidth; })() }));
  check(det.n === 59 && det.pos === '1／59件' && det.ready >= 4 && det.over <= 0 && det.inner <= 0, 'カード 59 枚を時間順に横並び、位置「1／59件」、画像を描画、ページの横はみ出しなし', JSON.stringify(det));
  await p.click('[data-nav="1"]'); await p.waitForTimeout(700);
  check(await p.textContent('.nc-pos') === '2／59件', '▶ で次のカード（2／59件）');
  const c75 = await card('n075'), c53 = await card('n053'), c50 = await card('n050'), c52 = await card('n052'), c55 = await card('n055');
  const fr = await p.evaluate((ids) => ids.map(([id, t]) => window.__app.store.indexAt(t)), [['n075', byId.n075.t], ['n075i', byId.n075.t - 0.025]]);
  check(/正解 撃／A 21\.720 秒/.test(c75.text) && /入力 A を 21\.695 秒/.test(c75.text) && /25\.0ms 早い → ● PERFECT/.test(c75.text) && c75.frames[0] === fr[0] && c75.frames[1] === fr[1] && /正解時 21\.720 秒/.test(c75.text) && /入力時 21\.695 秒/.test(c75.text),
    '早押し: 正解（撃／A 21.720 秒）・入力（A 21.695 秒）・25.0ms 早い → PERFECT。正解時と入力時の画像はフレーム時刻表のコマ', c75.text.slice(0, 120));
  check(/33\.0ms 遅い → ● PERFECT/.test(c53.text) && /60\.1ms 遅い → ▲ GOOD/.test(c50.text), '遅押しの表示（33.0ms 遅い → PERFECT、60.1ms 遅い → GOOD）');
  check(/入力なし → ✕ MISS/.test(c52.text) && c52.frames.length === 1 && c52.none && /判定範囲の外・判定に使っていない/.test(c52.text), '判定範囲の外の入力: ノーツは入力なし（入力時の画像は作らない）、近くの入力は「判定に使っていない」と表示');
  check(/入力なし → ✕ MISS（ボタン違いの入力あり）/.test(c55.text) && /押したボタン 旋／B/.test(c55.text) && /要求は 構／X/.test(c55.text), 'ボタン違い: 要求されたボタン（構／X）と押したボタン（旋／B）を区別');
  const c65 = await card('n065'), c66 = await card('n066');
  check(/判定に採用/.test(c65.text) && /判定に採用/.test(c66.text) && /入力 X を/.test(c65.text) && /入力 Y を/.test(c66.text), '同時入力: それぞれのカードに採用した入力');
  const ch0 = await card(holds[0].id), ch1 = await card(holds[1].id);
  check(/早離し あり（途中解除）/.test(ch0.text) && /解除 13\.030 秒/.test(ch0.text) && /保持時間 必要 1\.85 秒 ／ 実際 0\.98 秒/.test(ch0.text) && /正解の開始・終了 12\.030 〜 14\.030 秒/.test(ch0.text),
    '長押し（早離し）: 正解の開始・終了、押下・解除、保持時間、早離し', ch0.text.slice(-260));
  check(/早離し なし/.test(ch1.text) && /保持して成功/.test(ch1.text) && /解除 18\.250 秒（終了から \+300\.0ms）/.test(ch1.text), '長押し（完了後に離した）: 解除の時刻と成功の時刻を分けて表示');
  // ---------- 照合タイムライン（編集画面と同じ時間軸） ----------
  const tl = await p.evaluate(() => {
    const a = window.__app, r = window.__lastRecord, T = window.__tl;
    const X = (t) => T.pad + t * T.pps;
    const svg = document.querySelector('.tl-scroll svg');
    const marks = Object.fromEntries([...svg.querySelectorAll('g.tl-item[data-sel^="note:"]')].map((g) => {
      const m = g.querySelector('.tl-nmark');
      const adopted = g.querySelector('g.cur');
      const shape = adopted?.firstElementChild;
      const sx = shape ? (() => { const b = shape.getBBox(); return b.x + b.width / 2; })() : null;
      return [g.dataset.sel.slice(5), { nx: +m.getAttribute('x') + 4, ny: +m.getAttribute('y'), shapeX: sx, shapeY: shape ? +(shape.getAttribute('cy') ?? 0) : null, held: g.querySelector('.tl-held') ? { x: +g.querySelector('.tl-held').getAttribute('x'), w: +g.querySelector('.tl-held').getAttribute('width') } : null, nomiss: !!g.querySelector('.tl-nomiss') }];
    }));
    const ticks = [...svg.querySelectorAll('line.tl-tick1')].map((l) => +l.getAttribute('x1'));
    const extras = [...svg.querySelectorAll('g.tl-item[data-sel^="extra:"] circle')].map((c) => ({ x: +c.getAttribute('cx'), y: +c.getAttribute('cy') }));
    const xRow = T.rows.find((x) => x.key === 'x');
    return { T, dur: a.duration, recDur: r.chart.duration, marks, ticks: ticks.slice(0, 6), X5: X(5), X10: X(10), extras, xRow,
      notes: r.notes.map((n) => ({ id: n.id, b: n.button, t: n.time, it: n.input?.time ?? null, miss: n.result === 'MISS' && !n.input, hold: n.hold ? { p: n.hold.pressedAt, r: n.hold.releasedAt ?? n.hold.completedAt ?? n.hold.end } : null })),
      ex: r.extras.map((x) => x.time), chartTimes: a.chart.notes.map((n) => [n.id, n.time]) };
  });
  const X = (t) => tl.T.pad + t * tl.T.pps;
  const posOk = tl.notes.every((n) => Math.abs(tl.marks[n.id].nx - X(n.t)) < 0.6 && (n.it == null ? tl.marks[n.id].shapeX == null : Math.abs(tl.marks[n.id].shapeX - X(n.it)) < 0.6));
  const sameAsEditor = tl.chartTimes.every(([id, t]) => Math.abs(tl.marks[id].nx - X(t)) < 0.6);
  check(Math.abs(tl.T.dur - tl.dur) < 0.001 && tl.recDur === Math.round(tl.dur * 1000) / 1000 && tl.T.rows[0].key === 'n:Y' && tl.T.rows[1].key === 'i:Y' && tl.T.rows.at(-1).key === 'x',
    '照合タイムライン: 0 秒〜演武の終わり（82.3 秒）、技ごとに「正解」と「入力」の段（上から Y・X・A・B）、最後に不採用の段', `${tl.T.dur} 秒 記録 ${tl.recDur} rows ${tl.T.rows.map((x) => x.key)}`);
  const badPos = tl.notes.filter((n) => !(Math.abs(tl.marks[n.id].nx - X(n.t)) < 0.6 && (n.it == null ? tl.marks[n.id].shapeX == null : Math.abs(tl.marks[n.id].shapeX - X(n.it)) < 0.6))).map((n) => `${n.id}:${tl.marks[n.id].nx}/${X(n.t)}:${tl.marks[n.id].shapeX}/${n.it == null ? '-' : X(n.it)}`);
  check(posOk && sameAsEditor, `正解のノーツは譜面の時刻、採用した入力は入力時刻の横位置（同じ時刻 = 同じ横位置。編集画面の譜面と一致）`, badPos.slice(0, 4).join(' '));
  check(Math.abs(tl.ticks[5] - tl.X5) < 0.6 && tl.ticks.length === 6, '目盛りは 1 秒ごと（編集画面と同じ timeline.js の目盛り）', tl.ticks.join(','));
  const noIn = tl.notes.filter((n) => n.miss);
  check(noIn.length > 0 && noIn.every((n) => tl.marks[n.id].nomiss && tl.marks[n.id].shapeX == null), '入力なしの MISS は正解の段に ✕、入力の段には何も描かない（架空の入力位置を作らない）', `${noIn.length} 件`);
  check(tl.extras.length === tl.ex.length && tl.extras.every((e, i) => Math.abs(e.x - X(tl.ex[i])) < 0.6 && e.y > tl.xRow.y && e.y < tl.xRow.y + tl.xRow.h), '不採用・余分な入力は専用の段に入力時刻の位置で表示', `${tl.extras.length} 件`);
  const hn = tl.notes.filter((n) => n.hold && n.hold.p != null);
  check(hn.length >= 2 && hn.every((n) => tl.marks[n.id].held && Math.abs(tl.marks[n.id].held.x - X(n.hold.p)) < 0.6 && Math.abs(tl.marks[n.id].held.x + tl.marks[n.id].held.w - X(n.hold.r)) < 0.8), '長押し: 実際に押していた区間（押下〜解除）を入力の段に表示');
  // 文字が重ならない（拡大率を変えても）
  const textOverlap = () => p.evaluate(() => {
    const ts = [...document.querySelectorAll('.tl-scroll svg text')].map((t) => t.getBBox());
    let bad = 0;
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) { const a = ts[i], b = ts[j]; if (a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5) bad++; }
    return { n: ts.length, bad, pps: window.__tl.pps };
  });
  const ov = [await textOverlap()];
  await p.click('[data-zoom=fit]'); ov.push(await textOverlap());
  for (let i = 0; i < 12; i++) await p.click('[data-zoom="1"]');
  ov.push(await textOverlap());
  check(ov.every((o) => o.bad === 0) && ov[2].pps === 1000, '照合タイムラインの文字は重ならない（初期・全体・最大拡大 1 秒 = 1000px）', ov.map((o) => `${o.pps}px/s 文字${o.n} 重なり${o.bad}`).join(' / '));
  // 拡大・縮小で中央の時刻を保つ。最大拡大では 10ms = 10px
  await p.evaluate(() => window.__app.results.select('note', 'n075', 'card'));
  const zc = await p.evaluate(() => { const sc = document.querySelector('.tl-scroll'), T = window.__tl; return (sc.scrollLeft + sc.clientWidth / 2 - T.pad) / T.pps; });
  await p.click('[data-zoom="-1"]');
  const zc2 = await p.evaluate(() => { const sc = document.querySelector('.tl-scroll'), T = window.__tl; return { t: (sc.scrollLeft + sc.clientWidth / 2 - T.pad) / T.pps, pps: T.pps }; });
  check(Math.abs(zc - 21.7) < 0.1 && Math.abs(zc2.t - zc) < 0.05 && zc2.pps === 640, '拡大・縮小しても中央の時刻（選んだノーツ）を保つ', `${zc.toFixed(3)} → ${zc2.t.toFixed(3)} 秒`);
  // 選択の連動: タイムライン → 画像・カード、カード → タイムライン
  await p.click('[data-zoom=fit]');
  await p.click('.tl-scroll [data-sel="note:n050"] .tl-nmark', { force: true });
  await p.waitForTimeout(800);
  const sel = await p.evaluate(() => {
    const c = document.querySelector('.nc.is-sel'), sc = document.querySelector('.nc-scroller');
    const cr = c?.getBoundingClientRect(), sr = sc.getBoundingClientRect();
    return { card: c?.dataset.note, visible: !!c && cr.left >= sr.left - 2 && cr.right <= sr.right + 2, txt: document.querySelector('.tl-sel').textContent.replace(/\s+/g, ' '), imgs: [...document.querySelectorAll('.tl-sel canvas')].map((x) => x.dataset.frame) };
  });
  await p.waitForFunction(() => [...document.querySelectorAll('.tl-sel canvas')].every((c) => c.dataset.ready), null, { timeout: 5000 }).catch(() => {});
  const selReady = await p.evaluate(() => [...document.querySelectorAll('.tl-sel canvas')].every((c) => c.dataset.ready));
  const f50 = await p.evaluate(() => { const n = window.__lastRecord.notes.find((x) => x.id === 'n050'); return [window.__app.store.indexAt(n.time), window.__app.store.indexAt(n.input.time)].map(String); });
  check(sel.card === 'n050' && sel.visible && /選択: n050/.test(sel.txt) && sel.imgs.join() === f50.join() && selReady, 'タイムラインで選ぶと、その時刻の主人公の画像（正解時・入力時）と詳細カードへ連動', JSON.stringify(sel).slice(0, 140));
  await p.click('.nc[data-note="n052"] header');
  await p.waitForTimeout(400);
  const back = await p.evaluate(() => { const g = document.querySelector('.tl-scroll .tl-item.is-sel'), sc = document.querySelector('.tl-scroll'), T = window.__tl; const n = window.__lastRecord.notes.find((x) => x.id === 'n052'); const x = T.pad + n.time * T.pps; return { sel: g?.dataset.sel, inView: x >= sc.scrollLeft && x <= sc.scrollLeft + sc.clientWidth }; });
  check(back.sel === 'note:n052' && back.inView, 'カードを押すとタイムラインのその位置を選択・表示', JSON.stringify(back));
  await p.evaluate(() => window.__app.results.select('extra', '0', 'tl'));
  await p.waitForTimeout(300);
  const exSel = await p.evaluate(() => document.querySelector('.tl-sel').textContent.replace(/\s+/g, ' '));
  const ex0 = await p.evaluate(() => { const x = window.__lastRecord.extras[0]; return `${x.cmd}／${x.button} を ${x.time.toFixed(3)} 秒`; });
  check(/不採用の入力/.test(exSel) && exSel.includes(ex0) && /判定にも使っていません/.test(exSel), '不採用の入力を選ぶと、その時刻と画像（判定に使っていないことを明示）', exSel.slice(0, 80));
  // カード: 同じ行のカードの高さと項目の位置がそろう・文字が重ならない・表示枚数
  const al = await p.evaluate(() => {
    const sc = document.querySelector('.nc-scroller'), cs = [...sc.querySelectorAll('.nc')];
    const hs = new Set(cs.map((c) => Math.round(c.getBoundingClientRect().height)));
    const rowTops = (c) => [...c.children].map((e) => Math.round(e.getBoundingClientRect().top - c.getBoundingClientRect().top));
    const t0 = JSON.stringify(rowTops(cs[0]));
    const same = cs.every((c) => JSON.stringify(rowTops(c)) === t0);
    let bad = 0;
    for (const svg of sc.querySelectorAll('.nc-axis')) {
      const ts = [...svg.querySelectorAll('text')].map((t) => t.getBBox());
      for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) { const a = ts[i], b = ts[j]; if (a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5) bad++; }
    }
    const clip = cs.filter((c) => c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1).length;
    return { heights: [...hs], same, children: cs[0].children.length, bad, clip, perView: Math.round(sc.clientWidth / cs[0].getBoundingClientRect().width * 10) / 10 };
  });
  check(al.heights.length === 1 && al.same && al.children === 11, 'カード: 高さがそろい、見出し・画像・正解・入力・判定の位置がすべてのカードで同じ', JSON.stringify(al));
  check(al.bad === 0 && al.clip === 0, 'カード: 小さな時間軸の「正解」「採用」「不採用」の文字が重ならない・内容が切れない', `重なり ${al.bad}・はみ出し ${al.clip}`);
  check(al.perView >= 2.9 && al.perView < 3.3, 'PC では最大 3 枚が並ぶ', `${al.perView} 枚分`);
  // 過去の譜面（今と違う譜面・長さの記録なし）: 記録のノーツの時刻で表示（今の譜面から計算し直さない）
  const pastTl = await p.evaluate(() => {
    const r = structuredClone(window.__lastRecord); r.id = 'past-chart'; delete r.chart.duration; r.chart.hash = 'deadbeef';
    for (const n of r.notes) { n.time = Math.round((n.time + 0.5) * 1000) / 1000; if (n.hold) n.hold.end += 0.5; }
    window.__app.results.show(r, { tab: 'detail' });
    const T = window.__tl, g = document.querySelector('.tl-scroll [data-sel="note:n074"] .tl-nmark');
    return { x: +g.getAttribute('x') + 4, want: T.pad + r.notes.find((n) => n.id === 'n074').time * T.pps, dur: T.dur };
  });
  check(Math.abs(pastTl.x - pastTl.want) < 0.6 && pastTl.dur >= 80, '過去の記録はその記録の譜面の時刻で表示（今の譜面で計算し直さない）', JSON.stringify(pastTl));
  await p.evaluate((id) => window.__app.results.show(window.__app.history.get(id), { tab: 'detail' }), R.id);
  await p.waitForTimeout(400);
  await p.click('[data-grade=MISS]');
  const nm = await p.evaluate(() => ({ n: document.querySelectorAll('.nc').length, pos: document.querySelector('.nc-pos').textContent, all: [...document.querySelectorAll('.nc')].every((c) => c.dataset.grade === 'MISS') }));
  check(nm.n === s.miss && nm.all && nm.pos === `1／${s.miss}件`, '判定で絞り込み（MISS）', JSON.stringify(nm));
  await p.click('[data-filter=X]'); await p.click('[data-filter=A]'); await p.click('[data-filter=B]');
  const ny = await p.evaluate(() => document.querySelectorAll('.nc').length);
  check(ny === R.notes.filter((n) => n.result === 'MISS' && n.button === 'Y').length, '判定と技で絞り込み（MISS × 息）', `${ny}`);
  await p.click('[data-filter=X]'); await p.click('[data-filter=A]'); await p.click('[data-filter=B]'); await p.click('[data-grade=all]');
  // 古い成績（必要な記録がない）: 推測で補わず「記録なし」
  const old = await p.evaluate(() => {
    const r = structuredClone(window.__lastRecord);
    r.id = 'old-test'; delete r.extras;
    for (const n of r.notes) { delete n.frames; if (n.input) { delete n.input.raw; delete n.input.rawDeltaMs; delete n.input.device; } if (n.hold) { delete n.hold.releasedAt; delete n.hold.heldSec; delete n.hold.status; } }
    window.__app.results.show(r, { tab: 'detail' });
    return new Promise((res) => setTimeout(() => { const c = document.querySelector('.nc[data-note="n049"]').textContent; res({ c, ex: document.querySelector('.nc-scroller ~ .res-scroll caption').textContent }); }, 300));
  });
  check(/補正前の時刻: 記録なし/.test(old.c) && /入力方法の記録なし/.test(old.c) && /解除記録なし/.test(old.c.replace(/\s/g, '')) && /早離し 記録なし/.test(old.c) && /記録なし/.test(old.ex), '古い成績で記録がない項目は「記録なし」（推測で補わない）');
  // 過去の成績は、その時の判定条件で表示（今の設定から再計算しない）
  const past = await p.evaluate(() => {
    const r = structuredClone(window.__lastRecord); r.id = 'past-cond'; r.settings = { ...r.settings, perfectWindowMs: 45, goodWindowMs: 90 };
    window.__app.results.show(r, { tab: 'timing' });
    return document.querySelector('.res-legend').textContent;
  });
  check(/PERFECT の範囲（±45ms）/.test(past) && /GOOD の範囲（±90ms）/.test(past), '過去の成績はその時の判定条件（±45／±90ms）で表示', past.slice(0, 60));
  await p.evaluate((id) => window.__app.results.show(window.__app.history.get(id)), R.id);
  const best1 = R;

  // 2 回目: 少し上達（同条件）→ 前回との比較
  await p.evaluate(() => window.__app.retry());
  await harness(p);
  const ev2 = notes.filter((n) => n.input !== 'hold').flatMap((n) => [{ t: n.t + 0.01, b: n.b, down: true }, { t: n.t + 0.06, b: n.b, down: false }]);
  for (const h of holds) ev2.push({ t: h.t, b: 'Y', down: true }, { t: h.t + h.d + 0.1, b: 'Y', down: false });
  await startPlay(p);
  await p.evaluate((ev) => window.__run(90, ev), ev2);
  const R2 = await p.evaluate(() => window.__lastRecord);
  await p.click('[data-tab=compare]');
  let cmp = await p.evaluate(() => document.querySelector('#resultBody').textContent);
  check(R2.kind === 'full' && /同じ条件の記録です/.test(cmp) && /スコアの差/.test(cmp) && /改善/.test(cmp) && best1.id !== R2.id, '前回（同条件）と比較: スコア差・成功率の差・平均絶対誤差の改善量');
  const pairs = await p.evaluate(() => document.querySelectorAll('.res-graph line.pair').length);
  check(pairs > 40, '同じ譜面: 同じノーツの前回と今回の入力位置を同じ目盛りで比較', `${pairs} 本`);

  // AUTO（自己ベスト・前回の候補から除外）と練習（シーク）
  await p.evaluate(() => window.__app.retry());
  await harness(p);
  await p.evaluate(() => window.__app.setAuto(true));
  await startPlay(p);
  await p.evaluate(() => window.__run(90));
  const RA = await p.evaluate(() => window.__lastRecord);
  await p.evaluate(() => window.__app.setAuto(false));
  await p.evaluate(() => window.__app.retry());
  await harness(p);
  await startPlay(p);
  await p.evaluate(() => { window.__run(20, [{ t: 10.17, b: 'X', down: true }, { t: 10.2, b: 'X', down: false }]); window.__app.seek(40); window.__run(90); });
  const RP = await p.evaluate(() => window.__lastRecord);
  const targets = await p.evaluate(async () => { const { comparisonTargets } = await import('/app/score.js'); const a = window.__app, h = a.history.records; const cur = h.at(-1); return comparisonTargets({ ...cur, kind: 'full', id: 'probe', at: new Date(Date.now() + 1000).toISOString() }, h); });
  check(RA.mode === 'auto' && RP.kind === 'practice' && RP.practiceReasons.includes('seek'), 'AUTO は AUTO、シークしたプレイは練習として記録', `${RA.mode} / ${RP.kind}`);
  check(targets.best.id === R2.id && targets.previous.id === R2.id, 'AUTO と練習は同条件の自己ベスト・前回（通しプレイ）に入らない', `${targets.best?.id} ${targets.previous?.id}`);
  // 条件の違い（再生速度 0.5×）
  await p.evaluate(() => window.__app.retry());
  await harness(p);
  await p.evaluate(() => window.__app.setRate(0.5));
  await startPlay(p);
  await p.evaluate((ev) => window.__run(90, ev), ev2);
  const RS = await p.evaluate(() => window.__lastRecord);
  await p.selectOption('[data-tab=compare]', { index: 0 }).catch(() => {});
  await p.click('[data-tab=compare]');
  await p.selectOption('[data-compare]', R2.id);
  cmp = await p.evaluate(() => document.querySelector('#resultBody').textContent);
  check(RS.rate === 0.5 && RS.kind === 'full' && /条件が違います/.test(cmp) && /再生速度 1 → 0.5/.test(cmp) && /実際に経過した時間はこの 2.0 倍/.test(await p.evaluate(() => { document.querySelector('[data-tab=summary]').click(); return document.querySelector('#resultBody').textContent; })),
    '速度 0.5×: 記録に速度、条件の違いを明示、ms の基準（譜面の時間軸）を表示');
  const rs = await p.evaluate(() => window.__lastRecord.notes.find((n) => n.id === 'n074').input.deltaMs);
  check(rs === 10, '速度 0.5× でもずれは判定と同じ時間軸の ms', `${rs}`);
  await p.evaluate(() => window.__app.setRate(1));
  // 入力補正: 生の時刻と補正後の時刻を区別
  await p.evaluate(() => { const a = window.__app; a.editor.apply((c) => { c.settings.inputOffsetMs = 20; }, 'test', { rejudge: false }); a.retry(); });
  await harness(p);
  await startPlay(p);
  await p.evaluate(() => window.__run(12, [{ t: 10.17 + 0.03, b: 'X', down: true }, { t: 10.25, b: 'X', down: false }]));
  const off = await p.evaluate(() => { const n = window.__app.judge.notes.find((x) => x.id === 'n074'); return n.hit; });
  check(off.deltaMs === 10 && off.rawDeltaMs === 30, '入力補正 +20ms: 判定は補正後（+10ms）、生の時刻（+30ms）も残す', JSON.stringify({ d: off.deltaMs, raw: off.rawDeltaMs }));
  // 一時停止中の入力は記録しない・再開で続く
  await p.evaluate(() => { const a = window.__app; a.pause(); a.onPress('X', 0, { id: 'paused1', source: 'key', device: 'keyboard' }); a.onRelease('X', 0, { source: 'key' }); });
  const pausedStray = await p.evaluate(() => window.__app.judge.strays.length);
  check(pausedStray === 0, '一時停止中の入力は判定・記録しない');
  await p.evaluate(() => { const a = window.__app; a.editor.apply((c) => { c.settings.inputOffsetMs = 0; }, 'test', { rejudge: false }); a.retry(); });

  // 履歴: 再読み込み・書き出し → 消す → 読み込み・削除
  const n0 = await p.evaluate(() => window.__app.history.records.length);
  await p.reload(); await ready(p);
  const n1 = await p.evaluate(() => window.__app.history.records.length);
  check(n1 === n0 && n1 >= 5, '再読み込み後も履歴が残る', `${n0} → ${n1}`);
  await p.click('#btnScores');
  await p.click('[data-tab=history]');
  await p.click('[data-act=exportAll]');
  const text = await p.evaluate(() => window.__lastScoreExport);
  await p.evaluate(() => { localStorage.removeItem('kiva2d.v2.history'); window.__app.history.load(); });
  await p.setInputFiles('[data-import]', { name: 'scores.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await p.waitForTimeout(200);
  const n2 = await p.evaluate(() => ({ n: window.__app.history.records.length, msg: document.querySelector('#histMsg').textContent, same: JSON.stringify(window.__app.history.records) }));
  check(n2.n === n1 && /追加 \d+ 件/.test(n2.msg) && n2.same === JSON.stringify(JSON.parse(text).records), '書き出した履歴を読み込むと元どおり', n2.msg);
  const chartText = await p.evaluate(async () => (await import('/app/chart.js')).exportChart(window.__app.chart));
  await p.setInputFiles('[data-import]', { name: 'chart.json', mimeType: 'application/json', buffer: Buffer.from(chartText) });
  await p.waitForTimeout(200);
  const bad = await p.evaluate(() => ({ msg: document.querySelector('#histMsg').textContent, n: window.__app.history.records.length, notes: window.__app.chart.notes.length }));
  check(/譜面 JSON/.test(bad.msg) && bad.n === n1 && bad.notes === 59, '譜面 JSON は成績として読み込まない（譜面・履歴とも変わらない）', bad.msg);
  await p.check(`[data-sel="${RA.id}"]`);
  await p.click('[data-act=deleteSel]');
  const n3 = await p.evaluate((id) => ({ n: window.__app.history.records.length, has: !!window.__app.history.get(id), stored: JSON.parse(localStorage.getItem('kiva2d.v2.history')).records.length }), RA.id);
  check(n3.n === n1 - 1 && !n3.has && n3.stored === n1 - 1, '選択した履歴を削除');
  // 既存の譜面・保存データ
  const keep = await p.evaluate(() => ({ notes: window.__app.chart.notes.length, eff: window.__app.chart.notes.find((n) => n.id === 'n075').effect, bgm: JSON.parse(localStorage.getItem('kiva2d.v2.audio') || '{}').bgm ?? 'devil' }));
  check(keep.notes === 59 && keep.eff?.angle === 90 && keep.eff.offset?.x === 0.11, '既存の 59 ノーツと個別エフェクトはそのまま');
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await ctx.close();
}

// ---------- 3. 保存できないとき: 表示と JSON の退避 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 } });
  const p = await ctx.newPage();
  await p.goto(base); await ready(p);
  await harness(p);
  await p.evaluate(() => { const s = window.__app.history.storage; window.__app.history.storage = { getItem: (k) => s.getItem(k), setItem: () => { const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } }; });
  await startPlay(p);
  await p.evaluate(() => window.__run(90, [{ t: 10.17, b: 'X', down: true }, { t: 10.2, b: 'X', down: false }]));
  const w = await p.evaluate(() => document.querySelector('.res-warn')?.textContent || '');
  let saved = null;
  p.on('download', (d) => { saved = d.suggestedFilename(); });
  await p.click('[data-act=exportOne]');
  await p.waitForTimeout(300);
  const ex = await p.evaluate(() => JSON.parse(window.__lastScoreExport || 'null'));
  check(/保存できませんでした/.test(w) && /いっぱい/.test(w) && ex?.records?.length === 1 && ex.records[0].notes.length === 59 && /^seipai-v2-score-/.test(saved || ''), '保存できないときは表示し、成績を JSON で退避できる', saved || '');
  // スマホ縦: カードは 1 枚ずつ（横にスクロール）、照合タイムラインはページを横にはみ出さない
  await p.click('[data-tab=detail]'); await p.waitForTimeout(800);
  const ph = await p.evaluate(() => { const sc = document.querySelector('.nc-scroller'), c = sc.querySelector('.nc'); return { per: Math.round(sc.clientWidth / c.getBoundingClientRect().width * 10) / 10, over: document.scrollingElement.scrollWidth - window.innerWidth, inner: (() => { const k = document.querySelector('.card.results'); return k.scrollWidth - k.clientWidth; })(), tl: document.querySelector('.tl-scroll').scrollWidth > document.querySelector('.tl-scroll').clientWidth }; });
  check(ph.per < 1.3 && ph.over <= 0 && ph.inner <= 0 && ph.tl, 'スマホ縦: カードは 1 枚ずつ表示して横にスクロール、照合タイムラインは枠の中で横スクロール（ページははみ出さない）', JSON.stringify(ph));
  await ctx.close();
}

await browser.close();
console.log(fails.length ? `\nNG ${fails.length} 件` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
