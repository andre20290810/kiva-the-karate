// 公開用の dist/ を作る（2D 版のみ）。許可したファイルだけをコピーし、source/（元動画・ZIP）や旧 3D の
// コード・素材（src/・vendor/・assets/3d/ など）は含めない。
//   node tools/build-dist.mjs            … 実素材が揃っていないと失敗
//   node tools/build-dist.mjs --allow-missing-assets … 素材なしでコードだけ（動作確認用）
//   node tools/build-dist.mjs --allow-stand-in      … ローカル試験用の代用素材でも作る（公開しないこと）
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'dist');
const allowMissing = process.argv.includes('--allow-missing-assets');
const allowStandIn = process.argv.includes('--allow-stand-in');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const copy = (rel) => cpSync(join(root, rel), join(out, rel), { recursive: true });
for (const rel of ['index.html', 'app']) copy(rel);
mkdirSync(join(out, 'charts'), { recursive: true });

// 正式版の譜面・人物画像（manifest と cut/）・音声・BGM だけ（終了した ver1 の素材は含めない）。欠けていれば止める（--allow-missing-assets を除く）
const { GAME } = await import(pathToFileURL(join(root, 'app/config.js')).href);
const stage = ['assets/stage/IMG_7441.JPG', 'assets/stage/IMG_7439.JPG'];
const missing = stage.filter((f) => !existsSync(join(root, f)));
const plan = [];
for (const v of [{ ...GAME, label: '正式版' }]) {
  copy(v.chart);
  const chart = JSON.parse(readFileSync(join(root, v.chart), 'utf8'));
  const man = chart.source.frameManifest, dir = dirname(man);
  const audio = [].concat(chart.audio?.src || []);
  const bgm = (v.bgm || []).flatMap((t) => t.src); // BGM（配信用の AAC と予備の Opus）
  const files = [man, `${dir}/cut`, ...audio, ...bgm];
  for (const f of files) if (!existsSync(join(root, f)) || statSync(join(root, f)).size === 0) missing.push(`${v.label}: ${f}`);
  plan.push({ v, man, files, audio });
}
if (missing.length) {
  if (!allowMissing) { console.error(`素材が不足しています: ${missing.join(', ')}（README「素材の配置」）`); process.exit(1); }
  console.warn('注意: 素材なしで dist を作成しました（公開不可）');
} else {
  for (const { v, man, files, audio } of plan) {
    const manifest = JSON.parse(readFileSync(join(root, man), 'utf8'));
    if (manifest.standIn && !allowStandIn) {
      console.error(`${v.label} の人物画像は代用素材（standIn）です。提供素材から prepare_frames.py で作り直してください（試験だけなら --allow-stand-in）`);
      process.exit(1);
    }
    const cuts = readdirSync(join(root, dirname(man), 'cut')).length;
    if (cuts !== manifest.frameCount) { console.error(`${v.label}: cut/ の画像 ${cuts} 枚と manifest の ${manifest.frameCount} 枚が合いません`); process.exit(1); }
    for (const f of files) copy(f);
    console.log(`${v.label}: 人物画像 ${cuts} 枚・音声 ${audio.length} 件${v.bgm ? `・BGM ${v.bgm.length} 曲（${v.bgm.map((t) => t.label).join('／')}）` : ''}`);
  }
  for (const f of stage) copy(f);
}
// 旧 3D の素材やライブラリが紛れ込んでいないことを確認
let n = 0, bytes = 0;
const bad = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f), s = statSync(p);
    if (s.isDirectory()) walk(p);
    else {
      n++; bytes += s.size;
      if (['.glb', '.gltf', '.blend', '.mp4'].includes(extname(f).toLowerCase()) || /three/i.test(f)) bad.push(p);
    }
  }
};
walk(out);
if (existsSync(join(out, 'source')) || existsSync(join(out, 'src')) || existsSync(join(out, 'vendor')) || bad.length) {
  console.error('dist に含めてはいけないファイルがあります:', bad.slice(0, 5));
  process.exit(1);
}
console.log(`dist/: ${n} ファイル, ${(bytes / 1048576).toFixed(1)} MB`);
