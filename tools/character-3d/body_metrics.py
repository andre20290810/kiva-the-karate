"""全身の 2D 比率（MediaPipe Pose の画像上の点）。参照とモデルを同じ検出器・同じ姿勢条件で比べる。

  python body_metrics.py --model pose_landmarker_heavy.task --images ref.png model.png
身長の代わりに「鼻〜両足首の中点」の長さで割る。正面に近い直立の画像だけを使うこと（奥行き方向の傾きは補正しない）。
"""
import argparse

import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.core.base_options import BaseOptions
from PIL import Image


def metrics(P):
    m = lambda a, b: (P[a] + P[b]) / 2
    d = lambda a, b: float(np.linalg.norm(a - b))
    H = d(P[0], m(27, 28))
    return {
        'shoulder_w': d(P[11], P[12]) / H, 'hip_w': d(P[23], P[24]) / H,
        'torso': d(m(11, 12), m(23, 24)) / H,
        'thigh': (d(P[23], P[25]) + d(P[24], P[26])) / 2 / H, 'shin': (d(P[25], P[27]) + d(P[26], P[28])) / 2 / H,
        'head(nose-shoulder)': d(P[0], m(11, 12)) / H,
    }


def detect(model, path):
    det = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=model)))
    im = np.asarray(Image.open(path).convert('RGB'))
    r = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=im))
    if not r.pose_landmarks:
        return None
    return np.array([[q.x * im.shape[1], q.y * im.shape[0]] for q in r.pose_landmarks[0]])


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--images', nargs='+')
    a = ap.parse_args()
    rows = [(p.split('/')[-1], metrics(detect(a.model, p))) for p in a.images]
    print('%-22s' % '' + ''.join('%18s' % r[0][:17] for r in rows))
    for k in rows[0][1]:
        print('%-22s' % k + ''.join('%18.3f' % r[1][k] for r in rows))
