"""KIVA のセーパイ元動画から、412 コマ（または frames.json の各時刻）の姿勢と元画像を取り出す。

  python kiva_pose.py --video source/seipai.mp4 --lm seipai_lm.json --out-json kiva_pose.json --out-dir kiva \
      [--frames-json assets/seipai/frames.json]

- 姿勢は landmarks_mp.py（MediaPipe）で動画全体から測った seipai_lm.json の、各時刻に最も近いコマ。想像の姿勢は使わない
- 時刻: --frames-json があれば各コマの t、無ければ i × 0.2 秒（5fps、412 コマ）
- 出力: kiva_pose.json（i, t, src_frame, yaw, image = 画素座標＋可視度, world = 推定 3D）、kiva/kiva_XXXX.png（元動画のコマ）
yaw: 0° = カメラ正面、+ = 人物が画面右へ向く（推定 3D の胴の向き。単眼推定なので横向き付近は不安定）。
"""
import argparse
import json
import os

import cv2
import numpy as np


def yaw(w):
    across = (w[11] + w[23]) / 2 - (w[12] + w[24]) / 2
    up = (w[11] + w[12]) / 2 - (w[23] + w[24]) / 2
    f = np.cross(across, up)
    return float(np.degrees(np.arctan2(f[0], -f[2])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--video', required=True)
    ap.add_argument('--lm', required=True)
    ap.add_argument('--out-json', required=True)
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--frames-json')
    ap.add_argument('--count', type=int, default=412)
    ap.add_argument('--fps', type=float, default=5.0)
    a = ap.parse_args()
    F = [f for f in json.load(open(a.lm))['frames'] if not f.get('missing')]
    ft = np.array([f['time'] for f in F])
    times = [f['t'] for f in json.load(open(a.frames_json))['frames']] if a.frames_json else \
        [round(i / a.fps, 3) for i in range(a.count)]
    cap = cv2.VideoCapture(a.video)
    os.makedirs(a.out_dir, exist_ok=True)
    out = []
    for i, t in enumerate(times):
        f = F[int(np.argmin(np.abs(ft - t)))]
        W, H = f['size']
        w = np.array(f['world'])[:, :3]
        im = np.array(f['image'])
        out.append({'i': i, 't': t, 'src_frame': f['frame'], 'src_time': f['time'], 'yaw': yaw(w),
                    'image': np.c_[im[:, 0] * W, im[:, 1] * H, im[:, 3]].tolist(), 'world': w.tolist()})
        cap.set(cv2.CAP_PROP_POS_FRAMES, f['frame'])
        ok, bgr = cap.read()
        if ok:
            cv2.imwrite(os.path.join(a.out_dir, f'kiva_{i:04d}.png'), bgr)
    json.dump(out, open(a.out_json, 'w'))
    gap = max(abs(o['src_time'] - o['t']) for o in out)
    print(len(out), 'frames; largest gap between requested time and measured frame', round(gap, 3), 's')


if __name__ == '__main__':
    main()
