// 音声時刻 → 元動画時刻 の写像（純粋関数）。
// 各ノーツの判定時刻 t に、対応動作の「決め」の元動画時刻 kime が一致するように
// 区分線形の写像を作る。決めと決めの間は、
//   - 元動画の区間が音楽の区間より短い → 決めのポーズを保持してから次の動作へ
//   - 長い → 再生速度を上げる（maxRate を超えたら警告）
// とし、元の型の順序（単調増加）を保つ。逆再生は発生しない。

export const WARP_DEFAULTS = Object.freeze({
  maxHoldRatio: 0.6, // 区間のうち決め保持に使える最大割合
  minRate: 0.5,      // これより遅い再生は不自然として警告
  maxRate: 1.8,      // これより速い再生は不自然として警告
});

/**
 * @param {Array<{t:number,kime:number,hold?:number}>} anchors 音声時刻 t と元動画の決め時刻 kime
 * @param {{start:{t:number,v:number}, end:{t:number,v:number}}} bounds 先頭・末尾の対応点
 * @returns {{segments:Array, warnings:string[], map:(t:number)=>number, rateAt:(t:number)=>number}}
 */
export function buildWarp(anchors, bounds, opts = {}) {
  const o = { ...WARP_DEFAULTS, ...opts };
  const pts = [
    { t: bounds.start.t, kime: bounds.start.v, hold: 0, edge: true },
    ...[...anchors].sort((a, b) => a.t - b.t),
    { t: bounds.end.t, kime: bounds.end.v, hold: 0, edge: true },
  ];
  const segments = [];
  const warnings = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const S = b.t - a.t;
    const V = b.kime - a.kime;
    if (!(S > 0)) { warnings.push(`音声時刻が単調増加していません: ${a.t} → ${b.t}`); continue; }
    if (V < 0) { warnings.push(`元動画の決め時刻が逆順です（逆再生になる）: ${a.kime} → ${b.kime}`); }
    // 決めの保持（ポーズ）。明示値があれば優先、なければ余った時間を保持に回す。
    let hold;
    if (a.hold != null && !a.edge) hold = Math.min(a.hold, S * 0.95);
    else hold = a.edge ? 0 : Math.max(0, Math.min(S - Math.max(V, 0), S * o.maxHoldRatio));
    const moveS = S - hold;
    const rate = moveS > 0 ? Math.max(V, 0) / moveS : 0;
    if (V > 0 && (rate > o.maxRate || rate < o.minRate)) {
      warnings.push(`区間 ${a.t.toFixed(2)}–${b.t.toFixed(2)}s の再生速度 ${rate.toFixed(2)}x が範囲外です`);
    }
    if (hold > 0) segments.push({ t0: a.t, t1: a.t + hold, v0: a.kime, v1: a.kime, rate: 0, kind: 'hold' });
    segments.push({ t0: a.t + hold, t1: b.t, v0: a.kime, v1: a.kime + Math.max(V, 0), rate, kind: 'move' });
  }

  const find = (t) => {
    let lo = 0, hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segments[mid].t0 <= t) lo = mid; else hi = mid - 1;
    }
    return segments[lo];
  };
  const map = (t) => {
    if (!segments.length) return bounds.start.v;
    if (t <= segments[0].t0) return segments[0].v0;
    const last = segments[segments.length - 1];
    if (t >= last.t1) return last.v1;
    const s = find(t);
    const span = s.t1 - s.t0;
    return span > 0 ? s.v0 + (s.v1 - s.v0) * ((t - s.t0) / span) : s.v1;
  };
  const rateAt = (t) => (segments.length ? find(t).rate : 0);
  return { segments, warnings, map, rateAt };
}
