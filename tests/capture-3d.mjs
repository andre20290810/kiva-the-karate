// 3D 表示の確認動画を作る（時刻を固定刻みで進めて 1 枚ずつ撮り、ffmpeg で MP4 にする）。
//   npm start（別ターミナル）→ node tests/capture-3d.mjs --variant kiva-3d --from 9 --to 15 --fps 24 --hits 9.66,14.49 --out file.mp4
//   --orbit 360 で人物の周りを一周（モデル確認用）。--size 720x900。--keep-frames で連番 PNG を残す
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const base = process.env.BASE || 'http://127.0.0.1:8177/';
const variant = arg('variant', 'kiva-3d');
const from = +arg('from', 0), to = +arg('to', 4), fps = +arg('fps', 24);
const hits = (arg('hits', '') || '').split(',').filter(Boolean).map(Number);
const grade = arg('grade', 'PERFECT');
const orbit = +arg('orbit', 0);
const yaw = +arg('yaw', 0); // 固定のカメラ角度（度）。90 で人物の右側から（奥行きの確認用）
const noFx = process.argv.includes('--no-fx'); // 動作比較用: 演出を消す
const [w, h] = arg('size', '720x900').split('x').map(Number);
const out = arg('out', 'test-results/capture.mp4');
const keep = process.argv.includes('--keep-frames'); // motion_compare.py の --render-dir に使う（連番 PNG を残す）
const frames = out + '.frames';
rmSync(frames, { recursive: true, force: true }); mkdirSync(frames, { recursive: true });
const exe = process.env.CHROME_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await browser.newPage({ viewport: { width: w, height: h } });
p.on('pageerror', (e) => { console.error('pageerror', e.message); process.exitCode = 1; });
await p.goto(base + 'tests/fixtures/preview/three.html');
await p.evaluate(async (v) => { await window.__ready; await window.__stage.setVariant(v); }, variant);
const n = Math.round((to - from) * fps);
let hi = 0;
for (let i = 0; i <= n; i++) {
  const t = from + i / fps;
  const fire = [];
  while (hi < hits.length && hits[hi] <= t + 1e-6) fire.push(hits[hi++]);
  await p.evaluate(({ t, fire, grade, orbit, k, yaw, noFx }) => {
    const st = window.__stage;
    if (noFx && st.vfx) st.vfx.group.visible = false;
    if (yaw && !orbit) {
      st.resize(); const r0 = Math.hypot(st.camera.position.x, st.camera.position.z), a = yaw * Math.PI / 180;
      st.camera.position.set(Math.sin(a) * r0, st.camera.position.y, Math.cos(a) * r0); st.camera.lookAt(0, 0.72, 0);
    }
    if (orbit) {
      const a = k * orbit * Math.PI / 180, d = st.camera.position.length() || 4.2, r = Math.hypot(st.camera.position.x, st.camera.position.z) || 4;
      st.resize(); const r0 = Math.hypot(st.camera.position.x, st.camera.position.z);
      st.camera.position.set(Math.sin(a) * r0, st.camera.position.y, Math.cos(a) * r0); st.camera.lookAt(0, 0.72, 0);
      st.resize = st.resize; // resize は次の sync でサイズが同じなら呼ばれない
    }
    st.sync(t);
    for (const ft of fire) { st.hit({ t: ft, grade, seed: Math.round(ft * 100) }); st.sync(t); }
  }, { t, fire, grade, orbit, k: i / n, yaw, noFx });
  await p.screenshot({ path: join(frames, String(i).padStart(5, '0') + '.png') });
}
await browser.close();
const require = createRequire(import.meta.url);
const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(frames, '%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', out]);
if (!keep) rmSync(frames, { recursive: true, force: true });
console.log('wrote', out, n + 1, 'frames', keep ? '(frames kept in ' + frames + ')' : '');
