// 疑似3Dステージの空間計算（純粋ロジック・描画非依存）。
// カメラは床から高さ camH の位置で水平に奥を向く。床は y=0 の平面。
// 画面座標:  sx = vpX + focal * x / z ,  sy = horizonY + focal * camH / z
// 床は奥(+z)から手前へ流れる（ベルトコンベア）。流れの量 scroll(t) は音声時刻の関数で、
// 一時停止すれば止まり、フレーム落ちしても位置は飛ばない（積分を解析的に計算）。

export const STAGE_DEFAULTS = Object.freeze({
  camH: 1.6,          // カメラの高さ（ワールド単位）
  horizonRatio: 0.34, // 消失点の画面上の高さ（ステージ高に対する比）
  fovRatio: 1.05,     // 焦点距離 = ステージ高 × fovRatio
  near: 0.6,
  far: 60,
  panel: 2.0,         // 床パネルの一辺
  neonEvery: 4,       // 何枚ごとにネオンライン
  corridor: 7.5,      // 柱の並ぶ通路の半幅
  pillarSpacing: 7,
  gateSpacing: 16,
  boostTau: 0.35,     // 加速の減衰時定数（秒）
});

export class StageSpace {
  constructor(params = {}) {
    this.p = { ...STAGE_DEFAULTS, ...params };
    this.view = { w: 1, h: 1 };
    this.boosts = []; // {t0, amp}
    this.speed = params.speed ?? 3.6;
    this.scrollOffset = 0;
    this.layout(1, 1);
  }

  layout(w, h) {
    this.view = { w, h };
    // 縦長画面では人物の頭上に余白を残しつつ床を広く見せるため、消失点をやや上げる
    const portrait = h > w * 1.1;
    this.horizonY = h * (portrait ? this.p.horizonRatio - 0.04 : this.p.horizonRatio);
    this.vpX = w / 2;
    this.focal = h * this.p.fovRatio;
    return this;
  }

  /** 床上の点 (x, z) → 画面座標。z<=near は null */
  project(x, z, y = 0) {
    if (z <= this.p.near) return null;
    const k = this.focal / z;
    return { x: this.vpX + x * k, y: this.horizonY + (this.p.camH - y) * k, k };
  }

  /** 画面の床上の点 → ワールド (x, z)。地平線より上は null */
  unproject(sx, sy) {
    const dy = sy - this.horizonY;
    if (dy <= 0) return null;
    const z = (this.focal * this.p.camH) / dy;
    return { x: ((sx - this.vpX) * z) / this.focal, z };
  }

  /** 画面上の足元の高さから奥行きを求める（人物の立ち位置） */
  depthAtScreenY(sy) {
    const dy = Math.max(1, sy - this.horizonY);
    return (this.focal * this.p.camH) / dy;
  }

  clearBoosts() { this.boosts = []; this.scrollOffset = 0; }

  /** 時刻 t で基本速度を変える（流れた量は連続のまま） */
  setSpeed(v, t = 0) {
    this.scrollOffset += (this.speed - v) * Math.max(0, t);
    this.speed = v;
  }

  /** 技成立時の一瞬の加速（音声時刻 t0 から指数減衰） */
  boost(t0, amp) { this.boosts.push({ t0, amp }); if (this.boosts.length > 64) this.boosts.shift(); }

  /** 時刻 t までに床が流れた量（解析積分。t について単調増加） */
  scroll(t) {
    let s = this.speed * Math.max(0, t) + this.scrollOffset;
    const tau = this.p.boostTau;
    for (const b of this.boosts) {
      if (t > b.t0) s += b.amp * tau * (1 - Math.exp(-(t - b.t0) / tau));
    }
    return s;
  }

  speedAt(t) {
    let v = this.speed;
    for (const b of this.boosts) if (t > b.t0) v += b.amp * Math.exp(-(t - b.t0) / this.p.boostTau);
    return v;
  }

  /**
   * 通路両脇の柱（ワールド座標）。z は奥→手前へ周期的に流れる。
   * @returns {Array<{x:number,z:number,h:number,w:number,side:number,id:number}>}
   */
  pillars(t, count) {
    const S = this.p.pillarSpacing;
    const span = S * Math.max(1, Math.ceil(count / 2));
    const off = this.scroll(t);
    const out = [];
    for (let i = 0; i < count; i++) {
      const side = i % 2 ? 1 : -1;
      const k = Math.floor(i / 2);
      // 奥行きを周期 span でループさせ、手前を抜けたら奥へ戻す
      let z = (((k * S + (side > 0 ? S / 2 : 0) - off) % span) + span) % span;
      z += this.p.near + 1.2;
      const id = k * 2 + (side > 0 ? 1 : 0) + Math.floor((off + k * S) / span) * 1000;
      out.push({ x: side * (this.p.corridor + (hash(id) - 0.5) * 1.2), z, h: 5 + hash(id + 7) * 4, w: 0.8 + hash(id + 3) * 0.5, side, id });
    }
    return out;
  }

  /** 通路をまたぐゲート（奥にのみ表示し、人物に近づく前に消える） */
  gates(t, count) {
    const G = this.p.gateSpacing;
    const span = G * count;
    const off = this.scroll(t) * 0.999;
    const out = [];
    for (let i = 0; i < count; i++) {
      const z = (((i * G - off) % span) + span) % span + 4;
      out.push({ z, w: this.p.corridor * 0.92, h: 6.5, id: i });
    }
    return out;
  }
}

export function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
