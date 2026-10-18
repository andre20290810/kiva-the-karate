"""姿勢を条件にした画像生成の入力を作る（生成そのものはしない）。

  python make_controls.py --kiva-pose kiva_pose.json --kiva-dir kiva --out controls [--pick 10 | --frames 0,40,...]

- controls/pose_XXXX.png   … OpenPose 形式の骨格画像（黒地、576×1024、KIVA の 2D 関節そのまま）
- controls/kiva_XXXX.png   … 同じコマの元動画画像（比較用）
- controls/picked.json     … 選んだコマ（--pick は姿勢と向きが互いに最も離れたコマを選ぶ）
"""
import argparse
import json
import os

import cv2
import numpy as np

# MediaPipe 33 点 → OpenPose 18 点（首は両肩の中点）
MP2OP = [0, None, 12, 14, 16, 11, 13, 15, 24, 26, 28, 23, 25, 27, 5, 2, 8, 7]
EDGES = [(1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9), (9, 10), (1, 11), (11, 12), (12, 13),
         (1, 0), (0, 14), (14, 16), (0, 15), (15, 17)]
COLORS = [(255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0), (85, 255, 0), (0, 255, 0),
          (0, 255, 85), (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255),
          (170, 0, 255), (255, 0, 255), (255, 0, 170), (255, 0, 85)]


def openpose_points(P):
    P = np.asarray(P)
    out = []
    for j in MP2OP:
        out.append((P[11, :2] + P[12, :2]) / 2 if j is None else P[j, :2])
    return np.array(out)


def draw(P, w=576, h=1024):
    img = np.zeros((h, w, 3), np.uint8)
    pts = openpose_points(P)
    for k, (a, b) in enumerate(EDGES):
        pa, pb = pts[a], pts[b]
        c = ((pa + pb) / 2).astype(int)
        L = float(np.linalg.norm(pa - pb))
        ang = float(np.degrees(np.arctan2(pa[1] - pb[1], pa[0] - pb[0])))
        poly = cv2.ellipse2Poly(tuple(int(v) for v in c), (int(L / 2), 4), int(ang), 0, 360, 1)
        cv2.fillConvexPoly(img, poly, tuple(int(v * 0.6) for v in COLORS[k][::-1]))
    for k, p in enumerate(pts):
        cv2.circle(img, tuple(int(v) for v in p), 4, COLORS[k][::-1], -1)
    return img


def pick(K, n):
    feats = []
    for k in K:
        P = np.asarray(k['image'])[:, :2]
        c = (P[23] + P[24]) / 2
        s = np.linalg.norm((P[11] + P[12]) / 2 - c) + 1e-6
        f = ((P[[0, 13, 14, 15, 16, 25, 26, 27, 28]] - c) / s).ravel()
        y = np.radians(k['yaw'])
        feats.append(np.concatenate([f, 3 * np.array([np.cos(y), np.sin(y)])]))
    F = np.array(feats)
    sel = [0]
    d = np.linalg.norm(F - F[0], axis=1)
    while len(sel) < n:
        i = int(d.argmax())
        sel.append(i)
        d = np.minimum(d, np.linalg.norm(F - F[i], axis=1))
    return sorted(sel)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--kiva-pose', required=True)
    ap.add_argument('--kiva-dir', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--pick', type=int, default=10)
    ap.add_argument('--frames')
    a = ap.parse_args()
    K = json.load(open(a.kiva_pose))
    frames = [int(x) for x in a.frames.split(',')] if a.frames else pick(K, a.pick)
    os.makedirs(a.out, exist_ok=True)
    for i in frames:
        cv2.imwrite(os.path.join(a.out, f'pose_{i:04d}.png'), draw(K[i]['image']))
        src = cv2.imread(os.path.join(a.kiva_dir, f'kiva_{i:04d}.png'))
        cv2.imwrite(os.path.join(a.out, f'kiva_{i:04d}.png'), src)
    json.dump([{'frame': i, 't': K[i]['t'], 'yaw': round(K[i]['yaw'], 1)} for i in frames],
              open(os.path.join(a.out, 'picked.json'), 'w'), indent=1)
    print('frames', frames)


if __name__ == '__main__':
    main()
