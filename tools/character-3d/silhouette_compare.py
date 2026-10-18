"""参照（白背景の回転動画のフレーム）とモデル描画（白背景・床なし）の人物の輪郭を、身長をそろえて重ねる。

  python silhouette_compare.py --pairs ref1.png:model1.png ... --out overlay.png
赤 = 参照のみ、青 = モデルのみ、白 = 重なり。高さごとの幅（身長比）の差も出す（肩・腰・膝・足首の高さ）。
"""
import argparse
import json

import numpy as np
from PIL import Image


def mask(path, thr=60):
    a = np.asarray(Image.open(path).convert('RGB')).astype(int)
    bg = np.median(np.concatenate([a[:8, :8].reshape(-1, 3), a[:8, -8:].reshape(-1, 3)]), axis=0)   # 上の隅の色 = 背景
    m = np.abs(a - bg).sum(2) > thr
    ys, xs = np.nonzero(m)
    return m, ys.min(), ys.max(), xs


def normalize(m, top, bot, H=900, W=600):
    """身長（頭頂〜足裏）を H-40 px にそろえ、脚より上の中心を横の中心に置く"""
    ys, xs = np.nonzero(m)
    cx = int(np.median(xs[ys > top + (bot - top) * 0.3]))
    s = (H - 40) / (bot - top)
    im = Image.fromarray((m * 255).astype(np.uint8)).crop((int(cx - W / 2 / s), top, int(cx + W / 2 / s), bot))
    im = im.resize((W, H - 40), Image.BILINEAR)
    out = np.zeros((H, W), bool)
    out[20:H - 20] = np.asarray(im) > 127
    return out


def widths(m, fracs=(0.18, 0.30, 0.45, 0.62, 0.80, 0.95)):
    H = m.shape[0]
    return {f: int(m[int(20 + (H - 40) * f)].sum()) for f in fracs}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pairs', nargs='+', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    tiles, rep = [], []
    for pr in a.pairs:
        r, m = pr.split(':')
        rm, rt, rb, _ = mask(r)
        mm, mt, mb, _ = mask(m)
        R = normalize(rm, rt, rb); M = normalize(mm, mt, mb)
        img = np.zeros(R.shape + (3,), np.uint8)
        img[R & ~M] = (230, 60, 60); img[M & ~R] = (60, 140, 240); img[R & M] = (235, 235, 235)
        tiles.append(img)
        iou = float((R & M).sum() / max(1, (R | M).sum()))
        wr, wm = widths(R), widths(M)
        rep.append({'ref': r.split('/')[-1], 'iou': round(iou, 3),
                    'width_ratio_model_over_ref_at_height_frac': {str(k): round(wm[k] / max(1, wr[k]), 2) for k in wr}})
    Image.fromarray(np.concatenate(tiles, 1)).save(a.out)
    json.dump(rep, open(a.out.rsplit('.', 1)[0] + '.json', 'w'), indent=1)
    for x in rep:
        print(x['ref'], 'IoU', x['iou'], x['width_ratio_model_over_ref_at_height_frac'])


if __name__ == '__main__':
    main()
