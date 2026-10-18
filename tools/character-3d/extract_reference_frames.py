"""参照動画から、人物造形に使う高画質フレームを選んで書き出す（ローカル・無料。元動画は変更しない）。

  python extract_reference_frames.py --video ALEXANDRE.mp4 --video-id 1JR5EW3XFTlqHX3zMczBdbZfhJegCTg_i
         --pose-model pose_landmarker_heavy.task --face-model face_landmarker.task --out source/alexandre-reference [--step 0.25]

0.25 秒ごとに、ぶれ（ラプラシアン分散）・人物の大きさ・顔の向き（yaw）を測り、次の区分ごとに最良のフレームを残す:
  face_front（|yaw|<12°）、face_oblique（20〜40°）、face_side（>55°）、body_front / body_side / body_back（全身が写っている）
各画像のファイル名とメタデータ（frames.csv）に動画 ID と抽出時刻を記録する。参照素材なので公開リポジトリには入れないこと。
"""
import argparse
import csv
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import face_landmarks as fl  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--video', required=True)
    ap.add_argument('--video-id', required=True)
    ap.add_argument('--pose-model', required=True)
    ap.add_argument('--face-model', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--step', type=float, default=0.25)
    ap.add_argument('--per-class', type=int, default=4)
    a = ap.parse_args()
    import mediapipe as mp
    from mediapipe.tasks.python import vision
    from mediapipe.tasks.python.core.base_options import BaseOptions
    pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=a.pose_model)))
    face = fl.landmarker(a.face_model)
    os.makedirs(a.out, exist_ok=True)
    cap = cv2.VideoCapture(a.video)
    dur = cap.get(cv2.CAP_PROP_FRAME_COUNT) / (cap.get(cv2.CAP_PROP_FPS) or 30)
    cands = []
    t = 0.0
    while t < dur:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, bgr = cap.read()
        if not ok:
            break
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        h, w = rgb.shape[:2]
        sharp = float(cv2.Laplacian(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())
        r = pose.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
        rec = {'t': round(t, 3), 'sharp': sharp}
        if r.pose_landmarks:
            P = np.array([[q.x * w, q.y * h, q.visibility] for q in r.pose_landmarks[0]])
            rec['body_h'] = float(P[:, 1].max() - P[:, 1].min()) / h
            rec['full_body'] = bool(P[[27, 28], 2].min() > 0.6 and P[0, 2] > 0.5 and P[[27, 28], 1].max() < h * 0.98)
            across = P[11, 0] - P[12, 0]
            rec['facing'] = 'front' if across > 0.12 * rec['body_h'] * h else 'back' if across < -0.12 * rec['body_h'] * h else 'side'
            n = P[0, :2]
            s = max(40, int(rec['body_h'] * h * 0.16))
            crop = rgb[max(0, int(n[1] - s)):int(n[1] + s), max(0, int(n[0] - s)):int(n[0] + s)]
            if crop.size:
                up = cv2.resize(crop, (max(1, crop.shape[1] * 4), max(1, crop.shape[0] * 4)), interpolation=cv2.INTER_LANCZOS4)
                fr = fl.detect(face, up, 4)
                if fr:
                    rec['yaw'] = fr['yaw']; rec['face_px'] = fr['face_width_px']
        cands.append(rec)
        t += a.step
    classes = {
        'face_front': lambda r: 'yaw' in r and abs(r['yaw']) < 12,
        'face_oblique': lambda r: 'yaw' in r and 20 <= abs(r['yaw']) <= 40,
        'face_side': lambda r: 'yaw' in r and abs(r['yaw']) > 55,
        'body_front': lambda r: r.get('full_body') and r.get('facing') == 'front',
        'body_side': lambda r: r.get('full_body') and r.get('facing') == 'side',
        'body_back': lambda r: r.get('full_body') and r.get('facing') == 'back',
    }
    rows = []
    for cls, ok in classes.items():
        key = (lambda r: r.get('face_px', 0) * np.sqrt(r['sharp'])) if cls.startswith('face') else (lambda r: r.get('body_h', 0) * np.sqrt(r['sharp']))
        best = sorted([r for r in cands if ok(r)], key=key, reverse=True)
        chosen = []
        for r in best:
            if all(abs(r['t'] - c['t']) > 1.0 for c in chosen):
                chosen.append(r)
            if len(chosen) >= a.per_class:
                break
        for r in chosen:
            cap.set(cv2.CAP_PROP_POS_MSEC, r['t'] * 1000)
            ok_, bgr = cap.read()
            name = f"{cls}_{a.video_id[:8]}_{int(round(r['t'] * 1000)):07d}ms.png"
            cv2.imwrite(os.path.join(a.out, name), bgr)
            rows.append({'file': name, 'class': cls, 'video_id': a.video_id, 'time_s': r['t'], 'sharpness': round(r['sharp'], 1),
                         'face_px': round(r.get('face_px', 0), 1), 'yaw': round(r.get('yaw', 0), 1), 'body_h': round(r.get('body_h', 0), 3)})
    with open(os.path.join(a.out, 'frames.csv'), 'w', newline='', encoding='utf-8') as f:
        wr = csv.DictWriter(f, fieldnames=list(rows[0]) if rows else ['file'])
        wr.writeheader(); wr.writerows(rows)
    json.dump({'video': os.path.basename(a.video), 'video_id': a.video_id, 'duration_s': dur, 'sampled_every_s': a.step,
               'candidates': len(cands)}, open(os.path.join(a.out, 'source_metadata.json'), 'w'), indent=1)
    print(len(rows), 'frames written to', a.out)


if __name__ == '__main__':
    main()
