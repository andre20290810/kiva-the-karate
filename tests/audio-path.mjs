// 音の出力経路の検証（Chromium。スマホは UA 偽装であり、実機 iPhone/Android の確認ではない）。
//   npm start（別ターミナル）→ node tests/audio-path.mjs
// 確認: 鳴っている経路が常に Web Audio の1本だけ（HTMLAudio/Video は無音）、メディアのシークなし、
//       一時停止で無音、再開で鳴る、音量変更が反映される、表示モード切替で経路が増えない。
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const chart = process.argv[2] || 'tests/fixtures/synthetic/chart.json';
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const UAS = {
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  Android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  PC: undefined,
};
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'NG  '} ${msg}`); if (!ok) fails.push(msg); };

for (const [name, ua] of Object.entries(UAS)) {
  const ctx = await browser.newContext({ viewport: name === 'PC' ? { width: 1280, height: 800 } : { width: 390, height: 844 }, ...(ua ? { userAgent: ua, isMobile: true, hasTouch: true } : {}) });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => fails.push(`${name} pageerror: ${e.message}`));
  await p.addInitScript(() => {
    window.__audioLog = { sources: 0, mediaPlays: [], audibleSeeks: 0 };
    const origCreate = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () { window.__audioLog.sources++; return origCreate.call(this); };
    const origConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...r) {
      if (dest instanceof AudioDestinationNode && !this.__tapped) {
        const an = this.context.createAnalyser(); an.fftSize = 32768; // 約0.74秒（クリック音を取りこぼさない）
        origConnect.call(this, an); (window.__taps ||= []).push(an); this.__tapped = true;
      }
      return origConnect.call(this, dest, ...r);
    };
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.__audioLog.mediaPlays.push({ tag: this.tagName, muted: this.muted });
      if (!this.__hooked) { this.addEventListener('seeking', () => { if (!this.muted && this.volume > 0) window.__audioLog.audibleSeeks++; }); this.__hooked = true; }
      return origPlay.call(this);
    };
    // Audio 要素を new Audio() で作る経路も記録
    window.__allMedia = new Set();
    const OrigAudio = window.Audio;
    window.Audio = function (...a) { const el = new OrigAudio(...a); window.__allMedia.add(el); return el; };
  });
  await p.goto(`${base}?chart=${encodeURIComponent(chart)}&mode=auto`);
  await p.waitForFunction(() => window.__game?.state === 'ready', null, { timeout: 120000 });
  const sample = () => p.evaluate(() => {
    const rms = (an) => { const d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d); let m = 0; for (const v of d) m = Math.max(m, Math.abs(v)); return m; }; // 区間内の最大振幅
    const media = new Set([...document.querySelectorAll('audio,video'), ...window.__allMedia]);
    const audible = [...media].filter((m) => !m.paused && !m.muted && m.volume > 0);
    return { webAudio: (window.__taps || []).map(rms), audibleMedia: audible.length, ctxCount: (window.__taps || []).length, log: window.__audioLog };
  });
  // 音の大きさは区間で変わるので、複数回の最大値で判定
  const peak = async (n = 4, ms = 300) => { let best = null; for (let i = 0; i < n; i++) { await p.waitForTimeout(ms); const s = await sample(); if (!best || Math.max(...s.webAudio) > Math.max(...best.webAudio)) best = s; } return best; };
  await p.click('#btnStart');
  const play = await peak();
  check(play.ctxCount === 1 && Math.max(...play.webAudio) > 0.01 && play.audibleMedia === 0,
    `${name}: 再生中は Web Audio の1経路だけが鳴る（出力 ${Math.max(...play.webAudio).toFixed(3)}、音が出ている media 要素 ${play.audibleMedia}）`);
  const before = Math.max(...play.webAudio);
  await p.evaluate(() => { const v = document.querySelector('#volume'); v.value = '0.3'; v.dispatchEvent(new Event('input')); });
  await p.waitForTimeout(900); // 解析窓が変更後の区間だけになるまで待つ
  const quiet = await peak();
  check(quiet.audibleMedia === 0 && Math.max(...quiet.webAudio) > 0.002 && Math.abs(Math.max(...quiet.webAudio) / before - 0.3 / 0.8) < 0.08,
    `${name}: 音量 0.8→0.3 が反映（比 ${(Math.max(...quiet.webAudio) / before).toFixed(3)}、期待 0.375±0.08：${before.toFixed(3)} → ${Math.max(...quiet.webAudio).toFixed(3)}）・経路は1本のまま`);
  await p.evaluate(() => { const v = document.querySelector('#volume'); v.value = '0.8'; v.dispatchEvent(new Event('input')); });
  await p.click('#btnPause');
  await p.waitForTimeout(900); // 解析窓（0.74秒）が停止後の区間だけになるまで待つ
  const paused = await sample();
  check(Math.max(...paused.webAudio) < 0.001 && paused.audibleMedia === 0, `${name}: 一時停止中は無音（${Math.max(...paused.webAudio).toFixed(5)}）`);
  await p.click('#btnPause');
  const resumed = await peak();
  check(Math.max(...resumed.webAudio) > 0.01 && resumed.audibleMedia === 0 && resumed.log.sources === 2,
    `${name}: 再開で同じ経路から再び鳴る（音源の生成は開始1回＋再開1回＝${resumed.log.sources}）`);
  // 表示モードを切り替えても音の経路は増えない
  const modes = await p.evaluate(() => [...document.querySelectorAll('#displayMode option')].filter((o) => !o.disabled).map((o) => o.value));
  for (const m of modes) {
    await p.selectOption('#displayMode', m).catch(() => {});
    await p.waitForTimeout(500);
  }
  const after = await peak(4);
  check(after.audibleMedia === 0 && after.ctxCount === 1 && after.log.audibleSeeks === 0 && after.log.mediaPlays.every((x) => x.muted),
    `${name}: 表示モード ${modes.length} 種の切替後も1経路・音の出るメディアのシーク ${after.log.audibleSeeks} 回・動画はすべて無音再生`);
  await ctx.close();
}
await browser.close();
console.log(fails.length ? `\n失敗 ${fails.length} 件` : '\nすべて成功（Chromium での計測。実機の iPhone/Android は未確認）');
process.exit(fails.length ? 1 : 0);
