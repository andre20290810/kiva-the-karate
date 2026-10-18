"""提供された背景透過 PNG の切り抜き不具合（人物の欠け・床や反射の残り）を、元動画から背景除去をやり直して直す。

  python tools/frames-2d/repair_frames.py --src <seipai_transparent> --video <元動画> --model pose_landmarker_heavy.task \
      --out <修正版フォルダ> [--frames 116,117,126,340]     （--frames を省くと全コマを検査して自動で選ぶ）

- 対応の確認: 各コマについて、PNG の不透明な画素と、timestamps.csv の source_frame_index の動画フレームの画素を比べる
  （平均の差が小さければ同じ素材）。合わなければ止める（別の動画で直さない）
- 検査: 元動画のフレームから MediaPipe の人物マスクを作り、PNG のアルファと比べる
    欠け  … 人物マスクにあるのに PNG で透明な領域（人物マスクの 8% 以上）
    残り  … PNG で不透明なのに人物マスクの外の領域（足元より上、人物マスクの 6% 以上）
- 修正: 人物マスクが確実に人物とする所は不透明に、確実に人物でないとする所は透明に、それ以外は PNG のアルファのまま。
  色は元の画素（PNG の画素、PNG で透明だった所は元動画の画素）を使う。人物の生成・補完はしない
- 出力: --out に全コマ（直したコマだけ置き換え、他は元のまま複製）と timestamps.csv・README.txt、repair_log.json（理由と数値）、
  repair_sheet.jpg（直す前・人物マスク・直した後）。元の素材フォルダは変更しない
"""
import argparse
import csv
import json
import os
import shutil

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.core.base_options import BaseOptions


def rows(src):
    with open(os.path.join(src, 'timestamps.csv'), newline='', encoding='utf-8-sig') as f:
        r = list(csv.reader(f))
    head = [h.strip().lower() for h in r[0]]
    fc = next(i for i, h in enumerate(head) if 'file' in h or 'name' in h)
    sc = next(i for i, h in enumerate(head) if 'source' in h)
    return [(x[fc].strip(), int(x[sc])) for x in r[1:] if x]


def person_prob(det, bgr):
    """人物らしさ（0〜1）と足元の高さ（かかと・つま先の一番下、画素）。床の反射は足元より下なので、そこは人物に数えない。"""
    res = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))))
    if not res.segmentation_masks:
        return np.zeros(bgr.shape[:2], np.float32), None
    lm = res.pose_landmarks[0] if res.pose_landmarks else None
    foot = None
    if lm:
        ys = [lm[j].y * bgr.shape[0] for j in (27, 28, 29, 30, 31, 32) if (lm[j].visibility or 0) > 0.3]
        foot = int(max(ys)) + 6 if ys else None
    m = res.segmentation_masks[0].numpy_view().astype(np.float32)
    m = m[..., 0] if m.ndim == 3 else m
    if foot is not None:
        m = m.copy()
        m[min(foot, m.shape[0]):, :] = 0
    return m, foot


def own_foot(png):
    """提供 PNG の人物の一番下（足の裏）。床の反射はこれより下にしかないので、追加はこれより上に限る。"""
    ys = np.nonzero((png[..., 3] > 128).any(axis=1))[0]
    return int(ys.max()) - 3 if len(ys) else png.shape[0]


def analyse(png, frame, prob):
    a = png[..., 3].astype(np.float32) / 255
    opaque = a > 0.5
    pm = prob > 0.6
    pm[own_foot(png):, :] = False
    diff = float(np.abs(png[..., :3].astype(np.int16) - frame.astype(np.int16))[a > 0.98].mean()) if (a > 0.98).any() else 999
    area = max(1, int(pm.sum()))
    missing = pm & ~opaque
    ys = np.nonzero(pm.any(axis=1))[0]
    foot = ys.max() if len(ys) else png.shape[0]
    extra = opaque & (prob < 0.08)
    extra[foot - 6:, :] = False  # 足の裏の際は判定しない
    # 小さな点は数えない（輪郭の誤差）
    def big(m, min_px=150):
        n, lab, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8))
        keep = np.zeros_like(m)
        for k in range(1, n):
            if st[k, cv2.CC_STAT_AREA] >= min_px:
                keep |= lab == k
        return keep
    missing, extra = big(missing), big(extra)
    return {'pixel_diff': round(diff, 2), 'missing_ratio': round(float(missing.sum()) / area, 4),
            'extra_ratio': round(float(extra.sum()) / area, 4)}, missing, extra


def repair(png, frame, prob):
    a = png[..., 3].astype(np.float32) / 255
    sure_in = cv2.erode((prob > 0.75).astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    sure_in[own_foot(png):, :] = False  # 足の裏より下（床の反射）は足さない
    sure_out = cv2.erode((prob < 0.05).astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool)
    new = a.copy()
    new[sure_in] = 1.0
    new[sure_out] = 0.0
    # 境界をなめらかに（元のアルファが半透明だった縁はそのまま）
    soft = cv2.GaussianBlur(new, (5, 5), 0)
    edge = (new > 0.02) & (new < 0.98) | (cv2.dilate((new > 0.5).astype(np.uint8), np.ones((3, 3))) != cv2.erode((new > 0.5).astype(np.uint8), np.ones((3, 3))))
    new = np.where(edge, soft, new)
    rgb = np.where((a > 0.02)[..., None], png[..., :3], frame)  # 色は元の画素（PNG で透明だった所は元動画の画素）
    return np.dstack([rgb, np.clip(new * 255, 0, 255).astype(np.uint8)])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--video', required=True)
    ap.add_argument('--model', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--frames', help='直すコマ番号（カンマ区切り）。省略時は全コマを検査して自動選択')
    ap.add_argument('--max-diff', type=float, default=6.0, help='素材と動画の画素の平均差の上限（超えたら別の動画とみなして止める）')
    a = ap.parse_args()
    R = rows(a.src)
    cap = cv2.VideoCapture(a.video)
    det = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=a.model), running_mode=vision.RunningMode.IMAGE, num_poses=1,
        output_segmentation_masks=True))
    want = {int(x) for x in a.frames.split(',')} if a.frames else None
    log, fixed, sheet = [], [], []
    os.makedirs(a.out, exist_ok=True)
    for i, (name, sf) in enumerate(R):
        png = cv2.imread(os.path.join(a.src, name), cv2.IMREAD_UNCHANGED)
        cap.set(cv2.CAP_PROP_POS_FRAMES, sf)
        ok, frame = cap.read()
        if not ok:
            raise SystemExit(f'{name}: 動画の {sf} フレーム目を読めません（素材と動画が合っていない可能性）')
        prob, foot = person_prob(det, frame)
        m, missing, extra = analyse(png, frame, prob)
        # 人物マスクが取れない・小さすぎるコマは直さない（手作業の確認へ）
        reliable = foot is not None and (prob > 0.6).sum() > 0.5 * (png[..., 3] > 128).sum()
        m['mask_reliable'] = bool(reliable)
        m.update(frame=i, file=name, source_frame=sf)
        if m['pixel_diff'] > a.max_diff:
            raise SystemExit(f'{name}: 素材と動画の画素が合いません（平均差 {m["pixel_diff"]}）。別の動画では直しません')
        need = reliable and ((i in want) if want is not None else (m['missing_ratio'] >= 0.08 or m['extra_ratio'] >= 0.06))
        out_path = os.path.join(a.out, name)
        if need:
            rep = repair(png, frame, prob)
            m2, _, _ = analyse(rep, frame, prob)
            m.update(repaired=True, after=m2)
            cv2.imwrite(out_path, rep)
            fixed.append(i)
            def show(img):
                al = img[..., 3:4] / 255
                return (img[..., :3] * al + np.array([160, 60, 170]) * (1 - al)).astype(np.uint8)
            pm = cv2.cvtColor((prob * 255).astype(np.uint8), cv2.COLOR_GRAY2BGR)
            row = np.hstack([show(png), pm, show(rep)])
            cv2.putText(row, f'{name}  before | person mask | after   missing {m["missing_ratio"]:.2f}->{m2["missing_ratio"]:.2f}  extra {m["extra_ratio"]:.2f}->{m2["extra_ratio"]:.2f}',
                        (10, 40), 0, 0.9, (0, 255, 255), 2)
            sheet.append(cv2.resize(row, None, fx=0.45, fy=0.45))
        else:
            shutil.copyfile(os.path.join(a.src, name), out_path)
        log.append(m)
        if i % 50 == 0:
            print(i, name, m, flush=True)
    for extra_file in ('timestamps.csv', 'README.txt'):
        if os.path.exists(os.path.join(a.src, extra_file)):
            shutil.copyfile(os.path.join(a.src, extra_file), os.path.join(a.out, extra_file))
    det.close()
    diffs = [x['pixel_diff'] for x in log]
    summary = {'video': os.path.basename(a.video), 'frames': len(log), 'pixel_diff_max': max(diffs),
               'pixel_diff_median': float(np.median(diffs)), 'repaired': fixed,
               'flagged_not_repaired': [x['frame'] for x in log if not x.get('repaired') and (x['missing_ratio'] >= 0.08 or x['extra_ratio'] >= 0.06)],
               'mask_unreliable': [x['frame'] for x in log if not x['mask_reliable']]}
    json.dump({'summary': summary, 'frames': log}, open(os.path.join(a.out, 'repair_log.json'), 'w'), ensure_ascii=False, indent=1)
    if sheet:
        cv2.imwrite(os.path.join(a.out, 'repair_sheet.jpg'), np.vstack(sheet), [cv2.IMWRITE_JPEG_QUALITY, 85])
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
