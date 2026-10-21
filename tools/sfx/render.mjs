// 効果音を実際の Sfx クラスで「録音」する（OfflineAudioContext。耳で聞く代わりに波形・周波数も調べられる）。
//   node tools/sfx/render.mjs <出力フォルダ> [sfx モジュールの URL パス（既定 app/sfx.js）]   （npm start の後）
// 出力: sfx_dry.wav（効果音だけ）、sfx_bgm.wav（BGM＝Devil In The Fire を既定の音量で重ねる）、events.json（鳴らした時刻）
// 鳴らす順: Y 呼吸（長押し 2.4 秒 → 完了）、X 構え、A 突き、A 蹴り、B 旋回、各 PERFECT と GOOD、連続打撃（突き 4 回を 0.18 秒間隔）、MISS
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const out = process.argv[2] || 'test-results/sfx';
const mod = process.argv[3] || 'app/sfx.js';
const base = process.env.BASE || 'http://127.0.0.1:8177/';
mkdirSync(out, { recursive: true });
const exe = existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}) });
const p = await browser.newPage();
await p.goto(base + 'index.html?fresh=1');
const res = await p.evaluate(async ({ mod }) => {
  const M = await import(`/${mod}?r=${Math.random()}`), { Sfx } = M;
  const SR = 48000;
  const EVENTS = [];
  let t = 0.3;
  const add = (kind, grade, at, extra = {}) => EVENTS.push({ kind, grade, at, ...extra });
  // Y 長押し（2.4 秒）→ 完了
  EVENTS.push({ kind: 'breathStart', at: t });
  for (let k = 1; k <= 12; k++) EVENTS.push({ kind: 'breathUpdate', at: t + k * 0.2, progress: k / 12 });
  EVENTS.push({ kind: 'breathStop', at: t + 2.4 });
  add('breath', 'PERFECT', t + 2.403); t += 3.6; // 同じ時刻に 2 つは止められないので 1 区切り後
  for (const grade of ['PERFECT', 'GOOD']) {
    for (const kind of ['stance', 'strike', 'kick', 'turn']) { add(kind, grade, t); t += 1.0; }
    t += 0.4;
  }
  for (let k = 0; k < 4; k++) add('strike', 'PERFECT', t + k * 0.18);
  t += 1.4;
  EVENTS.push({ kind: 'miss', at: t }); t += 1.0;
  const dur = t + 0.5;
  async function render(withBgm) {
    const ctx = new OfflineAudioContext(2, Math.ceil(dur * SR), SR);
    // ゲームと同じ出力経路: 効果音の系統（0.9）・BGM（0.4 × 曲の音量合わせ）→ マスター 0.85 → リミッター
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.15;
    const master = ctx.createGain(); master.gain.value = 0.85; master.connect(lim).connect(ctx.destination);
    const sfxBus = ctx.createGain(); sfxBus.gain.value = 0.9; sfxBus.connect(master);
    const bgmBus = ctx.createGain(); bgmBus.gain.value = 0.4 * 10 ** (-4.7 / 20);
    const bgmDuck = ctx.createGain(); bgmDuck.connect(bgmBus).connect(master);
    if (withBgm) {
      const ab = await (await fetch('/assets/seipai_v2/bgm/devil.opus.m4a')).arrayBuffer();
      const buf = await ctx.decodeAudioData(ab);
      const s = ctx.createBufferSource(); s.buffer = buf; s.connect(bgmDuck); s.start(0, 30); // 歌のある 30 秒目から
    }
    const clock = { ctx, sfxBus, bgmDuck, duck: null, mix: true };
    const sfx = new Sfx(clock);
    Object.defineProperty(sfx, 'ctx', { get: () => ctx });
    sfx.volume = M.SFX_MIX_GAIN ?? 1.7; // 変更前の版は 1.7（当時のゲームの値）
    for (const e of EVENTS) {
      ctx.suspend(Math.round(e.at * SR / 128) * 128 / SR).then(() => {
        if (e.kind === 'breathStart') sfx.breathStart();
        else if (e.kind === 'breathUpdate') sfx.breathUpdate?.(e.progress);
        else if (e.kind === 'breathStop') sfx.breathStop(true);
        else if (e.kind === 'miss') sfx.miss();
        else { const pk = sfx.play(e.kind, e.grade); e.peakAfter = pk == null ? null : +(pk - ctx.currentTime).toFixed(4); e.atReal = ctx.currentTime; }
        ctx.resume();
      });
    }
    const buf = await ctx.startRendering();
    const n = buf.length, L = buf.getChannelData(0), R = buf.getChannelData(1);
    const wav = new DataView(new ArrayBuffer(44 + n * 4));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) wav.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); wav.setUint32(4, 36 + n * 4, true); w(8, 'WAVEfmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true);
    wav.setUint16(22, 2, true); wav.setUint32(24, SR, true); wav.setUint32(28, SR * 4, true); wav.setUint16(32, 4, true); wav.setUint16(34, 16, true);
    w(36, 'data'); wav.setUint32(40, n * 4, true);
    for (let i = 0; i < n; i++) {
      wav.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
      wav.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
    }
    let bin = ''; const u8 = new Uint8Array(wav.buffer);
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  return { dry: await render(false), bgm: await render(true), events: EVENTS.map(({ kind, grade, at, peakAfter, atReal }) => ({ kind, grade, at: atReal ?? at, peakAfter })) };
}, { mod });
writeFileSync(`${out}/sfx_dry.wav`, Buffer.from(res.dry, 'base64'));
writeFileSync(`${out}/sfx_bgm.wav`, Buffer.from(res.bgm, 'base64'));
writeFileSync(`${out}/events.json`, JSON.stringify(res.events, null, 1));
console.log(`→ ${out}/sfx_dry.wav, sfx_bgm.wav, events.json`);
await browser.close();
