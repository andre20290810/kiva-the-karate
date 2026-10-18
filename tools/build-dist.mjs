// 公開用の dist/ を作る。許可した加工済みファイルだけをコピーし、source/（元動画・ZIP）は含めない。
//   node tools/build-dist.mjs            … 実素材（assets/seipai）が揃っていないと失敗
//   node tools/build-dist.mjs --allow-missing-assets … 素材なしでコードだけ（動作確認用）
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'dist');
const allowMissing = process.argv.includes('--allow-missing-assets');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const copy = (rel) => cpSync(join(root, rel), join(out, rel), { recursive: true });
for (const rel of ['index.html', 'style.css', 'src']) copy(rel);
mkdirSync(join(out, 'charts'), { recursive: true });
for (const f of readdirSync(join(root, 'charts')).filter((f) => f.endsWith('.json'))) copy(join('charts', f));

// Bundle user-provided original video explicitly for KIVA original-video mode.
const originalMovie = join(root, 'source', 'seipai.mp4');
if (existsSync(originalMovie)) {
  mkdirSync(join(out, 'assets', 'seipai'), { recursive: true });
  cpSync(originalMovie, join(out, 'assets', 'seipai', 'original.mp4'));
} else if (!allowMissing) {
  console.error('Original video missing: source/seipai.mp4');
  process.exit(1);
}
const assets = join(root, 'assets', 'seipai');
const required = ['frames.json', 'audio.m4a', 'frames'];
const missing = required.filter((f) => !existsSync(join(assets, f)));
if (missing.length) {
  if (!allowMissing) { console.error(`実素材が不足しています: assets/seipai/${missing.join(', ')}`); process.exit(1); }
  console.warn('注意: 実素材なしで dist を作成しました（公開不可）');
} else {
  mkdirSync(join(out, 'assets', 'seipai', 'frames'), { recursive: true });
  for (const f of ['frames.json', 'audio.m4a', 'audio.ogg']) if (existsSync(join(assets, f))) copy(join('assets', 'seipai', f));
  for (const f of readdirSync(join(assets, 'frames')).filter((f) => /\.webp$/i.test(f))) copy(join('assets', 'seipai', 'frames', f));
}
// Browser Three.js modules and Blender-exported technical motion prototype.
mkdirSync(join(out,'vendor','three'),{recursive:true});
cpSync(join(root,'vendor','three','three.module.js'),join(out,'vendor','three','three.module.js'));
cpSync(join(root,'vendor','three','three.core.js'),join(out,'vendor','three','three.core.js'));
cpSync(join(root,'vendor','three','addons'),join(out,'vendor','three','addons'),{recursive:true});
mkdirSync(join(out,'assets','3d'),{recursive:true});
// スキン付き人体モデル（tools/character-3d で作成、assets/3d/ に置く）。無い場合だけ旧プロトタイプを入れる。
const glb = [
  ['assets/3d/kiva_seipai.glb', 'kiva_seipai.glb'], ['assets/3d/alexandre_seipai.glb', 'alexandre_seipai.glb'],
  ['assets/3d/kiva_demo.glb', 'kiva_demo.glb'], ['assets/3d/alexandre_demo.glb', 'alexandre_demo.glb'],
  ['prototypes/kiva_motion_2d_reference.glb', 'kiva_motion.glb'], ['prototypes/alexandre_appearance_proxy.glb', 'alexandre_proxy.glb'],
];
for (const [src, name] of glb) if (existsSync(join(root, src))) cpSync(join(root, src), join(out, 'assets', '3d', name));
for (const who of ['kiva', 'alexandre']) {
  if (!existsSync(join(out, 'assets', '3d', `${who}_seipai.glb`))) console.warn(`注意: ${who} の人体モデル GLB がありません（3D モードは旧プロトタイプ表示になります）`);
}
let n = 0, bytes = 0;
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else { n++; bytes += s.size; } } };
walk(out);
if (existsSync(join(out, 'source'))) { console.error('source/ が混入しました'); process.exit(1); }
console.log(`dist/: ${n} ファイル, ${(bytes / 1048576).toFixed(1)} MB`);
