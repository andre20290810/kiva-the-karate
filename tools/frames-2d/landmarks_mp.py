"""MediaPipe Pose Landmarker（ローカル実行・無料）で 2D 観測と推定 3D（world landmarks）を取り出す。

  python landmarks_mp.py --model pose_landmarker_heavy.task --images a.png b.png ... --out lm.json
  python landmarks_mp.py --model pose_landmarker_heavy.task --video seipai.mp4 --out lm.json [--start 28.2 --end 33.6]

world landmarks は単眼画像から推定した値（腰中心・メートル）で、測定した奥行きではない。
出力には各フレームの時刻（動画）または画像名を記録する。動画・画像はどこにも送信しない。
"""
import argparse
import json
import os

import mediapipe as mp
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.core.base_options import BaseOptions
import numpy as np


def landmarker(model, video):
    opts = vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=model),
        running_mode=vision.RunningMode.VIDEO if video else vision.RunningMode.IMAGE,
        num_poses=1, min_pose_detection_confidence=0.4, min_tracking_confidence=0.4)
    return vision.PoseLandmarker.create_from_options(opts)


def pack(res, w, h):
    if not res.pose_landmarks:
        return None
    lm, wl = res.pose_landmarks[0], res.pose_world_landmarks[0]
    return {
        'image': [[p.x, p.y, p.z, getattr(p, 'visibility', 1.0) or 0.0] for p in lm],
        'world': [[p.x, p.y, p.z, getattr(p, 'visibility', 1.0) or 0.0] for p in wl],
        'size': [w, h],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--images', nargs='*')
    ap.add_argument('--video')
    ap.add_argument('--start', type=float, default=0.0)
    ap.add_argument('--end', type=float, default=1e9)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    frames = []
    if a.images:
        from PIL import Image
        with landmarker(a.model, False) as det:
            for p in a.images:
                im = np.asarray(Image.open(p).convert('RGB'))
                r = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=im))
                frames.append({'name': os.path.basename(p), **(pack(r, im.shape[1], im.shape[0]) or {'missing': True})})
    else:
        import cv2
        cap = cv2.VideoCapture(a.video)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        with landmarker(a.model, True) as det:
            i = 0
            while True:
                ok, bgr = cap.read()
                if not ok:
                    break
                t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0 or i / fps
                i += 1
                if t < a.start or t > a.end:
                    continue
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                r = det.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), int(t * 1000))
                frames.append({'time': round(t, 4), 'frame': i - 1, **(pack(r, rgb.shape[1], rgb.shape[0]) or {'missing': True})})
    out = {'format': 'kiva-mp-landmarks-v1', 'depth': 'ESTIMATED from monocular images (MediaPipe world landmarks), not measured',
           'source': a.video or 'images', 'frames': frames}
    json.dump(out, open(a.out, 'w'))
    print(len(frames), 'frames,', sum('missing' in f for f in frames), 'missing')


if __name__ == '__main__':
    main()
