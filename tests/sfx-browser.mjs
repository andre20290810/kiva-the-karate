// 効果音と演出の確認（実素材が必要）: npm start（別ターミナル）→ node tests/sfx-browser.mjs   （BASE=公開 URL でも可）
// - 演出の山（人物の周りの明るさの最大）が、効果音の最も強い瞬間（聞こえる時刻）と同じか（AUTO・手動）
// - 呼吸の音が一時停止・シーク・リトライで止まり、二重に鳴らない
// - 打撃の瞬間に BGM が少し下がって戻る。効果音が BGM・元動画の音声より聞こえる（BGM あり／なし）
// - 効果音の音量は初期 0（既存の利用者も一度だけ 0）。上げると 4 種類が鳴り、設定は保存される
// - 成功で判定位置の文字に火が灯る（効果音 0 でも）。MISS・早すぎる解除では灯らない。シーク・リトライで消える
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const fails = [];
const check = (ok, msg, extra = '') => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}${extra ? ` ${extra}` : ''}`); if (!ok) fails.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });

async function open(sfxLevel = null) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}?fresh=1`);
  await p.waitForFunction(() => window.__app?.bgmState?.status === 'ready', null, { timeout: 120000 });
  if (sfxLevel != null) await p.evaluate((v) => window.__app.clock.setLevel('sfx', v), sfxLevel); // 音を測る確認だけ効果音を上げる（初期値は 0）
  // 計測用: 演出の開始（t0）と効果音の山、毎フレームの人物の周りの明るさ
  await p.evaluate(() => {
    const a = window.__app;
    a.__fx = []; a.__lum = [];
    const trig = a.fx.trigger.bind(a.fx);
    a.fx.trigger = (kind, o) => { a.__fx.push({ kind, t0: o.t, judgeT: a.t, frameIndex: o.frameIndex }); return trig(kind, o); };
    const draw = a.draw.bind(a);
    // 演出だけの明るさ = （演出あり）−（同じ時刻・同じコマを演出なしで描いたもの）。人物のコマの切り替わりの影響を除く
    const lumOf = (t) => {
      const r = a.transformFor(a.store.indexAt(Math.max(0, t))).crop(), d = a.dpr;
      const x = Math.max(0, (r.x - r.w * 0.6) * d), y = Math.max(0, (r.y - r.h * 0.1) * d);
      const w = Math.min(a.canvas.width - x, r.w * 2.2 * d), h = Math.min(a.canvas.height - y, r.h * 1.2 * d);
      const px = a.ctx.getImageData(x, y, w, h).data;
      let s = 0; for (let i = 0; i < px.length; i += 16) s += px[i] + px[i + 1] + px[i + 2];
      return s / (px.length / 16);
    };
    a.draw = (t) => {
      if (!a.__measure) { draw(t); return; }
      const list = a.fx.list, hold = a.fx.renderHold;
      a.fx.list = []; a.fx.renderHold = () => {}; draw(t); const off = lumOf(t);
      a.fx.list = list; a.fx.renderHold = hold; draw(t); const on = lumOf(t);
      a.__lum.push({ t, lum: on - off });
    };
  });
  return { ctx, p, errors };
}

/** note の時刻の少し前から 0.25 倍速で再生し、演出の明るさの山と効果音の山を比べる */
async function measure(p, noteT, label, manualKey = null, from = noteT - 0.25) {
  await p.evaluate(({ from }) => { const a = window.__app; a.__fx = []; a.__lum = []; a.__measure = true; a.setRate(0.25); a.seek(from); }, { from });
  if (manualKey) {
    await p.evaluate(({ noteT, code }) => new Promise((res) => {
      const tick = () => { if (window.__app.t >= noteT) { window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code.slice(3).toLowerCase(), bubbles: true })); setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code.slice(3).toLowerCase(), bubbles: true })), 60); res(); } else requestAnimationFrame(tick); };
      tick();
    }), { noteT, code: manualKey });
  }
  await p.waitForFunction((noteT) => window.__app.t > noteT + 0.25, noteT, { timeout: 60000 });
  const r = await p.evaluate(() => {
    const a = window.__app; a.__measure = false; a.setRate(1);
    const fx = a.__fx[0];
    if (!fx) return null;
    const base = a.__lum.filter((x) => x.t < fx.judgeT && x.t > fx.judgeT - 0.2).map((x) => x.lum);
    const b0 = base.length ? base.reduce((s, v) => s + v, 0) / base.length : 0;
    const after = a.__lum.filter((x) => x.t >= fx.judgeT - 0.02 && x.t < fx.t0 + 0.12);
    const best = after.reduce((m, x) => (x.lum > m.lum ? x : m), { lum: -1 });
    const rise = best.lum - b0;
    const onset = after.find((x) => x.lum >= b0 + 0.8 * rise);           // 明るさが山の 8 割に達した瞬間
    const atPeak = after.find((x) => x.t >= fx.t0 + 0.004);               // 効果音の山の直後のフレーム
    const step = a.__lum.length > 2 ? (a.__lum.at(-1).t - a.__lum[0].t) / (a.__lum.length - 1) : 0;
    return { kind: fx.kind, t0: fx.t0, judgeT: fx.judgeT, lead: (fx.t0 - fx.judgeT) / a.clock.rate, onsetT: onset?.t ?? NaN,
      share: atPeak ? (atPeak.lum - b0) / rise : 0, gain: rise, step };
  });
  if (!r) { check(false, `${label}: 演出が出ない`); return; }
  // 0.25 倍速では 1 フレーム（約 17 ms）= 時間軸の約 4 ms。山の立ち上がり（8 割）が効果音の山と同時で、その直後に山の 85% 以上あること
  const diffMs = (r.onsetT - r.t0) * 1000;
  check(r.lead >= 0 && r.lead < 0.12 && Math.abs(diffMs) <= Math.max(6, r.step * 1000 * 1.5) && r.share >= 0.85 && r.gain > 2,
    `${label}: 演出の山が効果音の山と同時（立ち上がりの差 ${diffMs.toFixed(1)} ms、直後に山の ${(r.share * 100).toFixed(0)}%、効果音は判定の ${(r.lead * 1000).toFixed(0)} ms 後に最大）`);
}

// ---------- 0. 効果音の音量: 初期 0・既存の利用者も一度だけ 0・上げると 4 種類が鳴る・保存される ----------
{
  const KEY = 'kiva2d.v2.audio';
  const lv = (p) => p.evaluate((KEY) => ({ saved: JSON.parse(localStorage.getItem(KEY) || '{}'), levels: { ...window.__app.audioPrefs.levels },
    slider: Number(document.querySelector('#mixSfx').value), bus: window.__app.clock.sfxBus.gain.value }), KEY);
  // 新しい利用者
  let { ctx, p, errors } = await open();
  let r = await lv(p);
  check(r.levels.sfx === 0 && r.slider === 0 && r.bus < 1e-3 && r.saved.levels?.sfx === 0 && r.saved.sfxReset, '新しい利用者: 効果音の音量は 0（スライダーも 0）', JSON.stringify(r.levels));
  await ctx.close();
  // 既存の利用者（効果音 0.9 で保存済み、初期化の記録なし）→ 一度だけ 0。BGM・元動画の音声は変えない
  ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript((KEY) => {
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    localStorage.setItem(KEY, JSON.stringify({ bgm: 'spear', levels: { voice: 0.55, bgm: 0.7, sfx: 0.9 }, mutes: { voice: false, bgm: false, sfx: false } }));
  }, KEY);
  p = await ctx.newPage(); errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const go = async () => { await p.goto(`${base}?fresh=1`); await p.waitForFunction(() => window.__app?.bgmState?.status === 'ready', null, { timeout: 120000 }); };
  await go();
  r = await lv(p);
  check(r.levels.sfx === 0 && r.levels.voice === 0.55 && r.levels.bgm === 0.7 && r.saved.bgm === 'spear', '既存の利用者: 効果音だけ 0 に初期化（BGM・元動画の音声・曲の選択はそのまま）', JSON.stringify(r.levels));
  // 利用者が上げた音量は保存され、再読み込みしても 0 に戻らない
  await p.click('#more summary');
  await p.$eval('#mixSfx', (el) => { el.value = '0.5'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
  await go();
  r = await lv(p);
  check(r.levels.sfx === 0.5 && r.slider === 0.5 && Math.abs(r.bus - 0.5) < 0.02 && r.levels.voice === 0.55, '上げた効果音の音量は保存され、再読み込みでも初期化されない', JSON.stringify(r.levels));
  // 4 種類（＋蹴り）が鳴る: 効果音の系統の出力を測る
  const peaks = await p.evaluate(async () => {
    const a = window.__app, c = a.clock;
    await c.ctx.resume();
    const an = c.ctx.createAnalyser(); an.fftSize = 2048; c.sfxBus.connect(an);
    const peak = (ms) => new Promise((res) => { let m = 0; const t0 = performance.now(); const d = new Float32Array(an.fftSize);
      const tick = () => { an.getFloatTimeDomainData(d); for (const v of d) m = Math.max(m, Math.abs(v)); if (performance.now() - t0 < ms) setTimeout(tick, 5); else res(m); }; tick(); });
    const out = {};
    for (const k of ['breath', 'stance', 'strike', 'kick', 'turn']) { a.sfx.play(k, 'PERFECT', { pan: 1 }); out[k] = await peak(450); await new Promise((r) => setTimeout(r, 250)); }
    a.sfx.breathStart(); out.breathHold = await peak(500); a.sfx.breathStop(); await new Promise((r) => setTimeout(r, 400)); out.afterStop = await peak(150);
    return out;
  });
  const names = { breath: '息（炎）', stance: '構（金属音）', strike: '撃（破裂音）', kick: '撃・蹴り', turn: '旋（風切り音）', breathHold: '息の長押し（炎の持続音）' };
  for (const k of Object.keys(names)) check(peaks[k] > 0.02, `音量 0.5 で ${names[k]} が鳴る`, `peak ${peaks[k].toFixed(3)}`);
  check(peaks.afterStop < 0.003, '息の長押しの音は止めると消える', `peak ${peaks.afterStop.toFixed(4)}`);
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await ctx.close();
}

// ---------- 1. AUTO と手動で、演出の山 = 効果音の山 ----------
// （効果音の音量は初期値の 0 のまま: 無音でも演出が出ることも確かめる）
{
  const { ctx, p, errors } = await open();
  await p.click('#btnAuto');
  await p.click('#bgmStart');
  await p.waitForFunction(() => window.__app.t > 0.3, null, { timeout: 15000 });
  for (const [t, label] of [[12.4, 'AUTO X 構え'], [15.4, 'AUTO A 打撃（突き）'], [20.8, 'AUTO B 旋回'], [24.2, 'AUTO A 蹴り']]) await measure(p, t, label);
  // Y: 長押しの完了（5.8 + 2.6 秒）
  await p.evaluate(() => window.__app.setRate(1));
  await measure(p, 8.4, 'AUTO Y 呼吸の完了', null, 5.6);
  await p.click('#btnAuto'); // 手動
  for (const [t, key, label] of [[12.4, 'KeyX', '手動 X 構え'], [15.4, 'KeyA', '手動 A 打撃'], [20.8, 'KeyB', '手動 B 旋回'], [24.2, 'KeyA', '手動 A 蹴り']]) await measure(p, t, label, key);
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await ctx.close();
}

// ---------- 2. 呼吸の音: 一時停止・シーク・リトライで止まり、二重に鳴らない ----------
{
  const { ctx, p, errors } = await open(0.8);
  await p.evaluate(() => { const a = window.__app, c = a.clock; a.__an = c.ctx.createAnalyser(); a.__an.fftSize = 2048; c.sfxBus.connect(a.__an); });
  const sfxLevel = () => p.evaluate(() => { const an = window.__app.__an, d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d); let s = 0; for (const v of d) s += v * v; return Math.sqrt(s / d.length); });
  const holdY = async () => {
    await p.evaluate(() => window.__app.seek(5.6));
    if ((await p.evaluate(() => window.__app.state)) !== 'playing') await p.click('#bgmStart').catch(() => p.click('#btnPlay'));
    await p.waitForFunction(() => window.__app.t >= 5.82, null, { timeout: 15000 });
    await p.keyboard.down('y');
    await sleep(500);
  };
  await p.click('#bgmStart');
  await p.waitForFunction(() => window.__app.t > 0.2, null, { timeout: 15000 });
  await holdY();
  const during = await sfxLevel();
  check(during > 1e-4 && (await p.evaluate(() => window.__app.sfx.breathActive)), `長押し中は息の音が鳴る（${during.toFixed(4)}）`);
  await p.keyboard.down('y'); await p.keyboard.down('y'); // 押しっぱなしの自動リピート
  check(await p.evaluate(() => window.__app.sfx.breathActive), '自動リピートでも息の音は 1 つ');
  for (const [label, act] of [['一時停止', () => p.click('#btnPlay')], ['シーク', () => p.evaluate(() => window.__app.seek(30))], ['リトライ', () => p.click('#btnRetry')]]) {
    if (label !== '一時停止') { await p.keyboard.up('y'); await holdY(); }
    await act();
    await sleep(450);
    const lv = await sfxLevel();
    const active = await p.evaluate(() => window.__app.sfx.breathActive);
    check(!active && lv < 3e-4, `${label}で息の音が止まる（残り ${lv.toFixed(5)}）`);
  }
  await p.keyboard.up('y');
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await ctx.close();
}

// ---------- 3. BGM を少し下げて戻す・効果音の聞こえ方（BGM あり／なし） ----------
{
  const { ctx, p } = await open(0.8);
  await p.click('#bgmStart');
  await p.waitForFunction(() => window.__app.t > 0.2, null, { timeout: 15000 });
  const hit = (code, noteT) => p.evaluate(({ code, noteT }) => new Promise((res) => {
    const a = window.__app, c = a.clock, ctx = c.ctx;
    a.seek(noteT - 0.6);
    const mk = (n) => { const an = ctx.createAnalyser(); an.fftSize = 1024; n.connect(an); return an; };
    const aS = mk(c.sfxBus), aB = mk(c.bgmBus), aV = mk(c.gain);
    const rms = (an) => { const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d); let s = 0; for (const v of d) s += v * v; return Math.sqrt(s / d.length); };
    let sP = 0, bS = 0, vS = 0, n = 0, duckMin = 1; const t0 = performance.now(); let pressed = false;
    const tick = () => {
      const el = performance.now() - t0;
      if (!pressed && a.t >= noteT) { pressed = true; window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code.slice(3).toLowerCase(), bubbles: true })); setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code.slice(3).toLowerCase(), bubbles: true })), 60); }
      if (!pressed) { bS += rms(aB); vS += rms(aV); n++; } else { sP = Math.max(sP, rms(aS)); duckMin = Math.min(duckMin, c.bgmDuck.gain.value); }
      if (el < 1300) setTimeout(tick, 5); else res({ sfx: sP, bgm: bS / n, voice: vS / n, duckMin, duckAfter: c.bgmDuck.gain.value });
    };
    tick();
  }), { code, noteT });
  const db = (x) => 20 * Math.log10(x);
  // 譜面のノーツの時刻に押す（35.0 A 打撃、37.4 X 構え、38.8 B 旋回）
  for (const [code, at, label] of [['KeyA', 35.0, 'A 打撃'], ['KeyX', 37.4, 'X 構え'], ['KeyB', 38.8, 'B 旋回']]) {
    const r = await hit(code, at);
    check(r.sfx / r.bgm > 1.5, `BGM あり ${label}: 効果音が BGM の平均より ${(db(r.sfx / r.bgm)).toFixed(1)} dB 大きい`);
    check(r.duckMin < 0.85 && r.duckAfter > 0.97, `BGM あり ${label}: 瞬間だけ BGM を ${db(r.duckMin).toFixed(1)} dB 下げて戻す`);
  }
  await p.click('#more summary');
  await p.check('#muteBgm');
  await p.click('#more summary');
  const r = await hit('KeyA', 35.0);
  check(r.sfx / Math.max(r.voice, 1e-6) > 2, `BGM なし A 打撃: 効果音が元動画の音声の平均より ${(db(r.sfx / Math.max(r.voice, 1e-6))).toFixed(1)} dB 大きい`);
  await ctx.close();
}

// ---------- 4. 判定位置の文字の火: 成功で灯る（効果音 0 でも・AUTO でも）。MISS・早すぎる解除では灯らない。シーク・リトライで消える ----------
{
  const { ctx, p, errors } = await open();
  const fires = () => p.evaluate(() => { const g = window.__app.lanes.glyph; return { list: g.list.map((e) => ({ b: e.button, strong: !!e.strong, grade: e.grade })), hold: g.hold ? { ...g.hold } : null, smother: g.smother.length }; });
  const runTo = (t) => p.waitForFunction((t) => window.__app.t > t, t, { timeout: 30000 });
  await p.click('#btnAuto');
  await p.click('#bgmStart');
  await p.evaluate(() => window.__app.seek(12.0));
  await runTo(12.5);
  let f = await fires();
  check(f.list.some((e) => e.b === 'X'), 'AUTO: 成功で判定位置の「構」に火が灯る（効果音 0 でも）', JSON.stringify(f.list));
  await p.evaluate(() => window.__app.seek(5.5));
  f = await fires();
  check(f.list.length === 0 && !f.hold, 'シークで火が消える');
  await runTo(7.0);
  f = await fires();
  check(f.hold?.button === 'Y' && f.hold.progress > 0.3 && f.hold.progress < 0.7, 'AUTO: 呼吸を保持している間は「息」の火が育つ', JSON.stringify(f.hold));
  await runTo(8.6);
  f = await fires();
  check(f.list.some((e) => e.b === 'Y' && e.strong), 'AUTO: 呼吸の完了で「息」が強く灯る', JSON.stringify(f.list));
  await p.click('#btnAuto'); // 手動
  // MISS: 押さずに通過
  await p.evaluate(() => window.__app.seek(14.8));
  await runTo(15.8);
  f = await fires();
  check(!f.list.some((e) => e.b === 'A'), 'MISS では火が灯らない', JSON.stringify(f.list));
  // 早すぎる解除: 5.8 で押して 6.6 で離す（2.6 秒の長押し）
  await p.evaluate(() => window.__app.seek(5.5));
  await p.waitForFunction(() => window.__app.t >= 5.8, null, { timeout: 15000 });
  await p.keyboard.down('y');
  await runTo(6.6);
  const mid = await fires();
  await p.keyboard.up('y');
  await sleep(300);
  f = await fires();
  check(mid.hold?.button === 'Y' && !f.hold && !f.list.some((e) => e.b === 'Y'), '早すぎる解除では発火せず、育った火は静かに消える', JSON.stringify({ mid: mid.hold, after: f }));
  // リトライで消える
  await p.evaluate(() => window.__app.seek(12.2));
  await p.waitForFunction(() => window.__app.t >= 12.4, null, { timeout: 15000 });
  await p.keyboard.press('x');
  await sleep(150);
  const before = await fires();
  await p.click('#btnRetry');
  await sleep(100);
  f = await fires();
  check(before.list.some((e) => e.b === 'X') && f.list.length === 0 && !f.hold, '手動の成功でも灯り、リトライで消える', JSON.stringify(before.list));
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await ctx.close();
}

await browser.close();
console.log(fails.length ? `\nNG ${fails.length} 件` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
