"""生成した ALEXANDRE の 412 枚をゲームのフレーム定義にまとめる。

  python package_frames.py --gen dir --kiva-pose kiva_pose.json --out assets/alexandre [--kiva-frames-json assets/seipai/frames.json]

- 画像: <out>/png/alexandre_frame_0000.png … 0411.png（透過 PNG の原本。番号は KIVA のコマ番号と同じ）
        <out>/frames/alexandre_frame_0000.webp …（ゲームが読む透過 WebP。PNG の約 1/6 の容量）
- frames.json: fps・枚数・各コマの時刻は KIVA と同じ。--kiva-frames-json があればその時刻（t）をそのまま写す
  （ゲームは基準と時刻が 0.001 秒以上違うフレーム列を使わない）
- reference_angles.md / .csv: 各コマに使った ALEXANDRE 参照コマ（回転動画の時刻・向き）
"""
import argparse
import csv
import glob
import json
import os
import shutil

import cv2
import numpy as np

JOINTS = {'nose': 0, 'left_shoulder': 11, 'right_shoulder': 12, 'left_elbow': 13, 'right_elbow': 14, 'left_wrist': 15,
          'right_wrist': 16, 'left_hip': 23, 'right_hip': 24, 'left_knee': 25, 'right_knee': 26, 'left_ankle': 27,
          'right_ankle': 28, 'left_heel': 29, 'right_heel': 30, 'left_foot': 31, 'right_foot': 32}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--gen', required=True)
    ap.add_argument('--kiva-pose', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--kiva-frames-json')
    a = ap.parse_args()
    K = json.load(open(a.kiva_pose))
    base = json.load(open(a.kiva_frames_json)) if a.kiva_frames_json else None
    n = len(base['frames']) if base else len(K)
    os.makedirs(os.path.join(a.out, 'frames'), exist_ok=True)
    os.makedirs(os.path.join(a.out, 'png'), exist_ok=True)
    choice = {}
    for p in glob.glob(os.path.join(a.gen, 'ref_choice_*.json')):
        for r in json.load(open(p)):
            choice[r['frame']] = r
    frames, missing = [], []
    for i in range(n):
        name = f'alexandre_frame_{i:04d}.png'
        src = os.path.join(a.gen, name)
        if not os.path.exists(src):
            missing.append(i)
            continue
        shutil.copyfile(src, os.path.join(a.out, 'png', name))
        img = cv2.imread(src, cv2.IMREAD_UNCHANGED)
        webp = name[:-4] + '.webp'
        cv2.imwrite(os.path.join(a.out, 'frames', webp), img, [cv2.IMWRITE_WEBP_QUALITY, 85])
        alpha = img[..., 3]
        ys, xs = np.nonzero(alpha > 20)
        bbox = [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)] if len(xs) else [0, 0, 1, 1]
        P = np.asarray(K[i]['image'])
        t = base['frames'][i]['t'] if base else round(i * 0.2, 3)
        frames.append({'i': i, 't': t, 'file': 'frames/' + webp, 'png': 'png/' + name, 'bbox': bbox,
                       'joints': {k: [round(float(P[j, 0]), 1), round(float(P[j, 1]), 1), round(float(P[j, 2]), 3)] for k, j in JOINTS.items()}})
    if missing:
        raise SystemExit(f'missing {len(missing)} frames: {missing[:10]}')
    json.dump({'fps': base['fps'] if base else 5, 'width': 576, 'height': 1024,
               'source': 'ALEXANDRE 2D re-pose of turntable images onto KIVA Seipai poses (tools/character-2d, PREVIEW)',
               'frames': frames}, open(os.path.join(a.out, 'frames.json'), 'w'), indent=1)
    # 参照の向きのメモ: 30° ごとにまとめる
    rows = [choice[i] for i in range(n) if i in choice]
    with open(os.path.join(a.out, 'reference_angles.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['frame', 't', 'kiva_yaw_deg', 'alexandre_ref_frame', 'alexandre_ref_time_s', 'alexandre_ref_yaw_deg', 'left_arm_front', 'right_arm_front'])
        for r in rows:
            w.writerow([r['frame'], r['t'], r['kiva_yaw'], r['ref_frame'], r['ref_time_s'], r['ref_yaw'], r['arm_front']['L'], r['arm_front']['R']])
    lines = ['# ALEXANDRE 参照画像の使い分け（向き 30° ごと）', '',
             '向き: 0° = カメラ正面、+ = 人物が画面右へ向く、±180° = 背面。参照は alexandre.mp4（回転動画、ID 1JR5EW3X…）の各コマ。', '',
             '| KIVA の向き | コマ数 | 使った参照コマ（回転動画の時刻） | 例（KIVA のコマ番号） |', '|---|---|---|---|']
    for lo in range(-180, 180, 30):
        sel = [r for r in rows if lo <= r['kiva_yaw'] < lo + 30]
        if not sel:
            continue
        refs = sorted({(r['ref_frame'], r['ref_time_s']) for r in sel})
        span = f"{refs[0][1]:.2f}〜{refs[-1][1]:.2f} s（{len(refs)} 種）"
        lines.append(f"| {lo}〜{lo + 30}° | {len(sel)} | {span} | {', '.join(str(r['frame']) for r in sel[:6])} |")
    open(os.path.join(a.out, 'reference_angles.md'), 'w').write('\n'.join(lines) + '\n')
    print('packaged', len(frames), 'frames ->', a.out)


if __name__ == '__main__':
    main()
