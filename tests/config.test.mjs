import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { GAME } from '../app/config.js';
import { validateChart, normalizeChart, exportChart, parseChartText, chartVersion } from '../app/chart.js';

const read = (rel) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url)));

test('正式版: 旧 ver2 の保存先・譜面・素材のまま（ブラウザの保存内容を引き継ぐ）', () => {
  // 既存の保存先は変えない（deviceDefault・chartBase・chartBackup・history は後から追加）
  assert.deepEqual({ ...GAME.keys }, { autosave: 'kiva2d.v2.chart.autosave', deviceDefault: 'kiva2d.v2.chart.default', chartBase: 'kiva2d.v2.chart.base', chartBackup: 'kiva2d.v2.chart.backup', history: 'kiva2d.v2.history', best: 'kiva2d.v2.best.manual', audio: 'kiva2d.v2.audio' });
  assert.equal(GAME.gameVersion, 'v2');
  assert.equal(GAME.chart, 'charts/seipai_v2.json');
  const c = read(GAME.chart);
  assert.equal(c.source.frameManifest, 'assets/seipai_v2/manifest.json');
  assert.ok(!existsSync(new URL('../charts/seipai.json', import.meta.url)), 'ver1 の譜面は削除済み');
});

test('正式版の譜面は通り、素材・音声も正式版のもの', { skip: !existsSync(new URL('../assets/seipai_v2/manifest.json', import.meta.url)) && '素材なし' }, () => {
  const c = read(GAME.chart), m = read(c.source.frameManifest);
  assert.deepEqual(validateChart(c, { frameCount: m.frameCount, gameVersion: GAME.gameVersion }).errors, []);
  for (const a of [].concat(c.audio.src)) assert.ok(a.startsWith('assets/seipai_v2/'));
});

test('JSON: 旧 ver2 の JSON は読み込め、書き出しも同じ形。ver1 の JSON（gameVersion なし・"v1"）は読み込まない', () => {
  const v2 = read(GAME.chart);
  assert.ok(parseChartText(JSON.stringify(v2), { gameVersion: 'v2' }).ok);
  const again = parseChartText(exportChart(normalizeChart(v2)), { gameVersion: 'v2' });
  assert.ok(again.ok);
  assert.equal(JSON.parse(exportChart(again.chart)).gameVersion, 'v2');
  assert.equal(exportChart(again.chart), exportChart(normalizeChart(v2)));
  const legacy = { ...v2 }; delete legacy.gameVersion;
  assert.equal(chartVersion(legacy), 'v1');
  const r1 = parseChartText(JSON.stringify(legacy), { gameVersion: 'v2' });
  assert.ok(!r1.ok && /終了した ver1/.test(r1.errors[0]), r1.errors[0]);
  const r2 = parseChartText(JSON.stringify({ ...v2, gameVersion: 'v1' }), { gameVersion: 'v2' });
  assert.ok(!r2.ok && /ver1/.test(r2.errors[0]));
});

test('BGM: 3 曲、初期は Devil In The Fire、配信用の AAC と予備の Opus', () => {
  assert.deepEqual(GAME.bgm.map((t) => t.label), ['Devil In The Fire', 'AUTODRIVING THE SPEAR', 'UPRISING OVERDRIVE VORTEX']);
  assert.equal(GAME.defaultBgm, 'devil');
  for (const t of GAME.bgm) {
    assert.ok(/\.m4a$/.test(t.src[0]) && !/opus/.test(t.src[0]));
    assert.ok(/opus/.test(t.src[1]));
    assert.ok(!t.src.some((u) => /^https?:|drive\.google/.test(u)));
  }
});
