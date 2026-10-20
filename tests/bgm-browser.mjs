// ver2 の BGM の確認（実素材が必要）: npm start（別ターミナル）→ node tests/bgm-browser.mjs   （BASE=公開 URL でも可）
// 3 曲それぞれで、開始・一時停止・再開・シーク・速度変更・リトライ・終了時の停止を、実際に鳴っている BGM の波形と
// 曲のデータの照合（相互相関）でずれを測って確かめる。音割れは最終出力（リミッター後）の最大値で確かめる。
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const fails = [];
const check = (ok, msg, extra = '') => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}${extra ? ` ${extra}` : ''}`); if (!ok) fails.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });

async function open(viewport = { width: 1280, height: 720 }, q = '?v=v2') {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 900 });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(base + q);
  await p.waitForFunction(() => document.documentElement.dataset.state === 'ready', null, { timeout: 120000 });
  return { ctx, p, errors };
}
const waitBgm = (p) => p.waitForFunction(() => ['ready', 'error'].includes(window.__app.bgmState?.status), null, { timeout: 60000 });
const st = (p) => p.evaluate(() => {
  const a = window.__app, c = a.clock;
  return { t: a.t, state: a.state, bgm: a.bgmState, sel: document.querySelector('#bgmSel').value, panel: !document.querySelector('#bgmPanel').hidden,
    startDisabled: document.querySelector('#bgmStart').disabled, playDisabled: document.querySelector('#btnPlay').disabled, sources: c.activeSources,
    level: c.bgmLevel(), rate: c.rate, label: c.bgm?.label };
});
/** 鳴っている BGM（analyser）と曲のデータを照合: 期待位置（時間軸 t = 曲の位置）からのずれ（ms）と相関 */
const sync = (p) => p.evaluate(() => {
  const c = window.__app.clock, an = c.bgmAnalyser, N = an.fftSize, d = new Float32Array(N);
  an.getFloatTimeDomainData(d);
  const now = c.ctx.currentTime, tl = c.anchorT + (now - c.anchorBase) * c.rate;
  const buf = c.bgm.buffer, sr = buf.sampleRate, L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const end = tl * sr;
  let best = -2, bo = 0;
  for (let off = -4800; off <= 4800; off += 8) {
    let s = 0, n1 = 0, n2 = 0;
    for (let i = 0; i < N; i += 2) {
      const bi = Math.round(end + off - (N - 1 - i) * c.rate);
      if (bi < 0 || bi >= L.length) continue;
      const b = (L[bi] + R[bi]) / 2; s += b * d[i]; n1 += b * b; n2 += d[i] * d[i];
    }
    const cc = s / Math.sqrt(n1 * n2 + 1e-12);
    if (cc > best) { best = cc; bo = off; }
  }
  // 細かく
  for (let off = bo - 8; off <= bo + 8; off++) {
    let s = 0, n1 = 0, n2 = 0;
    for (let i = 0; i < N; i++) {
      const bi = Math.round(end + off - (N - 1 - i) * c.rate);
      if (bi < 0 || bi >= L.length) continue;
      const b = (L[bi] + R[bi]) / 2; s += b * d[i]; n1 += b * b; n2 += d[i] * d[i];
    }
    const cc = s / Math.sqrt(n1 * n2 + 1e-12);
    if (cc > best) { best = cc; bo = off; }
  }
  return { ms: +(bo / sr * 1000).toFixed(1), corr: +best.toFixed(3), t: +tl.toFixed(2) };
});
const syncOk = async (p, label) => {
  // 静かな箇所に当たると相関が低くなるので、少し時間をずらして 3 回測り、良いものを使う
  let r = null;
  for (let k = 0; k < 3; k++) { const x = await sync(p); if (!r || x.corr > r.corr) r = x; await sleep(250); }
  check(r.corr > 0.8 && Math.abs(r.ms) < 25, `${label}: BGM が時間軸どおり（ずれ ${r.ms} ms、相関 ${r.corr}、t=${r.t}）`);
};
const peakOut = (p, ms) => p.evaluate((ms) => new Promise((res) => {
  const an = window.__app.clock.outAnalyser, d = new Float32Array(an.fftSize); let pk = 0;
  const t0 = performance.now();
  const tick = () => { an.getFloatTimeDomainData(d); for (const v of d) pk = Math.max(pk, Math.abs(v)); if (performance.now() - t0 < ms) setTimeout(tick, 20); else res(pk); };
  tick();
}), ms);

// ---------- 1. 初回: Devil In The Fire が選択済み。縦横で選択欄と開始ボタンが見える。読み込むまで開始できない ----------
for (const [name, vp] of [['縦 393x659', { width: 393, height: 659 }], ['横 852x330', { width: 852, height: 330 }]]) {
  const { ctx, p } = await open(vp);
  const vis = await p.evaluate(() => ['#bgmSel', '#bgmStart'].map((s) => {
    const r = document.querySelector(s).getBoundingClientRect(), el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth && (el === document.querySelector(s) || document.querySelector(s).contains(el));
  }));
  const s0 = await st(p);
  check(s0.sel === 'devil' && s0.panel && vis.every(Boolean), `${name}: 初回は Devil In The Fire。選択欄と開始ボタンが画面内に見える`, JSON.stringify(vis));
  await waitBgm(p);
  const s1 = await st(p);
  check(s1.bgm.status === 'ready' && !s1.startDisabled && !s1.playDisabled, `${name}: 読み込み後に開始できる（${s1.bgm.codec}）`);
  await p.screenshot({ path: `test-results/bgm_panel_${vp.width}x${vp.height}.png` });
  await ctx.close();
}

// ---------- 2. 3 曲それぞれ ----------
const TRACKS = [['devil', 'Devil In The Fire'], ['spear', 'AUTODRIVING THE SPEAR'], ['uprising', 'UPRISING OVERDRIVE VORTEX']];
for (const [id, label] of TRACKS) {
  const { ctx, p, errors } = await open();
  await waitBgm(p);
  await p.selectOption('#bgmSel', id);
  await waitBgm(p);
  let s = await st(p);
  check(s.bgm.status === 'ready' && s.label === label, `${label}: 選んで読み込み`);
  await p.click('#btnAuto');
  await p.click('#bgmStart');
  await sleep(500);
  s = await st(p);
  check(s.t < 0 && s.level < 1e-4, `${label}: 開始前の待ち時間（t<0）は鳴らない`, `t=${s.t.toFixed(2)}`);
  await p.waitForFunction(() => window.__app.t > 3, null, { timeout: 15000 });
  s = await st(p);
  check(s.state === 'playing' && s.level > 1e-3 && !s.panel && s.sources === 2, `${label}: 開始で BGM と元動画の音声が鳴る（音源 ${s.sources}、選択欄は隠れる）`);
  await syncOk(p, `${label} 開始後`);
  // 一時停止 → 無音、再開 → 同じ位置から
  await p.click('#btnPlay');
  await sleep(400);
  s = await st(p);
  check(s.state === 'paused' && s.sources === 0 && s.level < 1e-4 && s.panel, `${label}: 一時停止で BGM も止まる`);
  await p.click('#btnPlay');
  await sleep(800);
  await syncOk(p, `${label} 再開`);
  // シーク
  await p.evaluate(() => window.__app.seek(40));
  await sleep(800);
  await syncOk(p, `${label} 40 秒へシーク`);
  // 速度変更
  await p.evaluate(() => window.__app.setRate(0.5));
  await sleep(1000);
  await syncOk(p, `${label} 0.5 倍速`);
  await p.evaluate(() => window.__app.setRate(1));
  // 音割れ: 効果音が重なる区間（AUTO で打撃）の最終出力の最大値
  await p.evaluate(() => window.__app.seek(52.0));
  const pk = await peakOut(p, 4000);
  check(pk <= 1.0, `${label}: BGM・音声・効果音を重ねても出力が 1.0 を超えない（最大 ${pk.toFixed(3)}）`);
  // リトライを続けて押しても二重に鳴らない
  for (let k = 0; k < 5; k++) { await p.click('#btnRetry'); await sleep(60); }
  await p.waitForFunction(() => window.__app.t > 1.5, null, { timeout: 15000 });
  s = await st(p);
  check(s.sources === 2, `${label}: リトライを 5 回続けても音源は 2 つだけ（${s.sources}）`);
  await syncOk(p, `${label} リトライ後`);
  // 終了: 演武の終わりで短くフェードアウトして止まる
  await p.evaluate(() => window.__app.seek(window.__app.duration - 4));
  await sleep(600);
  const before = (await st(p)).level;
  await p.waitForFunction(() => window.__app.t > window.__app.duration - 0.4, null, { timeout: 15000 });
  const fading = (await st(p)).level;
  await p.waitForFunction(() => window.__app.state === 'ended', null, { timeout: 15000 });
  await sleep(400);
  s = await st(p);
  check(fading < before * 0.6 && s.level < 1e-4 && s.sources === 0, `${label}: 終わりでフェードアウトして停止（${before.toFixed(3)} → ${fading.toFixed(3)} → ${s.level.toFixed(5)}）`);
  check(s.panel && s.sel === id, `${label}: 終了後は選択欄が戻り、同じ曲が選ばれている`);
  check(errors.length === 0, `${label}: ページエラーなし`, errors.join(' / '));
  await ctx.close();
}

// ---------- 3. 選び直し・記憶・再生中の変更不可 ----------
{
  const { ctx, p } = await open();
  await waitBgm(p);
  check((await st(p)).sel === 'devil', '新しい状態では Devil In The Fire');
  await p.selectOption('#bgmSel', 'spear');
  await waitBgm(p);
  await p.click('#bgmStart');
  await p.waitForFunction(() => window.__app.t > 2, null, { timeout: 15000 });
  check(await p.evaluate(() => document.querySelector('#bgmPanel').hidden), '再生中は曲を変えられない（選択欄を出さない）');
  await p.click('#btnPlay'); // 一時停止
  await p.selectOption('#bgmSel', 'uprising');
  await waitBgm(p);
  let s = await st(p);
  check(s.state === 'ready' && s.t < 0 && s.label === 'UPRISING OVERDRIVE VORTEX' && s.sources === 0, '一時停止中に選び直すと先頭（開始前）に戻り、新しい曲になる');
  await p.click('#bgmStart');
  await p.waitForFunction(() => window.__app.t > 2, null, { timeout: 15000 });
  await syncOk(p, '選び直した曲を先頭から');
  await p.click('#btnPlay');
  await p.reload();
  await p.waitForFunction(() => document.documentElement.dataset.state === 'ready', null, { timeout: 120000 });
  check((await st(p)).sel === 'uprising', '最後に選んだ曲を覚える');
  const v1prefs = await p.evaluate(() => localStorage.getItem('kiva2d.prefs.v1'));
  const v2audio = JSON.parse(await p.evaluate(() => localStorage.getItem('kiva2d.v2.audio')));
  check(v2audio.bgm === 'uprising' && (!v1prefs || !/bgm/.test(v1prefs)), 'BGM の選択は ver2 用の保存先（ver1 の設定は変えない）');
  // 音量・ミュートを ver2 用に保存
  await p.click('#more summary');
  await p.fill('#mixBgm', '0.3'); await p.dispatchEvent('#mixBgm', 'change');
  await p.check('#muteSfx');
  const lv = await p.evaluate(() => ({ prefs: JSON.parse(localStorage.getItem('kiva2d.v2.audio')), bus: window.__app.clock.sfxBus?.gain.value }));
  check(lv.prefs.levels.bgm === 0.3 && lv.prefs.mutes.sfx === true, 'BGM・元動画・効果音の音量とミュートを ver2 用に保存', JSON.stringify(lv.prefs));
  await p.click('#more summary');
  await ctx.close();
}

// ---------- 4. 取得失敗: 曲名と再試行。成功するまで開始できない ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const p = await ctx.newPage();
  await p.route('**/bgm/**', (r) => r.abort());
  await p.goto(base + '?v=v2');
  await p.waitForFunction(() => window.__app?.bgmState?.status === 'error', null, { timeout: 120000 });
  let s = await st(p);
  const txt = await p.textContent('#bgmStatus');
  check(/Devil In The Fire/.test(txt) && !(await p.evaluate(() => document.querySelector('#bgmRetry').hidden)) && s.startDisabled && s.playDisabled,
    '取得失敗で曲名と再試行ボタンを出し、開始できない', txt.slice(0, 60));
  await p.click('#btnPlay', { force: true });
  check((await st(p)).state === 'ready', '読み込み前は開始ボタンを押しても始まらない');
  await p.unroute('**/bgm/**');
  await p.click('#bgmRetry');
  await waitBgm(p);
  s = await st(p);
  check(s.bgm.status === 'ready' && !s.startDisabled, '再試行で読み込めたら開始できる');
  await ctx.close();
}

// ---------- 5. ver1 へ切り替えると ver2 の BGM を止める。ver1 には BGM なし ----------
{
  const { ctx, p } = await open();
  await waitBgm(p);
  await p.click('#bgmStart');
  await p.waitForFunction(() => window.__app.t > 2, null, { timeout: 15000 });
  await p.evaluate(() => { const c = window.__app.clock, orig = c.shutdown.bind(c); c.shutdown = () => { orig(); sessionStorage.setItem('test.v2shutdown', JSON.stringify({ sources: c.activeSources, ctx: c.ctx.state })); }; });
  await p.click('#more summary');
  await Promise.all([p.waitForURL(/v=v1/), p.selectOption('#gameVersion', 'v1')]);
  await p.waitForFunction(() => document.documentElement.dataset.state === 'ready', null, { timeout: 120000 });
  const sd = JSON.parse(await p.evaluate(() => sessionStorage.getItem('test.v2shutdown')));
  await sleep(300);
  const v1 = await p.evaluate(() => ({ v: window.__app.version, bgm: window.__app.clock.bgm, mix: window.__app.clock.mix, panel: !document.querySelector('#bgmPanel').hidden }));
  check(sd && sd.sources === 0 && ['closed', 'closing'].includes(sd.ctx) || sd?.sources === 0, `ver1 へ切り替える前に ver2 の音をすべて止める（${JSON.stringify(sd)}）`);
  check(v1.v === 'v1' && v1.bgm === null && v1.mix === false && !v1.panel, 'ver1 は BGM なし・従来の音声の経路');
  await p.evaluate(() => localStorage.clear());
  await ctx.close();
}

await browser.close();
console.log(fails.length ? `\nNG ${fails.length} 件` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
