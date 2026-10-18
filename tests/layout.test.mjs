import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { containRect, laneRect, standingHeight, subjectTransform, orientationOf, BACKGROUNDS } from '../app/layout.js';
import { DEFAULT_DISPLAY } from '../app/chart.js';

const manifestPath = new URL('../assets/seipai/manifest.json', import.meta.url);
const hasManifest = existsSync(manifestPath);
const VIEWS = { '390x844': [390, 844 - 190], '844x390': [844, 390 - 76], '1366x768': [1366, 768 - 104] };

test('向き: 表示領域の縦横比で決める', () => {
  assert.equal(orientationOf(844, 390), 'landscape');
  assert.equal(orientationOf(390, 844), 'portrait');
});

test('背景は縦横比を保って全体を収める', () => {
  const r = containRect(390, 654, 784, 1168);
  assert.ok(Math.abs(r.w / r.h - 784 / 1168) < 1e-9);
  assert.ok(r.w <= 390 + 1e-9 && r.h <= 654 + 1e-9);
});

test('全 412 コマ: 胴体の中心が背景の中央、レーンと重ならず背景に収まる、倍率が脈打たない', { skip: !hasManifest && 'assets/seipai/manifest.json がありません' }, () => {
  const m = JSON.parse(readFileSync(manifestPath));
  assert.equal(m.frames.length, 412);
  for (const [name, [w, h]] of Object.entries(VIEWS)) {
    const bgDef = BACKGROUNDS[orientationOf(w, h + (name === '390x844' ? 190 : 0))];
    const bg = containRect(w, h, bgDef.w, bgDef.h);
    const L = laneRect(bg);
    const standH = standingHeight(bg, L, DEFAULT_DISPLAY, m.fitExtents);
    let outside = 0, overLanes = 0;
    let prevS = null, maxJump = 0;
    for (const f of m.frames) {
      const T = subjectTransform(f, bg, standH, DEFAULT_DISPLAY);
      const [ax, ay] = T.toScreen(f.anchor[0], f.anchor[1]);
      assert.ok(Math.abs(ax - (bg.x + bg.w / 2)) < 1e-6 && Math.abs(ay - (bg.y + bg.h / 2)) < 1e-6, `${name} frame ${f.i} not centered`);
      const [x0, y0] = T.toScreen(f.bbox[0], f.bbox[1]);
      const [x1, y1] = T.toScreen(f.bbox[0] + f.bbox[2], f.bbox[1] + f.bbox[3]);
      if (x0 < bg.x - 1 || x1 > bg.x + bg.w + 1 || y1 > bg.y + bg.h + 1) outside++;
      if (y0 < L.y + L.h) overLanes++;
      if (prevS) maxJump = Math.max(maxJump, Math.abs(T.s / prevS - 1));
      prevS = T.s;
    }
    // fitExtents は 99.5 パーセンタイル（代用素材の床の反射などのゴミに引きずられないため）なので、最大 2 コマまで許容
    assert.ok(outside <= 2, `${name}: 背景からはみ出すコマ ${outside}`);
    assert.ok(overLanes <= 2, `${name}: レーンに重なるコマ ${overLanes}`);
    assert.ok(maxJump < 0.05, `${name}: 隣のコマとの倍率差 ${(maxJump * 100).toFixed(1)}%`);
    // 直立時の高さは背景の高さの 55% 前後（収まらない場合だけ小さく）
    assert.ok(standH <= 0.55 * bg.h + 1e-6 && standH >= 0.4 * bg.h, `${name}: standH ${(standH / bg.h).toFixed(2)}`);
  }
});
