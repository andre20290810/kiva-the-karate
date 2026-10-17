// スプライトの描画リスト（WebGL2 / Canvas2D 共通）。
// 1要素 = x, y, w, h, rot, kind, p1, p2, seed, r, g, b, a   （座標・サイズは CSS ピクセル）
// 色は 0..1。blend: a>0 なら通常合成（プリマルチ）、加算合成は add=1 を指定して a に強度を入れる。

export const KIND = Object.freeze({ GLOW: 0, CORE: 1, STREAK: 2, RING: 3, SHARD: 4, SPARK: 5, ARC: 6, SMOKE: 7 });
export const STRIDE = 14; // ... + add

export class SpriteBatch {
  constructor(capacity = 4096) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    this.count = 0;
    this.dropped = 0;
  }

  reset() { this.count = 0; this.dropped = 0; }

  /**
   * @param {number} kind KIND
   * @param {number} add 1=加算合成, 0=通常合成
   */
  push(x, y, w, h, rot, kind, p1, p2, seed, r, g, b, a, add = 1) {
    if (this.count >= this.capacity) { this.dropped++; return; }
    if (!(a > 0.002) || !(w > 0.1) || !(h > 0.1)) return;
    const o = this.count++ * STRIDE;
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = w; d[o + 3] = h; d[o + 4] = rot; d[o + 5] = kind;
    d[o + 6] = p1; d[o + 7] = p2; d[o + 8] = seed; d[o + 9] = r; d[o + 10] = g; d[o + 11] = b; d[o + 12] = a; d[o + 13] = add;
  }
}
