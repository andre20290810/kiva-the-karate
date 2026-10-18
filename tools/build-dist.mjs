// 公開用の dist/ を作る（2D 版のみ）。許可したファイルだけをコピーし、source/（元動画・ZIP）や旧 3D の
// コード・素材（src/・vendor/・assets/3d/ など）は含めない。
//   node tools/build-dist.mjs            … 実素材が揃っていないと失敗
//   node tools/build-dist.mjs --allow-missing-assets … 素材なしでコードだけ（動作確認用）
//   node tools/build-dist.mjs --allow-stand-in      … ローカル試験用の代用素材でも作る（公開しないこと）
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'dist');
const allowMissing = process.argv.includes('--allow-missing-assets');
const allowStandIn = process.argv.includes('--allow-stand-in');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const copy = (rel) => cpSync(join(root, rel), join(out, rel), { recursive: true });
for (const rel of ['index.html', 'app']) copy(rel);
mkdirSync(join(out, 'charts'), { recursive: true });
copy('charts/seipai.json');

const need = ['assets/seipai/manifest.json', 'assets/seipai/cut', 'assets/stage/IMG_7441.JPG', 'assets/stage/IMG_7439.JPG'];
const missing = need.filter((f) => !existsSync(join(root, f)));
if (missing.length) {
  if (!allowMissing) { console.error(`素材が不足しています: ${missing.join(', ')}（README「素材の配置」）`); process.exit(1); }
  console.warn('注意: 素材なしで dist を作成しました（公開不可）');
} else {
  const manifest = JSON.parse(readFileSync(join(root, 'assets/seipai/manifest.json'), 'utf8'));
  if (manifest.standIn && !allowStandIn) {
    console.error('assets/seipai は代用素材（standIn）です。提供 ZIP から prepare_frames.py で作り直してください（試験だけなら --allow-stand-in）');
    process.exit(1);
  }
  for (const f of need) copy(f);
  if (existsSync(join(root, 'assets/seipai/audio.m4a'))) copy('assets/seipai/audio.m4a');
  else console.warn('注意: assets/seipai/audio.m4a がありません（効果音のみで動作します）');
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
