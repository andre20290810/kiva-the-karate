// 音声の確認（実素材が必要）: npm start（別ターミナル）→ node tests/audio-browser.mjs   （BASE=公開 URL で公開版も確認できる）
// 「再生中」の表示が実際の状態と合っているか、音声を開始できない場合に理由と再試行ボタンが出るかを確かめる。
// 出力信号は AnalyserNode（音楽の出力経路）で測る。iPhone の消音スイッチ・スピーカーの状態はブラウザ内からは測れない。
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const fails = [];
const check = (ok, msg, extra = '') => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}${extra ? ` ${extra}` : ''}`); if (!ok) fails.push(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, viewport) {
  const ctx = await browser.newContext({ viewport, hasTouch: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${base}?fresh=1${process.env.GAME_VERSION ? `&v=${process.env.GAME_VERSION}` : ''}`);
  await p.waitForFunction(() => ['ready', 'error'].includes(document.documentElement.dataset.state), null, { timeout: 120000 });
  return { ctx, p, errors };
}
const info = (p) => p.evaluate(() => {
  const a = window.__app, c = a.clock;
  return { state: a.audio?.state, signal: a.audio?.signal, file: a.audio?.file, codec: a.audio?.codec, ctx: c.ctx?.state, audioMode: !!c._audioMode,
    text: document.querySelector('#audioInfo').textContent, retry: !document.querySelector('#btnAudio').hidden, t: a.t, game: a.state, rate: c.rate };
});
/** 音声の時計と画像の時計の差（秒）: 音源の再生位置（ctx 時刻から逆算）と表示コマの時刻 */
const drift = (p) => p.evaluate(() => {
  const a = window.__app, c = a.clock;
  const audioPos = c.anchorT + (c._base() - c.anchorBase) * c.rate;
  return Math.abs(audioPos - a.t);
});

// 1. 自動再生が許可された状態（タップ後の通常の状態に相当）
{
  const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
  const { ctx, p, errors } = await open(browser, { width: 393, height: 659 });
  let s = await info(p);
  console.log(`     使用した音声: ${s.file}（${s.codec}）`);
  check(s.state === 'loaded' && !/再生中/.test(s.text), '読み込み直後は「再生中」と表示しない', s.text);
  await p.click('#btnAuto');
  await p.click('#btnPlay');
  await p.waitForFunction(() => window.__app.t > 2 && window.__app.audio.signal != null, null, { timeout: 20000 });
  s = await info(p);
  check(s.state === 'playing' && s.ctx === 'running' && s.audioMode && s.signal === true && /出力信号あり/.test(s.text), '開始ボタンで音声が鳴り、出力信号あり', s.text);
  await p.click('#btnPlay');
  s = await info(p); const t0 = s.t; await sleep(500); const t1 = (await info(p)).t;
  check(s.game === 'paused' && s.state === 'paused' && Math.abs(t1 - t0) < 1e-6 && /一時停止中/.test(s.text), '一時停止で止まり、表示も一時停止中');
  await p.click('#btnPlay');
  await sleep(1500);
  s = await info(p);
  check(s.state === 'playing' && s.signal === true && s.t > t0, '再開で同じ位置から音声が続く', `(${t0.toFixed(2)} → ${s.t.toFixed(2)})`);
  await p.evaluate(() => window.__app.seek(40));
  await sleep(1500);
  s = await info(p);
  check(s.signal === true && s.t > 40 && s.t < 42.5 && (await drift(p)) < 0.03, '40 秒付近へシークしても音声が出て、画像と同じ位置', `t=${s.t.toFixed(2)}`);
  const setSpeed = async (v) => { await p.click('#more summary'); await p.selectOption('#speed', v); await p.click('#more summary'); };
  await setSpeed('0.5');
  const r0 = (await info(p)).t; await sleep(2000); s = await info(p);
  check(s.rate === 0.5 && s.signal === true && Math.abs((s.t - r0) / 2 - 0.5) < 0.06, '0.5 倍速でも音声が出て、時間軸が 0.5 倍', `(${((s.t - r0) / 2).toFixed(3)})`);
  await setSpeed('1');
  await p.setViewportSize({ width: 852, height: 330 });
  await sleep(1500);
  s = await info(p);
  check(s.state === 'playing' && s.signal === true && (await p.evaluate(() => window.__debug.orient)) === 'landscape' && (await drift(p)) < 0.03, '横向きへ回転しても音声と再生が続く');
  // 割り込み（iOS の着信・画面ロックで AudioContext が止まる）: 音なしで進めず一時停止して知らせる
  await p.evaluate(() => window.__app.clock.ctx.suspend());
  await sleep(400);
  s = await info(p);
  check(s.game === 'paused' && /中断/.test(await p.textContent('#status')), '音声が中断されたらゲームも一時停止し、理由を表示', await p.textContent('#status'));
  await p.click('#btnPlay');
  await sleep(1200);
  s = await info(p);
  check(s.state === 'playing' && s.ctx === 'running' && s.signal === true, '▶ 再開で音声も再開');
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await ctx.close(); await browser.close();
}

// 2. 音声を開始できない状態（iOS で AudioContext が再開しない場合を再現: suspend したうえで resume() が完了しないようにする）
{
  const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
  const { ctx, p, errors } = await open(browser, { width: 852, height: 330 });
  await p.evaluate(async () => {
    const c = window.__app.clock.ctx;
    await c.suspend();
    c.resume = () => new Promise(() => {}); // 再開しない
  });
  await p.click('#btnPlay');
  await p.waitForFunction(() => window.__app.audio.state !== 'loaded', null, { timeout: 5000 });
  let s = await info(p);
  check(s.state === 'failed' && !/再生中の音声/.test(s.text) && s.retry && /suspended/.test(s.text) && /音声を開始できませんでした/.test(await p.textContent('#status')),
    '開始できないときは「再生中」と出さず、理由と再試行ボタンを出す', s.text);
  await sleep(800);
  const tBefore = (await info(p)).t;
  await p.evaluate(() => { delete window.__app.clock.ctx.resume; }); // 本来の resume に戻す
  await p.click('#btnAudio'); // ユーザー操作で再試行
  await p.waitForFunction(() => window.__app.audio.signal != null, null, { timeout: 8000 }).catch(() => {});
  s = await info(p);
  check(s.state === 'playing' && s.ctx === 'running' && s.audioMode && s.signal === true && !s.retry && s.t >= tBefore && (await drift(p)) < 0.03,
    '再試行ボタンで同じ位置から音声が鳴る', s.text);
  check(errors.length === 0, 'ページエラーなし', errors.join(' / '));
  await ctx.close(); await browser.close();
}

console.log(fails.length ? `\nNG ${fails.length} 件` : '\nすべて OK');
process.exit(fails.length ? 1 : 0);
