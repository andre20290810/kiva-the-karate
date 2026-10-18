"""連続再生での顔・髪・衣装のちらつきを数値で探す（412 枚に広げた後の検査）。

  python flicker_qc.py --gen gen --kiva-pose kiva_pose.json --out flicker [--frames 0-411]

各コマで、KIVA の関節から決めた領域の色の割合を測り、隣のコマとの差が大きいところを挙げる:
- 頭（鼻の周り、胴の長さの 0.45 倍の円）: 銀髪（明るく彩度が低い）・肌・黒の割合
- 胴〜脚（関節の外接枠）: 黒（コート・ズボン・ブーツ）・赤（裏地）・白（シャツ）の割合
- 人物の高さ（アルファの外接枠）と KIVA の関節の高さの比
差は「その指標の全体のばらつき（中央値絶対偏差）」で割って比べ、6 倍を超えるか、割合が 0.2 以上急に変わったら挙げる。
動きの速いコマ（KIVA の関節が大きく動いたコマ）は別に印を付ける（姿勢の変化による正当な変化の可能性）。
出力: flicker.csv（全コマの指標）、flicker.md（候補一覧）、pairs.jpg（候補の前後コマ）
"""
import argparse
import csv
import json
import os

import cv2
import numpy as np


def measures(rgba, P):
    rgb, a = rgba[..., :3], rgba[..., 3] > 128
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV).astype(np.int32)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    torso = np.linalg.norm((P[11] + P[12]) / 2 - (P[23] + P[24]) / 2) + 1e-6
    yy, xx = np.mgrid[:rgb.shape[0], :rgb.shape[1]]
    head = a & ((xx - P[0, 0]) ** 2 + (yy - P[0, 1]) ** 2 < (0.45 * torso) ** 2)
    x0, y0 = P[11:33, :2].min(0)
    x1, y1 = P[11:33, :2].max(0)
    body = a & (xx >= x0) & (xx <= x1) & (yy >= y0) & (yy <= y1) & ~head
    silver = (s < 45) & (v > 140)
    skin = (h >= 5) & (h <= 25) & (s > 50) & (s < 170) & (v > 110)
    dark = v < 60
    red = ((h < 8) | (h > 170)) & (s > 110) & (v > 60)
    white = (s < 30) & (v > 200)

    def frac(m, region):
        n = region.sum()
        return float((m & region).sum() / n) if n else float('nan')
    ys = np.nonzero(a.any(axis=1))[0]
    height = (ys.max() - ys.min()) if len(ys) else 0
    kh = P[:, 1].max() - P[:, 1].min()
    return {'head_silver': frac(silver, head), 'head_skin': frac(skin, head), 'head_dark': frac(dark, head),
            'body_dark': frac(dark, body), 'body_red': frac(red, body), 'body_white': frac(white, body),
            'height_ratio': float(height / max(kh, 1)), 'area': int(a.sum())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--gen', required=True)
    ap.add_argument('--kiva-pose', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--frames', default='0-411')
    ap.add_argument('--mad-k', type=float, default=6.0)
    ap.add_argument('--jump', type=float, default=0.2)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    K = json.load(open(a.kiva_pose))
    s, e = map(int, a.frames.split('-'))
    rows, imgs = [], {}
    for i in range(s, e + 1):
        p = os.path.join(a.gen, f'alexandre_frame_{i:04d}.png')
        if not os.path.exists(p):
            continue
        rgba = cv2.cvtColor(cv2.imread(p, cv2.IMREAD_UNCHANGED), cv2.COLOR_BGRA2RGBA)
        P = np.asarray(K[i]['image'])[:, :2]
        rows.append({'frame': i, 't': K[i]['t'], **measures(rgba, P)})
    keys = ['head_silver', 'head_skin', 'head_dark', 'body_dark', 'body_red', 'body_white', 'height_ratio']
    with open(os.path.join(a.out, 'flicker.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    flags = []
    for k in keys:
        x = np.array([r[k] for r in rows], float)
        d = np.abs(np.diff(x))
        mad = np.nanmedian(np.abs(d - np.nanmedian(d))) + 1e-3
        for j in np.nonzero((d > a.mad_k * mad) | ((d > a.jump) & (not k.startswith('height'))))[0]:
            i0, i1 = rows[j]['frame'], rows[j + 1]['frame']
            P0, P1 = np.asarray(K[i0]['image'])[:, :2], np.asarray(K[i1]['image'])[:, :2]
            torso = np.linalg.norm((P0[11] + P0[12]) / 2 - (P0[23] + P0[24]) / 2) + 1e-6
            motion = float(np.linalg.norm(P1[11:29] - P0[11:29], axis=1).mean() / torso)
            flags.append({'from': i0, 'to': i1, 'measure': k, 'before': round(x[j], 3), 'after': round(x[j + 1], 3),
                          'kiva_motion': round(motion, 2), 'fast_motion': motion > 0.35})
    flags.sort(key=lambda f: (f['from'], f['measure']))
    lines = ['# ちらつき候補', '', f'検査 {len(rows)} コマ、候補 {len(flags)} 件'
             f'（うち KIVA の動きが速いコマ {sum(f["fast_motion"] for f in flags)} 件）', '',
             '| コマ | 指標 | 前 → 後 | KIVA の動き | 備考 |', '|---|---|---|---|---|']
    for f in flags:
        lines.append(f"| {f['from']}→{f['to']} | {f['measure']} | {f['before']} → {f['after']} | {f['kiva_motion']} | "
                     f"{'動きが速い' if f['fast_motion'] else ''} |")
    open(os.path.join(a.out, 'flicker.md'), 'w').write('\n'.join(lines) + '\n')
    json.dump(flags, open(os.path.join(a.out, 'flicker.json'), 'w'), indent=1)
    # 候補の前後コマを並べる（最大 24 組）
    cells = []
    for f in [f for f in flags if not f['fast_motion']][:24]:
        pair = []
        for i in (f['from'], f['to']):
            im = cv2.imread(os.path.join(a.gen, f'alexandre_frame_{i:04d}.png'), cv2.IMREAD_UNCHANGED)
            al = im[..., 3:4] / 255
            g = (im[..., :3] * al + 120 * (1 - al)).astype(np.uint8)
            cv2.putText(g, f'#{i} {f["measure"]}', (8, 30), 0, 0.8, (0, 0, 255), 2)
            pair.append(cv2.resize(g, (288, 512)))
        cells.append(np.hstack(pair))
    if cells:
        cv2.imwrite(os.path.join(a.out, 'pairs.jpg'), np.vstack(cells), [cv2.IMWRITE_JPEG_QUALITY, 85])
    print('\n'.join(lines[:3]))


if __name__ == '__main__':
    main()
