"""顔の 478 点（MediaPipe Face Landmarker、ローカル・無料）を参照画像から取り、頭の向きを除いた「正準顔空間」の形にする。

  python face_landmarks.py --model face_landmarker.task --images a.png ... --pose-json tsuki_lm.json --out face_ref.json
  python face_landmarks.py --model face_landmarker.task --images render.png --out face_model.json --no-crop

人物が小さい画像は、全身ポーズの鼻の位置で顔を切り出して拡大してから検出する（拡大しても元の画素数以上の情報は無い）。
出力: 各画像の 478 点（正準空間・cm 単位）と頭の向き（yaw/pitch/roll）、切り出し元の顔幅（px）。
"""
import argparse
import json
import math
import os

import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.core.base_options import BaseOptions
from PIL import Image


def euler(R):
    yaw = math.degrees(math.atan2(-R[2, 0], math.hypot(R[0, 0], R[1, 0])))
    pitch = math.degrees(math.atan2(R[2, 1], R[2, 2]))
    roll = math.degrees(math.atan2(R[1, 0], R[0, 0]))
    return yaw, pitch, roll


def landmarker(model):
    return vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model), num_faces=1, min_face_detection_confidence=0.2,
        output_facial_transformation_matrixes=True))


def canonical(lm, M):
    """画像上の 478 点（px, z は px 換算）→ 頭の回転を除いた正準空間（頬骨幅 14 cm に正規化）"""
    R = M[:3, :3] / np.cbrt(np.linalg.det(M[:3, :3]))
    P = lm - lm.mean(axis=0)
    P[:, 1] *= -1; P[:, 2] *= -1          # 画像座標（y 下・z 奥）→ 右手系（y 上・z 手前）
    can = P @ R
    return can * 14.0 / max(1e-6, np.linalg.norm(can[234] - can[454])), R


def detect(det, rgb, crop_scale=1):
    h, w = rgb.shape[:2]
    r = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))
    if not r.face_landmarks:
        return None
    M = np.array(r.facial_transformation_matrixes[0])
    lm = np.array([[q.x * w, q.y * h, q.z * w] for q in r.face_landmarks[0]])
    can, R = canonical(lm, M)
    yaw, pitch, roll = euler(R)
    return {'yaw': yaw, 'pitch': pitch, 'roll': roll, 'face_width_px': float(np.linalg.norm(lm[234, :2] - lm[454, :2]) / crop_scale),
            'canonical_cm': can.round(4).tolist(), 'image_px': lm[:, :2].round(2).tolist(), 'crop_scale': crop_scale}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--images', nargs='+', required=True)
    ap.add_argument('--pose-json')
    ap.add_argument('--out', required=True)
    ap.add_argument('--no-crop', action='store_true')
    ap.add_argument('--scale', type=int, default=6)
    a = ap.parse_args()
    pose = {}
    if a.pose_json:
        pose = {f['name']: f for f in json.load(open(a.pose_json))['frames'] if not f.get('missing')}
    det = landmarker(a.model)
    out = []
    for p in a.images:
        im = Image.open(p).convert('RGB')
        name = os.path.basename(p)
        box = (0, 0, im.width, im.height)
        if not a.no_crop and name in pose:
            n = np.array(pose[name]['image'])[0, :2] * [im.width, im.height]
            box = (int(n[0] - 40), int(n[1] - 50), int(n[0] + 40), int(n[1] + 40))
            im = im.crop(box).resize((80 * a.scale, 90 * a.scale), Image.LANCZOS)
        res = detect(det, np.asarray(im), 1 if a.no_crop else a.scale)
        if res is None:
            out.append({'name': name, 'missing': True})
            continue
        res.update({'name': name, 'crop_box': box})
        out.append(res)
        yaw, pitch, width_px = res['yaw'], res['pitch'], res['face_width_px']
        print(name, 'yaw %.0f pitch %.0f face %.0f px' % (yaw, pitch, width_px))
    json.dump({'format': 'kiva-face-v1', 'note': 'estimated from images; canonical space normalised to 14 cm cheek width',
               'frames': out}, open(a.out, 'w'))


if __name__ == '__main__':
    main()
