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
  const g = await p.evaluate(() => ({ pts: document.querySelectorAll('.res-graph g[data-note]').length, none: document.querySelector('.res-none b').textContent, perfect: document.querySelectorAll('.res-graph g.g-perfect').length }));
  check(g.pts === s.timed && new RegExp(`${s.missNoInput} 件`).test(g.none) && g.perfect === s.perfect, 'グラフ: 入力のあったノーツだけ点で描き、入力なしの MISS は別に表示', `${g.pts} 点 / ${g.none}`);
  await p.click('[data-filter=X]'); await p.click('[data-filter=A]'); await p.click('[data-filter=B]');
  const gy = await p.evaluate(() => document.querySelectorAll('.res-graph g[data-note]').length);
  check(gy === s.byCmd.Y.timed, '技で絞り込み（息だけ）', `${gy}`);
  await p.click('[data-filter=X]'); await p.click('[data-filter=A]'); await p.click('[data-filter=B]');
  await p.click('[data-tab=detail]');
  const det = await p.evaluate(() => ({ rows: document.querySelectorAll('.res-detail tbody tr:not(.hold-row)').length, hold: document.querySelectorAll('.res-detail .hold-row').length, text: document.querySelector('.res-detail').textContent }));
  check(det.rows === 59 && det.hold === holds.length && /早離し/.test(det.text) && /離した時刻/.test(det.text), '詳細: 59 ノーツの ID・技・正解時刻・入力時刻・ずれ・判定。長押しは開始・終了・保持状況を別の行に');
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
  await ctx.close();
}

await browser.close();
console.log(fails.length ? `\nNG ${fails.length} 件` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
