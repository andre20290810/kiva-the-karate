// 人物フレーム画像の管理。
// - 圧縮済みデータ（Blob）は最初に1回だけ取得してメモリに保持（ネットワーク再取得なし）
// - デコード済み画像（ImageBitmap）は再生位置の前後の限られた枚数だけ保持（スマホのメモリ対策）
// フレーム定義（frames.json）は tools/prepare_assets.py が manifest.json から生成する。

export class FrameStore {
  /**
   * @param {{fps:number,width:number,height:number,frames:Array<{i:number,t:number,file:string,bbox?:number[],joints?:object}>}} def
   * @param {string} baseUrl frames.json の置き場所
   */
  constructor(def, baseUrl, { ahead = 20, behind = 6, maxDecoded = 40, decodeHeight = 0 } = {}) {
    this.def = def;
    this.frames = def.frames;
    this.baseUrl = baseUrl;
    this.ahead = ahead;
    this.behind = behind;
    this.maxDecoded = maxDecoded;
    this.decodeHeight = decodeHeight; // 0 なら原寸
    this.blobs = new Array(this.frames.length).fill(null);
    this.bitmaps = new Map(); // index → ImageBitmap
    this.pending = new Map(); // index → Promise
    this.substitute = new Map(); // 不良コマ index → 置換先 index
    this.failed = [];
  }

  get count() { return this.frames.length; }
  get duration() { return this.frames.length ? this.frames[this.frames.length - 1].t + 1 / this.def.fps : 0; }

  applyFixes(fixes) {
    for (const f of fixes) {
      if (f.use != null) this.substitute.set(f.frame, f.use);
    }
  }

  /** 全フレームの圧縮データを取得。onProgress(done,total)。失敗したファイル名は throw に含める。 */
  async fetchAll(onProgress, concurrency = 6) {
    let done = 0;
    let next = 0;
    const total = this.frames.length;
    const worker = async () => {
      while (next < total) {
        const i = next++;
        const url = new URL(this.frames[i].file, this.baseUrl).href;
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          this.blobs[i] = await res.blob();
        } catch (e) {
          this.failed.push(`${this.frames[i].file}: ${e.message}`);
        }
        onProgress?.(++done, total);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (this.failed.length) {
      const e = new Error(`人物画像 ${this.failed.length}/${total} 枚の読み込みに失敗しました\n` + this.failed.slice(0, 5).join('\n'));
      e.code = 'FRAMES_FAILED';
      throw e;
    }
  }

  /** 元動画時刻 → フレーム番号（最も近いフレーム、置換表を適用） */
  indexAt(videoTime) {
    const fps = this.def.fps;
    const t0 = this.frames[0]?.t ?? 0;
    let i = Math.round((videoTime - t0) * fps);
    i = Math.max(0, Math.min(this.frames.length - 1, i));
    return this.substitute.get(i) ?? i;
  }

  _decode(i) {
    if (this.bitmaps.has(i) || this.pending.has(i) || !this.blobs[i]) return;
    // WebGL でも Canvas でも同じ見え方になるよう、アルファはプリマルチで統一
    const opts = { premultiplyAlpha: 'premultiply', ...(this.decodeHeight ? { resizeHeight: this.decodeHeight, resizeQuality: 'high' } : {}) };
    const p = createImageBitmap(this.blobs[i], opts)
      .then((bmp) => { this.bitmaps.set(i, bmp); })
      .catch((e) => { this.failed.push(`${this.frames[i].file}: decode ${e.message}`); })
      .finally(() => this.pending.delete(i));
    this.pending.set(i, p);
  }

  /** 現在位置の前後をデコードし、範囲外を解放する。 */
  prefetch(center) {
    const lo = Math.max(0, center - this.behind);
    const hi = Math.min(this.frames.length - 1, center + this.ahead);
    for (let i = center; i <= hi; i++) this._decode(this.substitute.get(i) ?? i);
    for (let i = center - 1; i >= lo; i--) this._decode(this.substitute.get(i) ?? i);
    if (this.bitmaps.size > this.maxDecoded) {
      const far = [...this.bitmaps.keys()].sort((a, b) => Math.abs(b - center) - Math.abs(a - center));
      for (const i of far) {
        if (this.bitmaps.size <= this.maxDecoded) break;
        if (i >= lo && i <= hi) continue;
        this.bitmaps.get(i).close?.();
        this.bitmaps.delete(i);
      }
    }
  }

  /** 開始位置付近のデコード完了を待つ */
  async warm(center) {
    this.prefetch(center);
    await Promise.all([...this.pending.values()]);
  }

  /** 表示用画像。未デコードなら最も近いデコード済みフレームで代用する。 */
  get(i) {
    const b = this.bitmaps.get(i);
    if (b) return { bmp: b, index: i, exact: true };
    let best = null;
    for (const [k, v] of this.bitmaps) if (!best || Math.abs(k - i) < Math.abs(best.index - i)) best = { bmp: v, index: k, exact: false };
    return best;
  }

  /** 関節座標（元画像座標）。frames.json に無ければ null */
  joint(i, name) {
    const j = this.frames[i]?.joints?.[name];
    return j ? { x: j[0], y: j[1], c: j[2] ?? 1 } : null;
  }

  bbox(i) { return this.frames[i]?.bbox || null; }
}
