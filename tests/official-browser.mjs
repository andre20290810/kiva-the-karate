// 公式データの更新（パスワード認証）・公式デモ・リプレイの確認（実素材が必要）。
//   ローカル: OFFICIAL_DEV_PASSWORD=<試験用> node tools/serve.mjs 8177（別ターミナル）→ OFFICIAL_TEST_PASSWORD=<同じ値> node tests/official-browser.mjs
//   公開版:   BASE=https://… OFFICIAL_TEST_PASSWORD=<公開版のパスワード> node tests/official-browser.mjs（公開・復元を 1 回ずつ行い、元の内容に戻す）
// パスワードはリポジトリ・ログに出さない（環境変数で渡す）。
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const PASS = process.env.OFFICIAL_TEST_PASSWORD || '';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const fails = [];
const check = (ok, msg, extra = '') => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}${extra ? ` ${extra}` : ''}`); if (!ok) fails.push(msg); };
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}) });
const ready = (p) => p.waitForFunction(() => ['ready', 'paused', 'playing'].includes(window.__app?.state), null, { timeout: 120000 });

/** 時計を手で進める（音声なし・コマ送り） */
const harness = (p) => p.evaluate(() => {
  const a = window.__app;
  cancelAnimationFrame(a._raf); a.raf = () => {};
  a.__T = -2;
  Object.assign(a.clock, { play() { a.clock.state = 'playing'; }, pause() { a.clock.state = 'paused'; }, async unlock() { return false; }, stop(t) { a.__T = t; a.clock.state = 'stopped'; }, seek(t) { a.__T = t; }, setRate(r) { a.clock.rate = r; }, position: () => a.__T });
  Object.defineProperty(a, 'needsBgm', { get: () => false, configurable: true });
  a.afterAudioStart = () => {};
  window.__tick = () => new Promise((r) => setTimeout(r, 30)); // play()（非同期）を先に終わらせる
  window.__step = (to, onEach) => { while (a.__T < to - 1e-9 && a.state !== 'ended') { a.__T = Math.min(to, a.__T + 1 / 60); onEach?.(); a.frame(); } };
});
const sameAs = (got, rec) => JSON.stringify(got.notes.map((n) => [n.id, n.result, n.points, n.input?.time, n.input?.deltaMs, n.hold?.status])) === JSON.stringify(rec.notes.map((n) => [n.id, n.result, n.points, n.input?.time, n.input?.deltaMs, n.hold?.status]))
  && got.summary.score === rec.summary.score && got.summary.maxCombo === rec.summary.maxCombo && got.summary.maeMs === rec.summary.maeMs && got.summary.perfect === rec.summary.perfect && got.summary.good === rec.summary.good;

// ---------- 1. 初回起動（新しいブラウザ状態）: 公式デモ・比較・リプレイ ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(base); await ready(p);
  const st = await p.evaluate(() => ({ personal: window.__app.history.records.length, demos: window.__app.history.official.map((r) => [r.id, r.demo.label, r.summary.perfect + r.summary.good, r.summary.total]), off: window.__app.official }));
  check(st.personal === 0 && st.demos.length === 3 && st.demos.map((d) => d[0]).join() === 'official-demo-90,official-demo-70,official-demo-50' && st.demos.map((d) => d[2]).join() === '53,41,30',
    '初回起動（プレイなし）から公式デモ 3 件（約90・70・50％ = 成功 53・41・30／59）が履歴にある', JSON.stringify(st.demos.map((d) => `${d[1]} ${d[2]}/${d[3]}`)));
  await p.click('#btnScores'); await p.click('[data-tab=history]');
  const ht = await p.evaluate(() => document.querySelector('.res-demo-hist')?.textContent.replace(/\s+/g, ' ') || '');
  check(/公式デモ／シミュレーション/.test(ht) && /実際の利用者の実績ではありません/.test(ht) && /89\.8%（53\/59）/.test(ht) && /69\.5%（41\/59）/.test(ht) && /50\.8%（30\/59）/.test(ht), '履歴に「公式デモ／シミュレーション」として表示し、実際の正答率と成功件数を明示');
  for (const id of ['official-demo-90', 'official-demo-70', 'official-demo-50']) await p.check(`[data-sel="${id}"]`);
  await p.click('[data-act=cmpSel]'); await p.waitForTimeout(500);
  const cmp = await p.evaluate(() => ({ n: window.__app.results.cmp.data?.recs.length, cells: document.querySelectorAll('.cmx td[data-cnote]').length, legend: document.querySelector('.cmp-legend').textContent.replace(/\s+/g, ' '), tl: window.__cmpTl?.rows.length, sum: document.querySelectorAll('.cmp-sum')[1]?.textContent || '' }));
  check(cmp.n === 3 && cmp.cells === 59 * 3 && cmp.tl === 7 && /公式デモ/.test(cmp.legend) && /判定幅 60\/120\/180・速度 1×・補正 0ms/.test(cmp.legend) && /息／Y/.test(cmp.sum), '公式デモ 3 件を互いに比較（全編の時間軸・ノーツ別・技別）。譜面・判定幅・速度・入力補正を明示');
  const per = await p.evaluate(() => { document.querySelector('[data-cmode=period]').click(); return { t: document.querySelector('#resultBody').textContent, demosIn: JSON.stringify(window.__app.results.cmp.pdata || {}).includes('official-demo') }; });
  check(!per.demosIn, '公式デモは期間平均の集計に入らない');
  await p.click('#btnResultClose');
  // リプレイ: 3 件それぞれ最初から → 保存された判定・スコア・コンボ・誤差と一致
  await harness(p);
  for (const id of ['official-demo-90', 'official-demo-70', 'official-demo-50']) {
    const r = await p.evaluate(async (id) => {
      const a = window.__app, rec = a.history.get(id);
      a.startReplay(rec); await window.__tick(); a.state = 'playing';
      window.__step(a.duration + 0.1);
      return { rec, got: a.replayRecord(), banner: document.querySelector('#replayLabel').textContent, state: a.state };
    }, id);
    check(sameAs(r.got, r.rec) && /公式デモ再現中/.test(r.banner), `${id}: 最初から再現した判定・成功件数・スコア・コンボ・入力誤差が保存された記録と一致`, `スコア ${r.got.summary.score}/${r.rec.summary.score} コンボ ${r.got.summary.maxCombo}/${r.rec.summary.maxCombo}`);
  }
  // 一時停止・再開・シーク・最初から・手動入力の無視
  const mid = await p.evaluate(async () => {
    const a = window.__app, rec = a.history.get('official-demo-50');
    a.startReplay(rec); await window.__tick(); a.state = 'playing';
    window.__step(30);
    const scoreAt30 = a.judge.summary().score;
    a.pause(); const paused = a.state;
    a.onPress('A', 0, { id: 'manual1', source: 'key', device: 'keyboard' }); // 手動の入力（判定に入らない）
    await a.play(); a.state = 'playing';
    window.__step(50);
    a.seek(20); a.state = 'playing';   // 戻る: 20 秒までの入力から作り直す（二重加点なし）
    const at20 = a.judge.summary();
    window.__step(60);
    a.seek(70); a.state = 'playing';   // 先へ飛ぶ
    window.__step(a.duration + 0.1);
    const got = a.replayRecord();
    a.retry(); await window.__tick(); a.state = 'playing';    // 最初から
    window.__step(a.duration + 0.1);
    const again = a.replayRecord();
    return { rec, got, again, scoreAt30, paused, at20 };
  });
  check(mid.paused === 'paused' && sameAs(mid.got, mid.rec) && sameAs(mid.again, mid.rec) && mid.at20.score < mid.scoreAt30,
    '一時停止・再開・シーク（戻る・先へ）・最初から の後も結果が一致し、二重加点しない。再現中の手動入力は判定に入らない', `20 秒時点 ${mid.at20.score} < 30 秒時点 ${mid.scoreAt30}`);
  const after = await p.evaluate(() => ({ personal: window.__app.history.records.length, best: localStorage.getItem('kiva2d.v2.best.manual'), stored: localStorage.getItem('kiva2d.v2.history') }));
  check(after.personal === 0 && after.best === null && after.stored === null, 'リプレイは成績・自己ベスト・期間平均の対象（この端末の履歴）に何も追加しない');
  await p.evaluate(() => window.__app.stopReplay());
  check(await p.evaluate(() => !window.__app.replay && document.querySelector('#replayBanner').hidden), '「再現を終える」で通常に戻る');
  // 自分のプレイ（入力ログあり）の再現と、ログのない古い記録
  const own = await p.evaluate(async () => {
    const a = window.__app;
    a.state = 'ready'; await a.play(); a.state = 'playing';
    const rel = [];
    let k = 0;
    const notes = a.chart.notes.slice().sort((x, y) => x.time - y.time);
    window.__step(a.duration + 0.1, () => {
      while (k < notes.length && notes[k].time - 0.03 <= a.__T) {
        const n = notes[k++];
        if (k % 6 === 0) continue;
        a.onPress(n.button, 0, { id: `own${k}`, source: 'key', device: 'keyboard' });
        if (n.input !== 'hold') a.onRelease(n.button, 0, { source: 'key', device: 'keyboard' });
        else rel.push([n.button, n.time + (k % 2 ? n.duration * 0.5 : n.duration + 0.1)]); // 息: 早離し／保持して離す
      }
      for (const h of rel.filter((x) => x[1] <= a.__T)) { a.onRelease(h[0], 0, { source: 'key', device: 'keyboard' }); rel.splice(rel.indexOf(h), 1); }
    });
    const rec = a.lastRecord;
    a.results.hide();
    a.startReplay(rec); await window.__tick(); a.state = 'playing';
    window.__step(a.duration + 0.1);
    const got = a.replayRecord();
    a.stopReplay();
    const old = structuredClone(rec); old.id = 'old-no-log'; delete old.replay;
    a.results.show(old, { tab: 'summary' });
    const box = document.querySelector('.res-replay').textContent;
    const disabled = document.querySelector('[data-replay="old-no-log"]').disabled;
    a.results.hide();
    return { rec, got, box, disabled, hasLog: !!rec.replay, events: rec.replay?.events.length, kind: rec.kind, hist: a.history.records.length };
  });
  check(own.hasLog && own.kind === 'full' && own.events > 50 && sameAs(own.got, own.rec), '自分のプレイには入力ログ・譜面の写し・判定ロジックの版を保存し、再現すると同じ結果', `ログ ${own.events} 件`);
  check(own.disabled && /この履歴はリプレイに必要な記録がありません/.test(own.box) && own.hist === 1, 'ログのない古い履歴は「この履歴はリプレイに必要な記録がありません」（推測で作らない）。再現しても履歴は増えない');
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await ctx.close();
}

// ---------- 2. 公式データとして保存・公開（パスワード）／個人用の保存との区別 ----------
if (!PASS) console.log('--   OFFICIAL_TEST_PASSWORD がないため、公式データの保存の確認は省略');
else {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  p.on('dialog', (d) => d.accept());
  await p.goto(base); await ready(p);
  const api = (path, init) => p.evaluate(async ([path, init]) => { const r = await fetch(path, init); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, init]);
  const v0 = (await api('api/official')).body;
  check(v0 && Number.isInteger(v0.version), 'サーバーから今の公式データ（版）を読める', `版 ${v0?.version}`);
  // 認証なし・不正 JSON の直接の呼び出し
  let r = await api('api/official/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseVersion: v0.version, targets: ['timing'], chart: v0.chart }) });
  check(r.status === 401, '認証なしの直接の API 呼び出しは拒否（401）', `${r.status}`);
  r = await api('api/official/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password": "x", "targets": [' });
  check(r.status === 400, '不正な JSON は拒否（400・保存しない）', `${r.status}`);
  // 個人用の保存（パスワード不要）: エフェクトを 1 つ変えて個人用に保存
  await p.evaluate(() => window.__app.setEdit(true));
  const target = await p.evaluate(() => { const a = window.__app, n = a.chart.notes.find((x) => x.button === 'A'); a.editor.apply((c) => { const m = c.notes.find((x) => x.id === n.id); m.effect = { ...(m.effect || {}), angle: (m.effect?.angle ?? 0) === 45 ? 30 : 45 }; }, 'テスト'); return { id: n.id, angle: window.__app.chart.notes.find((x) => x.id === n.id).effect.angle }; });
  await p.click('[data-act=saveDefault]');
  const personal = await p.evaluate(() => localStorage.getItem('kiva2d.v2.chart.default'));
  check(!!personal && (await api('api/official')).body.version === v0.version, '「個人用に保存」はパスワードなしでこの端末にだけ保存（公式データは変わらない）');
  // 公式データの画面: キャンセル・誤ったパスワード・正しいパスワード
  await p.click('[data-act=official]');
  await p.waitForFunction(() => document.querySelector('#officialDlg')?.open && /今の公式データ: /.test(document.querySelector('.off-cur')?.textContent || ''), null, { timeout: 10000 });
  let dlg = await p.evaluate(() => ({ cur: document.querySelector('.off-cur').textContent, prev: document.querySelector('.off-preview').textContent, type: document.querySelector('#offPass').type }));
  check(dlg.type === 'password' && new RegExp(`版 ${v0.version}`).test(dlg.cur) && /個別エフェクト: 1 ノーツ/.test(dlg.prev) && /版 \d+ になります/.test(dlg.prev), '公開前に対象・変更概要（個別エフェクト 1 ノーツ）・今の版を表示。パスワード欄は伏字', dlg.prev.slice(0, 60));
  await p.fill('#offPass', PASS); await p.click('[data-off=cancel]');
  r = await api('api/official');
  check(r.body.version === v0.version && !(await p.evaluate(() => document.querySelector('#officialDlg').open)), 'キャンセルすると保存しない');
  await p.click('[data-act=official]'); await p.waitForTimeout(800);
  await p.fill('#offPass', 'wrong-password'); await p.click('[data-off=publish]');
  await p.waitForFunction(() => /パスワードが違います/.test(document.querySelector('.off-msg')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  dlg = await p.evaluate(() => ({ msg: document.querySelector('.off-msg').textContent, pass: document.querySelector('#offPass').value }));
  check(/パスワードが違います（保存していません/.test(dlg.msg) && dlg.pass === '' && (await api('api/official')).body.version === v0.version, '誤ったパスワードは保存せず「パスワードが違います」と表示（入力欄は空に戻す）', dlg.msg);
  await p.fill('#offPass', PASS); await p.click('[data-off=publish]');
  await p.waitForFunction(() => /公開しました: 版/.test(document.querySelector('.off-msg')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
  dlg = await p.evaluate(() => ({ msg: document.querySelector('.off-msg').textContent, pass: document.querySelector('#offPass').value, ls: JSON.stringify({ ...localStorage }), ss: JSON.stringify({ ...sessionStorage }) }));
  const v1 = (await api('api/official')).body;
  check(v1.version === v0.version + 1 && new RegExp(`公開しました: 版 ${v1.version}（`).test(dlg.msg) && v1.chart.notes.find((n) => n.id === target.id).effect.angle === target.angle,
    '正しいパスワードのときだけ保存・公開し、版番号と更新日時を表示', dlg.msg.slice(0, 60));
  check(dlg.pass === '' && !dlg.ls.includes(PASS) && !dlg.ss.includes(PASS), 'パスワードはブラウザに残さない（入力欄は空・保存領域にない）');
  // 対象以外は上書きしない
  const same = await p.evaluate(async ([a, b, id]) => {
    const { normalizeChart, exportChart } = await import('./app/chart.js');
    const A = JSON.parse(exportChart(normalizeChart(a.chart))), B = JSON.parse(exportChart(normalizeChart(b.chart)));
    const strip = (c) => { for (const n of c.notes) if (n.id === id) delete n.effect; return JSON.stringify(c); };
    return strip(A) === strip(B) && JSON.stringify(a.demos) === JSON.stringify(b.demos);
  }, [v0, v1, target.id]);
  check(same, '選んだ対象（個別エフェクト）以外の公式データ（判定設定・ノーツ・公式デモ）は変わらない');
  // 版の競合: もう一度変更して、古い版のまま保存（ほかの人が先に更新した状態）
  await p.evaluate(async (id) => { const a = window.__app; a.editor.apply((c) => { const m = c.notes.find((x) => x.id === id); m.effect = { ...m.effect, angle: m.effect.angle + 5 }; }, 'テスト2'); a.officialView.cur.version -= 1; await a.officialView.render(); }, target.id);
  await p.fill('#offPass', PASS); await p.click('[data-off=publish]');
  await p.waitForFunction(() => /ほかの更新で版/.test(document.querySelector('.off-msg')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
  dlg = await p.evaluate(() => document.querySelector('.off-msg').textContent);
  check(/ほかの更新で版 \d+ になっています/.test(dlg) && (await api('api/official')).body.version === v1.version, '版の競合を検出し、新しい変更を上書きしない（409）', dlg.slice(0, 50));
  // 新しいブラウザ状態から: 更新された公式データを使う。個人の保存がある端末は個人の設定のまま
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const q = await fresh.newPage();
  await q.goto(base); await ready(q);
  const fq = await q.evaluate((id) => ({ v: window.__app.official.version, src: window.__app.chartSource, angle: window.__app.chart.notes.find((n) => n.id === id).effect?.angle, demos: window.__app.history.official.length }), target.id);
  check(fq.v === v1.version && fq.src === 'distributed' && fq.angle === target.angle && fq.demos === 3, '新しいブラウザ状態では更新後の公式データ（版・エフェクト）で起動', JSON.stringify(fq));
  await fresh.close();
  await p.reload(); await ready(p);
  const keep = await p.evaluate(() => ({ src: window.__app.chartSource, def: localStorage.getItem('kiva2d.v2.chart.default'), v: window.__app.official.version }));
  check(['default', 'draft'].includes(keep.src) && keep.def === personal && keep.v === v1.version, '個人用に保存した設定・下書きは公式データの更新で上書きされない（個人の設定のまま起動）', keep.src);
  // 復元（同じ認証）: 元の版に戻す
  await p.evaluate(() => window.__app.openOfficial()); await p.waitForTimeout(1000);
  await p.evaluate(() => { document.querySelector('.off-versions').open = true; });
  await p.click(`[data-restore="${v0.version}"]`);
  await p.waitForTimeout(800);
  dlg = await p.evaluate(() => document.querySelector('.off-msg').textContent);
  check(/パスワードを入力してください/.test(dlg) && (await api('api/official')).body.version === v1.version, '復元もパスワードが必要（未入力なら戻さない）');
  await p.fill('#offPass', PASS); await p.click(`[data-restore="${v0.version}"]`);
  await p.waitForFunction(() => /に戻して公開しました: 版/.test(document.querySelector('.off-msg')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
  const v2 = (await api('api/official')).body;
  check(v2.version === v1.version + 1 && v2.restoredFrom === v0.version && JSON.stringify(v2.chart) === JSON.stringify(v0.chart) && JSON.stringify(v2.demos) === JSON.stringify(v0.demos), '以前の版に戻せる（戻した内容は新しい版として公開）', `版 ${v2.version}（版 ${v2.restoredFrom} の内容）`);
  const vs = (await api('api/official/versions')).body.versions;
  check(vs[0].version === v2.version && vs.some((v) => v.version === v1.version), '版の一覧（版・更新日時・変更概要）', vs.slice(0, 3).map((v) => `版 ${v.version} ${v.summary}`).join(' / '));
  // 後片付け: 個人用の保存を消す（このブラウザ状態だけ）
  await p.evaluate(() => localStorage.clear());
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await ctx.close();
}

await browser.close();
console.log(fails.length ? `\nNG ${fails.length} 件` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
