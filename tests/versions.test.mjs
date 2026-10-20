import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GAME_VERSIONS, parseVersion, resolveVersion } from '../app/versions.js';
import { validateChart, normalizeChart, exportChart, parseChartText, chartVersion } from '../app/chart.js';

const read = (rel) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url)));

test('バージョンの決め方: URL → 最後に選んだもの → ver1', () => {
  assert.equal(parseVersion('2'), 'v2');
  assert.equal(parseVersion('ver1'), 'v1');
  assert.equal(parseVersion('v9'), null);
  assert.equal(resolveVersion(new URLSearchParams('v=v2'), 'v1'), 'v2');
  assert.equal(resolveVersion(new URLSearchParams(''), 'v2'), 'v2');
  assert.equal(resolveVersion(new URLSearchParams('v=bogus'), null), 'v1');
});

test('保存先はバージョンごとに別。ver1 は従来のキーのまま', () => {
  assert.equal(GAME_VERSIONS.v1.keys.autosave, 'kiva2d.chart.autosave.v1');
  assert.equal(GAME_VERSIONS.v1.keys.best, 'kiva2d.best.manual');
  const all = Object.values(GAME_VERSIONS).flatMap((v) => Object.values(v.keys));
  assert.equal(new Set(all).size, all.length);
});

test('各バージョンの初期譜面: 自分のバージョンで通り、素材・音声もそのバージョンのもの', () => {
  for (const v of Object.values(GAME_VERSIONS)) {
    const c = read(v.chart);
    const m = read(c.source.frameManifest);
    const r = validateChart(c, { frameCount: m.frameCount, gameVersion: v.id });
    assert.deepEqual(r.errors, [], v.label);
    assert.equal(chartVersion(c), v.id);
    assert.equal(c.source.frameCount, m.frameCount);
    const dir = c.source.frameManifest.replace(/\/manifest\.json$/, '');
    for (const a of [].concat(c.audio.src)) assert.ok(a.startsWith(dir + '/'), `${v.label}: 音声 ${a} が別の素材の場所`);
  }
  assert.notEqual(read(GAME_VERSIONS.v1.chart).source.frameManifest, read(GAME_VERSIONS.v2.chart).source.frameManifest);
});

test('JSON: 対象バージョンを書き出し、別バージョンの JSON は読み込まない。指定のない従来の JSON は ver1', () => {
  const v1 = read(GAME_VERSIONS.v1.chart), v2 = read(GAME_VERSIONS.v2.chart);
  assert.equal(v1.gameVersion, undefined); // 従来の JSON
  assert.equal(normalizeChart(v1).gameVersion, 'v1');
  assert.ok(parseChartText(JSON.stringify(v1), { gameVersion: 'v1' }).ok);
  const bad = parseChartText(JSON.stringify(v1), { gameVersion: 'v2' });
  assert.ok(!bad.ok && /ver1 用/.test(bad.errors[0]), bad.errors[0]);
  const bad2 = parseChartText(JSON.stringify(v2), { gameVersion: 'v1' });
  assert.ok(!bad2.ok && /ver2 用/.test(bad2.errors[0]));
  const out = JSON.parse(exportChart(normalizeChart(v2)));
  assert.equal(out.gameVersion, 'v2');
  const again = parseChartText(exportChart(normalizeChart(v2)), { gameVersion: 'v2' });
  assert.ok(again.ok);
  assert.equal(exportChart(again.chart), exportChart(normalizeChart(v2)));
  assert.ok(validateChart({ ...v2, gameVersion: 'x2' }).errors.length);
});

test('ver2 の BGM: 3 曲、初期は Devil In The Fire、配信用の AAC と予備の Opus。ver1 には BGM なし', () => {
  const v2 = GAME_VERSIONS.v2;
  assert.deepEqual(v2.bgm.map((t) => t.label), ['Devil In The Fire', 'AUTODRIVING THE SPEAR', 'UPRISING OVERDRIVE VORTEX']);
  assert.equal(v2.defaultBgm, 'devil');
  for (const t of v2.bgm) {
    assert.ok(/\.m4a$/.test(t.src[0]) && !/opus/.test(t.src[0]), `${t.label}: 先頭は AAC`);
    assert.ok(/opus/.test(t.src[1]), `${t.label}: 予備は Opus`);
    assert.ok(!t.src.some((u) => /drive\.google|^https?:/.test(u)), `${t.label}: 配信用素材（Drive の URL ではない）`);
  }
  assert.equal(GAME_VERSIONS.v1.bgm, undefined);
  assert.equal(GAME_VERSIONS.v1.keys.audio, undefined);
});
