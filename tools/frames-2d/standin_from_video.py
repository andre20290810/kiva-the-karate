"""【ローカル試験専用の代用素材】セーパイ元動画から、提供 ZIP（seipai_transparent_412frames.zip）と同じ形の
背景透過 PNG 412 枚と timestamps.csv を作る。

  python standin_from_video.py --video source/seipai.mp4 --model pose_landmarker_heavy.task --out source/seipai_transparent_STANDIN

本物の ZIP が手に入ったら、そちらを prepare_frames.py に渡す（この代用素材は配布しない）。
切り抜きは MediaPipe Pose の人物マスク（推定）なので、輪郭は本物の切り出しより粗い。
"""
import argparse
import csv
import os

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.core.base_options import BaseOptions


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--video', required=True)
    ap.add_argument('--model', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--count', type=int, default=412)
    ap.add_argument('--interval', type=float, default=0.2)
    a = ap.parse_args()
    d = os.path.join(a.out, 'seipai_transparent')
    os.makedirs(d, exist_ok=True)
    opts = vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=a.model),
                                        running_mode=vision.RunningMode.VIDEO, num_poses=1,
                                        output_segmentation_masks=True)
    cap = cv2.VideoCapture(a.video)
    fps = cap.get(cv2.CAP_PROP_FPS)
    rows = []
    with vision.PoseLandmarker.create_from_options(opts) as det:
        for i in range(a.count):
            t = round(i * a.interval, 3)
            fi = int(round(t * fps))
            cap.set(cv2.CAP_PROP_POS_FRAMES, fi)
            ok, bgr = cap.read()
            if not ok:
                raise SystemExit(f'frame {fi} unreadable')
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            r = det.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), int(t * 1000))
            if r.segmentation_masks:
                m = r.segmentation_masks[0].numpy_view().astype(np.float32)
                m = np.clip((m - 0.35) / 0.3, 0, 1)
            else:
                m = np.zeros(bgr.shape[:2], np.float32)
            a8 = (cv2.GaussianBlur(m, (3, 3), 0) * 255).astype(np.uint8)
            name = f'frame_{i:04d}.png'
            cv2.imwrite(os.path.join(d, name), np.dstack([bgr, a8]))
            rows.append((name, i, f'{t:.3f}', fi))
            if i % 50 == 0:
                print(i, flush=True)
    with open(os.path.join(d, 'timestamps.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['file', 'index', 'time_seconds', 'source_frame'])
        w.writerows(rows)
    open(os.path.join(d, 'README.txt'), 'w').write(
        'LOCAL TEST STAND-IN: cut from source/seipai.mp4 with MediaPipe Pose segmentation masks.\n'
        'Not the provided seipai_transparent_412frames.zip. Do not distribute.\n')
    print('done', len(rows))


if __name__ == '__main__':
    main()
