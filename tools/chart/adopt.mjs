// 編集モードで書き出した譜面 JSON を、公開版の初期設定（charts/seipai_v2.json）に取り込む。
//   node tools/chart/adopt.mjs <書き出した JSON> [--dry-run]
// 検証（正式版の譜面か・ノーツ・エフェクト番号・frameOverrides）に通ったものだけを、書き出しと同じ形式で上書きする。
// 取り込んだ後は、コミット → 公開（DEPLOY.md）で、ほかの端末も同じ設定で起動する。ブラウザの保存だけでは公開版は変わらない。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { GAME } from '../../app/config.js';
import { validateChart, exportChart, normalizeChart } from '../../app/chart.js';
import { resolveEffect } from '../../app/effects-catalog.js';

const [src, flag] = process.argv.slice(2);
if (!src) { console.error('使い方: node tools/chart/adopt.mjs <書き出した JSON> [--dry-run]'); process.exit(2); }
const root = new URL('../../', import.meta.url);
const dest = new URL(GAME.chart, root);
const obj = JSON.parse(readFileSync(src, 'utf8'));
const manifestUrl = new URL(obj.source?.frameManifest ?? 'assets/seipai_v2/manifest.json', root);
const frameCount = existsSync(manifestUrl) ? JSON.parse(readFileSync(manifestUrl, 'utf8')).frameCount : undefined;
const { errors, warnings } = validateChart(obj, { gameVersion: GAME.gameVersion, frameCount });
if (errors.length) { console.error(`取り込めません（${errors.length} 件）:\n- ${errors.join('\n- ')}`); process.exit(1); }
const cur = normalizeChart(JSON.parse(readFileSync(dest, 'utf8')));
const next = normalizeChart(obj);
const byId = new Map(cur.notes.map((n) => [n.id, n]));
const changed = next.notes.filter((n) => JSON.stringify(n) !== JSON.stringify(byId.get(n.id)));
const removed = cur.notes.filter((n) => !next.notes.some((x) => x.id === n.id));
console.log(`ノーツ ${next.notes.length}（変更・追加 ${changed.length}、削除 ${removed.length}）、frameOverrides ${Object.keys(next.display.frameOverrides).length}`);
for (const n of changed) { const r = resolveEffect(n); console.log(`  ${n.id} ${n.time.toFixed(2)}s ${n.button} → エフェクト No.${r.id} ${r.def.name}`); }
for (const w of warnings) console.log(`注意: ${w}`);
if (flag === '--dry-run') { console.log('（--dry-run: 書き込みません）'); process.exit(0); }
writeFileSync(dest, exportChart(obj));
console.log(`${GAME.chart} に取り込みました。コミットして公開すると、ほかの端末もこの設定で起動します。`);
