// 人物の連続画像（枚数は manifest のとおり）の読み込みと、上限付きのデコード済みキャッシュ。
// - 圧縮データ（切り出し済み WebP、合計 数 MB）は最初に全部取得してメモリに保持
// - デコード済み画像は再生位置の前後だけ（既定 最大 48 枚）。範囲外は close() して解放
//   （例: 412 枚を元の 576×1024 で全部デコードすると RGBA だけで約 927 MiB になるため）
// - 表示するコマがまだデコードされていなければ、最も近いデコード済みのコマを出す（人物が消えない）

export class FrameStore {
  constructor(manifest, baseUrl, { ahead = 16, behind = 8, maxDecoded = 48 } = {}) {
    this.m = manifest;
    this.frames = manifest.frames;
    this.baseUrl = baseUrl;
    this.ahead = ahead;
    this.behind = behind;
    this.maxDecoded = maxDecoded;
    this.blobs = new Array(this.frames.length).fill(null);
    this.bitmaps = new Map();
    this.pending = new Map();
    this.failed = [];
    this.disposed = false;
  }

  get count() { return this.frames.length; }
  get interval() { return this.m.frameIntervalSeconds; }

  /** 時間軸の時刻 → コマ番号（timestamps.csv の時刻のうち、その時刻以前で最も新しいもの） */
  indexAt(t) {
    const f = this.frames;
    if (t <= f[0].t) return 0;
    // 0.2 秒間隔を仮定して当たりを付け、前後を時刻で確認（timestamps.csv の微小なずれにも対応）
    let i = Math.min(f.length - 1, Math.max(0, Math.floor((t - f[0].t) / this.interval + 1e-6)));
    while (i + 1 < f.length && f[i + 1].t <= t + 1e-6) i++;
    while (i > 0 && f[i].t > t + 1e-6) i--;
    return i;
  }

  async fetchAll(onProgress, concurrency = 6) {
    let next = 0, done = 0;
    const total = this.frames.length;
    const worker = async () => {
      while (next < total && !this.disposed) {
        const i = next++;
        const url = new URL(this.frames[i].file, this.baseUrl).href;
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          this.blobs[i] = await r.blob();
        } catch (e) { this.failed.push(`${this.frames[i].file}: ${e.message}`); }
        onProgress?.(++done, total);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (this.failed.length) {
      throw new Error(`人物画像 ${this.failed.length}/${total} 枚を読み込めませんでした\n${this.failed.slice(0, 4).join('\n')}`);
    }
  }

  _decode(i) {
    if (this.bitmaps.has(i) || this.pending.has(i) || !this.blobs[i] || this.disposed) return;
    const p = createImageBitmap(this.blobs[i], { premultiplyAlpha: 'premultiply' })
      .then((b) => {
        if (this.disposed) { b.close?.(); return; }
        this.bitmaps.set(i, b);
        this._trim(); // デコード完了が重なっても上限を超えない
      })
      .catch((e) => this.failed.push(`${this.frames[i].file}: decode ${e.message}`))
      .finally(() => this.pending.delete(i));
    this.pending.set(i, p);
  }

  prefetch(center) {
    this.center = center;
    const lo = Math.max(0, center - this.behind), hi = Math.min(this.count - 1, center + this.ahead);
    for (let i = center; i <= hi; i++) this._decode(i);
    for (let i = center - 1; i >= lo; i--) this._decode(i);
    this._trim();
  }

  /** 上限を超えた分を、現在位置から遠い順に解放する */
  _trim() {
    if (this.bitmaps.size <= this.maxDecoded) return;
    const c = this.center ?? 0;
    const far = [...this.bitmaps.keys()].sort((a, b) => Math.abs(b - c) - Math.abs(a - c));
    for (const i of far) {
      if (this.bitmaps.size <= this.maxDecoded) break;
      if (i === c) continue;
      this.bitmaps.get(i).close?.();
      this.bitmaps.delete(i);
    }
  }

  async warm(center) {
    this.prefetch(center);
    await Promise.all([...this.pending.values()]);
  }

  /** 表示用。{bmp, index, exact}（未デコードなら最も近いデコード済みのコマ） */
  get(i) {
    const b = this.bitmaps.get(i);
    if (b) return { bmp: b, index: i, exact: true };
    let best = null;
    for (const [k, v] of this.bitmaps) if (!best || Math.abs(k - i) < Math.abs(best.index - i)) best = { bmp: v, index: k, exact: false };
    return best;
  }

  /** デコード済みのときだけ返す（残像用。無理にデコードを待たない） */
  peek(i) { return this.bitmaps.get(i) || null; }

  dispose() {
    this.disposed = true;
    for (const b of this.bitmaps.values()) b.close?.();
    this.bitmaps.clear();
    this.blobs.fill(null);
  }
}
