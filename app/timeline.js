// 時間軸の目盛り（編集画面のタイムラインと成績画面の照合タイムラインで共通）。
// 0 秒 = 演武の始まり。1 秒ごとに太い目盛り、コマの間隔（0.2 秒）で細い目盛り。秒の数字は 1 秒あたりの幅が広ければ毎秒、狭ければ 5 秒ごと。

export const FRAME = 0.2;

/** 目盛り: [{t, whole, label}]（label は数字を出す目盛りだけ） */
export function timeTicks(t0, t1, pxPerS) {
  const out = [];
  const first = Math.ceil((t0 - 1e-9) / FRAME);
  for (let k = first; k * FRAME <= t1 + 1e-9; k++) {
    const s = Math.round(k * FRAME * 1000) / 1000 + 0; // + 0: -0 を 0 に
    const whole = Math.abs(s - Math.round(s)) < 1e-6;
    if (!whole && pxPerS * FRAME < 6) continue;
    const label = whole && (pxPerS > 30 || Math.round(s) % 5 === 0) ? `${Math.round(s)}s` : null;
    out.push({ t: s, whole, label });
  }
  return out;
}
