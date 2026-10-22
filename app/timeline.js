// 時間軸の目盛り（編集画面のタイムラインと成績画面の照合タイムラインで共通）。
// 0 秒 = 演武の始まり。1 秒ごとに太い目盛り、コマの間隔（0.2 秒）で細い目盛り。秒の数字は 1 秒あたりの幅が広ければ毎秒、狭ければ 5 秒ごと（さらに狭ければ重ならない間隔）。

export const FRAME = 0.2;

/** 秒の数字の間隔: 1 秒 = 30px を超えれば毎秒、それ以下は 5 秒ごと。さらに狭い（スマホの全体表示など）ときは数字が重ならない間隔（10・20・30 秒） */
export function labelStep(pxPerS) {
  if (pxPerS > 30) return 1;
  return [5, 10, 20, 30, 60].find((k) => k * pxPerS >= 34) ?? 60;
}

/** 目盛り: [{t, whole, label}]（label は数字を出す目盛りだけ） */
export function timeTicks(t0, t1, pxPerS) {
  const out = [];
  const first = Math.ceil((t0 - 1e-9) / FRAME);
  for (let k = first; k * FRAME <= t1 + 1e-9; k++) {
    const s = Math.round(k * FRAME * 1000) / 1000 + 0; // + 0: -0 を 0 に
    const whole = Math.abs(s - Math.round(s)) < 1e-6;
    if (!whole && pxPerS * FRAME < 6) continue;
    if (whole && pxPerS < 4 && Math.round(s) % 5) continue; // とても狭いときは 5 秒ごとの線だけ
    const label = whole && Math.round(s) % labelStep(pxPerS) === 0 ? `${Math.round(s)}s` : null;
    out.push({ t: s, whole, label });
  }
  return out;
}
