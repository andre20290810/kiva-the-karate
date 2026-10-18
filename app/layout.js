// 画面配置の計算（純粋関数）。基準は「背景画像が実際に表示される矩形」。

export const BACKGROUNDS = Object.freeze({
  landscape: { src: 'assets/stage/IMG_7441.JPG', w: 1792, h: 1008, letterbox: '#1c130d' },
  portrait: { src: 'assets/stage/IMG_7439.JPG', w: 784, h: 1168, letterbox: '#1c130d' },
});

/** 表示領域の縦横比から向きを決める（横長・正方形 = 横向き） */
export function orientationOf(w, h) { return w >= h ? 'landscape' : 'portrait'; }

/** 背景を縦横比を保って全体を収める矩形（余白は letterbox 色） */
export function containRect(areaW, areaH, imgW, imgH) {
  const s = Math.min(areaW / imgW, areaH / imgH);
  const w = imgW * s, h = imgH * s;
  return { x: (areaW - w) / 2, y: (areaH - h) / 2, w, h, s };
}

/** 背景上部の 4 レーンの領域 */
export function laneRect(bg) {
  const rowH = Math.max(22, Math.min(46, bg.h * 0.058));
  const pad = Math.max(4, bg.h * 0.012);
  return { x: bg.x + pad, y: bg.y + pad, w: bg.w - pad * 2, h: rowH * 4, rowH };
}

/**
 * 直立時の人物の高さ（画面 px）。基本は背景の高さ × referenceHeightRatio。
 * 全コマの人物（fitExtents: アンカーからの上下左右の広がり。単位は直立身長）が、レーンの下〜背景の下端・
 * 背景の左右に収まらない場合だけ小さくする。縦横どちらの向きでも同じ規則。
 */
export function standingHeight(bg, lanes, display, ext) {
  const ax = bg.x + display.subjectAnchor.x * bg.w;
  const ay = bg.y + display.subjectAnchor.y * bg.h;
  const margin = bg.h * 0.01;
  let h = display.referenceHeightRatio * bg.h;
  if (ext) {
    const top = lanes.y + lanes.h + margin;
    if (ext.up > 0) h = Math.min(h, (ay - top) / ext.up);
    if (ext.down > 0) h = Math.min(h, (bg.y + bg.h - margin - ay) / ext.down);
    if (ext.left > 0) h = Math.min(h, (ax - bg.x - margin) / ext.left);
    if (ext.right > 0) h = Math.min(h, (bg.x + bg.w - margin - ax) / ext.right);
  }
  return Math.max(20, h);
}

/**
 * コマ i の描画変換。元画像（576×1024）の座標 p → 画面座標 = origin + (p - anchor) × s。
 * 補正（frameOverrides）: dx, dy は背景の高さに対する割合、scale は倍率。
 */
export function subjectTransform(frame, bg, standH, display) {
  const ov = display.frameOverrides?.[frame.i] || display.frameOverrides?.[String(frame.i)] || {};
  const s = standH * frame.k * (ov.scale ?? 1);
  const ox = bg.x + display.subjectAnchor.x * bg.w + (ov.dx || 0) * bg.h;
  const oy = bg.y + display.subjectAnchor.y * bg.h + (ov.dy || 0) * bg.h;
  return {
    s, ax: frame.anchor[0], ay: frame.anchor[1], ox, oy,
    toScreen(x, y) { return [ox + (x - frame.anchor[0]) * s, oy + (y - frame.anchor[1]) * s]; },
    toSource(X, Y) { return [frame.anchor[0] + (X - ox) / s, frame.anchor[1] + (Y - oy) / s]; },
    crop() {
      const [x, y, w, h] = frame.crop;
      const [X, Y] = this.toScreen(x, y);
      return { x: X, y: Y, w: w * s, h: h * s };
    },
  };
}
