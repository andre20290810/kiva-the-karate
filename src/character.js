// 人物の配置と接地。
// - 全フレームの人物領域の和集合に合わせた「共通の1つの倍率・基準点」で元画像を配置する
//   （フレームごとの拡大はしない → 体の大きさや足元が跳ねない／元の踏み込み・前後移動は残る）
// - 足元は表示中フレームの関節（かかと・つま先・足首）から求め、接地影・床の衝撃・反射の基準にする
//   （画像が 5fps で切り替わるので、影も同じフレームで切り替える＝画像とずれない）

const FOOT_JOINTS = ['left_heel', 'right_heel', 'left_foot', 'right_foot', 'left_ankle', 'right_ankle'];

export class CharacterRig {
  /**
   * @param {import('./frames.js').FrameStore} frames
   * @param {{margin?:number, heightRatio?:number, baseRatio?:number, keys?:Array}} cameraDef
   */
  constructor(frames, cameraDef = {}) {
    this.frames = frames;
    this.def = cameraDef;
    this.union = unionBox(frames, cameraDef.margin ?? 0.04);
    this.keys = (cameraDef.keys || []).slice().sort((a, b) => a.t - b.t);
    this.footCache = new Map();
  }

  /** 画面の大きさから共通カメラを求める（時刻で区間カメラを補間） */
  camera(t, view) {
    const b = this._box(t);
    const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    const hr = this.def.heightRatio ?? (view.h > view.w * 1.1 ? 0.86 : 0.9);
    const scale = Math.min((view.w * 0.92) / bw, (view.h * hr) / bh);
    const baseY = view.h * (this.def.baseRatio ?? 0.965); // 和集合の下端（最も手前の足元）
    const ox = view.w / 2 - (b.x0 + bw / 2) * scale;
    const oy = baseY - b.y1 * scale;
    return {
      scale, ox, oy,
      toScreen: (x, y) => ({ x: ox + x * scale, y: oy + y * scale }),
      rect: { x: ox, y: oy, w: this.frames.def.width * scale, h: this.frames.def.height * scale },
    };
  }

  _box(t) {
    const b = this.union;
    if (!this.keys.length) return b;
    const toBox = (k) => ({ x0: k.box[0], y0: k.box[1], x1: k.box[0] + k.box[2], y1: k.box[1] + k.box[3] });
    if (t <= this.keys[0].t) return toBox(this.keys[0]);
    for (let i = 0; i < this.keys.length - 1; i++) {
      const a = this.keys[i], c = this.keys[i + 1];
      if (t < c.t) {
        const u = (t - a.t) / (c.t - a.t);
        const s = u * u * (3 - 2 * u);
        const A = toBox(a), C = toBox(c);
        return { x0: A.x0 + (C.x0 - A.x0) * s, y0: A.y0 + (C.y0 - A.y0) * s, x1: A.x1 + (C.x1 - A.x1) * s, y1: A.y1 + (C.y1 - A.y1) * s };
      }
    }
    return toBox(this.keys[this.keys.length - 1]);
  }

  /**
   * フレームの足元（元画像座標）。信頼できる足の関節がなければ人物領域の下端。
   * @returns {{x:number,y:number,spread:number,source:'joints'|'bbox'|'none'}}
   */
  foot(i) {
    if (this.footCache.has(i)) return this.footCache.get(i);
    const f = this.frames.frames[i];
    let res = { x: this.frames.def.width / 2, y: this.union.y1, spread: 60, source: 'none' };
    const pts = [];
    for (const n of FOOT_JOINTS) {
      const j = f?.joints?.[n];
      if (j && (j[2] ?? 1) >= 0.5 && j[1] > 0 && j[1] <= this.frames.def.height * 1.02) pts.push(j);
    }
    if (pts.length >= 2) {
      const xs = pts.map((p) => p[0]);
      res = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: Math.max(...pts.map((p) => p[1])), spread: Math.max(40, Math.max(...xs) - Math.min(...xs)), source: 'joints' };
    } else if (f?.bbox) {
      const [x, y, w, h] = f.bbox;
      res = { x: x + w / 2, y: y + h, spread: Math.max(40, w * 0.6), source: 'bbox' };
    }
    // bbox の下端が足の関節より下にある場合（足先が関節推定より低い）はそちらを採用
    if (f?.bbox && res.source === 'joints') res.y = Math.max(res.y, Math.min(f.bbox[1] + f.bbox[3], res.y + 25));
    this.footCache.set(i, res);
    return res;
  }

  /** 技の接触位置の推定（譜面の fx 指定 > 関節 > 人物領域の相対位置） */
  anchor(fx, i) {
    const at = fx?.at || {};
    if (at.x != null) return { x: at.x, y: at.y };
    if (at.joint) {
      const j = this.frames.joint(i, at.joint);
      if (j && j.c >= (at.minConf ?? 0.5)) return { x: j.x + (at.dx || 0), y: j.y + (at.dy || 0) };
    }
    const b = this.frames.bbox(i);
    const rel = at.rel || [0.5, 0.42];
    if (b) return { x: b[0] + b[2] * rel[0], y: b[1] + b[3] * rel[1] };
    return { x: this.frames.def.width / 2, y: this.frames.def.height * 0.45 };
  }

  /** 技の向き: 体の中心→手首（信頼できる場合）。なければ上向き */
  direction(i, anchor) {
    const f = this.frames.frames[i];
    const hipL = f?.joints?.left_hip, hipR = f?.joints?.right_hip;
    if (hipL && hipR) {
      const cx = (hipL[0] + hipR[0]) / 2, cy = (hipL[1] + hipR[1]) / 2 - 120;
      const dx = anchor.x - cx, dy = anchor.y - cy;
      if (Math.hypot(dx, dy) > 40) return Math.atan2(dy, dx);
    }
    return -Math.PI / 2;
  }
}

function unionBox(frames, margin) {
  const { width: W, height: H } = frames.def;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of frames.frames) {
    if (!f.bbox || !(f.bbox[2] > 0 && f.bbox[3] > 0)) continue;
    const [x, y, w, h] = f.bbox;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = W; y1 = H; }
  const mw = (x1 - x0) * margin, mh = (y1 - y0) * margin;
  return { x0: x0 - mw, y0: y0 - mh, x1: x1 + mw, y1: y1 + mh * 0.3 };
}
