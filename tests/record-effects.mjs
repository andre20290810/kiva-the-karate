// エフェクトの見た目の確認用動画（呼吸・構え・突き／打ち・蹴り・旋回）を作る。npm start を別に起動しておく。
//   node tests/record-effects.mjs [出力先]          （ffmpeg が必要。音なし。時間軸どおりの速さ）
// 譜面の最初の Y・X・A（突き／打ち）・A（蹴り）・B の前後 2.5 秒を、0.5 倍速で撮影して等速の動画に戻す。
// 見るところ: 発生位置（拳・足・胴）、残像、透過の縁（白・黒のふち）、床の反射の残り、処理の重さ（draw_ms.csv）。
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:8177/';
const out = process.argv[2] || 'test-results/effects';
mkdirSync(out, { recursive: true });
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const chart = JSON.parse(readFileSync(new URL('../charts/seipai_v2.json', import.meta.url)));
const pick = (f) => chart.notes.find(f);
const clips = [
  ['breath', pick((n) => n.button === 'Y')],
  ['stance', pick((n) => n.button === 'X')],
  ['strike', pick((n) => n.button === 'A' && n.action !== 'kick')],
  ['kick', pick((n) => n.button === 'A' && n.action === 'kick')],
  ['turn', pick((n) => n.button === 'B')],
].filter(([, n]) => n);
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await p.goto(base + '?fresh=1');
await p.waitForFunction(() => document.documentElement.dataset.state === 'ready', null, { timeout: 90000 });
const stand = await p.evaluate(() => window.__app.manifest.standIn);
await p.click('#btnAuto');
await p.click('#btnPlay');
const perf = ['clip,frame,draw_ms'];
for (const [name, n] of clips) {
  const from = Math.max(0, n.time - 1.0), to = n.time + (n.duration || 0) + 1.5;
  const dir = `${out}/${name}`;
  mkdirSync(dir, { recursive: true });
  await p.evaluate(([t]) => { window.__app.seek(t); window.__app.setRate(0.5); window.__app.play(); }, [from]);
  const list = [];
  let k = 0, last = null;
  while (true) {
    const t = await p.evaluate(() => window.__app.t);
    if (t >= to) break;
    const f = `${dir}/${String(k++).padStart(5, '0')}.jpg`;
    await p.screenshot({ path: f, type: 'jpeg', quality: 85 });
    if (last) list.push(`file '${last.f.split('/').pop()}'\nduration ${(t - last.t).toFixed(4)}`);
    last = { f, t };
  }
  list.push(`file '${last.f.split('/').pop()}'\nduration 0.1\nfile '${last.f.split('/').pop()}'`);
  writeFileSync(`${dir}/list.txt`, list.join('\n'));
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', `${dir}/list.txt`, '-vf', 'fps=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', `${out}/${name}.mp4`]);
  // 処理の重さ: 等速で同じ区間を再生し、1 描画にかかった時間を記録
  const ms = await p.evaluate(([t0, t1]) => new Promise((res) => {
    const app = window.__app, orig = app.draw.bind(app), out = [];
    app.draw = (t) => { const s = performance.now(); orig(t); out.push([app.store.indexAt(Math.max(0, t)), +(performance.now() - s).toFixed(2)]); };
    app.setRate(1); app.seek(t0); app.play();
    const chk = () => { if (app.t >= t1) { app.draw = orig; res(out); } else setTimeout(chk, 50); };
    chk();
  }), [from, to]);
  for (const [f, d] of ms) perf.push(`${name},${f},${d}`);
  const sorted = ms.map((x) => x[1]).sort((a, b) => a - b);
  console.log(`${name}: ${n.id} ${n.time}s → ${out}/${name}.mp4（描画 中央値 ${sorted[sorted.length >> 1]}ms、95% ${sorted[Math.floor(sorted.length * 0.95)]}ms）`);
}
writeFileSync(`${out}/draw_ms.csv`, perf.join('\n'));
console.log(stand ? '注意: 人物は代用素材（standIn）です。提供 ZIP の確認にはなりません。' : '人物: 提供素材');
await browser.close();
