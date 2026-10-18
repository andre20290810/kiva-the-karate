"""背景透過 PNG 412 枚（seipai_transparent/）から、ゲーム用の派生画像と配置情報（manifest.json）を作る。

  python tools/frames-2d/prepare_frames.py --src <展開した seipai_transparent フォルダ> --out assets/seipai \
      [--model pose_landmarker_heavy.task] [--stand-in]

入力: frame_0000.png 〜 frame_0411.png（576×1024 RGBA）と timestamps.csv（時刻はこれを優先）
出力:
  assets/seipai/cut/frame_XXXX.webp … 人物の周りだけを切り出した透過 WebP（元の座標は manifest の crop で戻せる）
  assets/seipai/manifest.json        … 各コマの時刻・切り出し位置・人物アンカー・体格補正（形式は README）

人物アンカーと倍率（README「人物の中央配置」）:
- 人物領域: アルファの最大の塊と、その近くの大きめの塊（離れた手足）。離れた小さな塊（ゴミ・残った文字・床の反射）は
  基準から外し、派生画像からも消す（消した数は manifest の debris に記録）
- アンカー: 胴体の中心（両肩と両腰の中点の平均）。--model があれば MediaPipe で関節を測る。無ければアルファから推定
- 倍率: 胴の長さ（肩の中点〜腰の中点）を前後のコマで強く平滑化した値で割る（撮影距離による体格の変化だけを補正し、
  しゃがみ・蹴りで外接矩形が変わっても拡縮しない）。k = 1 /（直立時の全高）で、元画像の画素 × k = 直立身長の何倍か
"""
import argparse
import csv
import json
import os

import cv2
import numpy as np

JOINTS = {'nose': 0, 'left_shoulder': 11, 'right_shoulder': 12, 'left_elbow': 13, 'right_elbow': 14,
          'left_wrist': 15, 'right_wrist': 16, 'left_hip': 23, 'right_hip': 24, 'left_knee': 25, 'right_knee': 26,
          'left_ankle': 27, 'right_ankle': 28, 'left_foot': 31, 'right_foot': 32}


def subject_mask(alpha):
    """人物の塊だけを残すマスクと、外した塊の数。"""
    m = (alpha > 32).astype(np.uint8)
    n, lab, st, cen = cv2.connectedComponentsWithStats(m, 8)
    if n <= 1:
        return np.zeros_like(m, bool), 0
    main = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    x, y, w, h, area = st[main]
    keep = [main]
    removed = 0
    for k in range(1, n):
        if k == main:
            continue
        kx, ky, kw, kh, ka = st[k]
        # 主の外接枠からの距離（主の高さに対する割合）
        dx = max(x - (kx + kw), kx - (x + w), 0)
        dy = max(y - (ky + kh), ky - (y + h), 0)
        near = max(dx, dy) < 0.06 * h
        inside_below = ky > y + 0.97 * h          # 足元より下（床の反射）
        if ka >= 0.004 * area and near and not inside_below:
            keep.append(k)
        else:
            removed += 1
    mask = np.isin(lab, keep)
    # 主に重なる半透明の縁（アルファ 1〜32）は残す
    mask = cv2.dilate(mask.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool) & (alpha > 0)
    return mask, removed


def detect_joints(det, rgba):
    import mediapipe as mp
    a = rgba[..., 3:4].astype(np.float32) / 255
    rgb = (rgba[..., :3].astype(np.float32) * a + 128 * (1 - a)).astype(np.uint8)
    r = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))
    if not r.pose_landmarks:
        return None
    h, w = rgb.shape[:2]
    lm = r.pose_landmarks[0]
    return {k: [round(lm[j].x * w, 1), round(lm[j].y * h, 1), round(float(lm[j].visibility or 0), 3)] for k, j in JOINTS.items()}


def torso(joints, mask):
    """胴体の中心と胴の長さ（画素）。関節が無い・信頼度が低いときはアルファから推定。"""
    if joints:
        pts = [joints[k] for k in ('left_shoulder', 'right_shoulder', 'left_hip', 'right_hip')]
        if min(p[2] for p in pts) > 0.4:
            sh = (np.array(pts[0][:2]) + np.array(pts[1][:2])) / 2
            hp = (np.array(pts[2][:2]) + np.array(pts[3][:2])) / 2
            return (sh + hp) / 2, float(np.linalg.norm(sh - hp)), 'joints'
    ys, xs = np.nonzero(mask)
    y0, y1 = ys.min(), ys.max()
    band = (ys > y0 + 0.2 * (y1 - y0)) & (ys < y0 + 0.5 * (y1 - y0))
    c = np.array([np.median(xs[band]), y0 + 0.37 * (y1 - y0)])
    return c, 0.3 * (y1 - y0), 'alpha'


def smooth(x, med=11, sigma=4.0):
    x = np.asarray(x, float)
    n = len(x)
    pad = med // 2
    xp = np.pad(x, pad, mode='edge')
    m = np.array([np.median(xp[i:i + med]) for i in range(n)])
    r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    return np.convolve(np.pad(m, r, mode='edge'), k, mode='valid')


def read_timestamps(src):
    p = os.path.join(src, 'timestamps.csv')
    if not os.path.exists(p):
        return None
    out = {}
    with open(p, newline='', encoding='utf-8-sig') as f:
        rows = list(csv.reader(f))
    head = [h.strip().lower() for h in rows[0]]
    fcol = next((i for i, h in enumerate(head) if 'file' in h or 'name' in h), None)
    tcol = next((i for i, h in enumerate(head) if 'time' in h or h in ('t', 'sec', 'seconds')), None)
    icol = next((i for i, h in enumerate(head) if h in ('index', 'frame', 'i')), None)
    if tcol is None:
        raise SystemExit(f'timestamps.csv に時刻の列が見つかりません: {rows[0]}')
    for r in rows[1:]:
        if not r:
            continue
        if fcol is not None:
            key = os.path.basename(r[fcol].strip())
        else:
            key = f'frame_{int(r[icol]):04d}.png'
        out[key] = float(r[tcol])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--model', help='MediaPipe pose_landmarker の .task（関節を測る。無ければアルファから推定）')
    ap.add_argument('--interval', type=float, default=0.2)
    ap.add_argument('--duration', type=float, default=82.266667)
    ap.add_argument('--quality', type=int, default=88)
    ap.add_argument('--stand-in', action='store_true', help='ローカル試験用の代用素材として印を付ける')
    a = ap.parse_args()
    files = sorted(f for f in os.listdir(a.src) if f.startswith('frame_') and f.endswith('.png'))
    if not files:
        raise SystemExit(f'{a.src} に frame_XXXX.png がありません')
    ts = read_timestamps(a.src)
    det = None
    if a.model:
        from mediapipe.tasks.python import vision
        from mediapipe.tasks.python.core.base_options import BaseOptions
        det = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=a.model), running_mode=vision.RunningMode.IMAGE, num_poses=1))
    os.makedirs(os.path.join(a.out, 'cut'), exist_ok=True)
    recs = []
    W = H = None
    for idx, f in enumerate(files):
        rgba = cv2.cvtColor(cv2.imread(os.path.join(a.src, f), cv2.IMREAD_UNCHANGED), cv2.COLOR_BGRA2RGBA)
        if rgba.shape[2] != 4:
            raise SystemExit(f'{f} にアルファがありません')
        H, W = rgba.shape[:2]
        mask, removed = subject_mask(rgba[..., 3])
        if not mask.any():
            raise SystemExit(f'{f}: 人物が見つかりません')
        clean = rgba.copy()
        clean[..., 3] = np.where(mask, rgba[..., 3], 0)
        ys, xs = np.nonzero(clean[..., 3] > 0)
        x0, y0 = max(0, xs.min() - 2), max(0, ys.min() - 2)
        x1, y1 = min(W, xs.max() + 3), min(H, ys.max() + 3)
        crop = clean[y0:y1, x0:x1]
        name = f'frame_{idx:04d}.webp'
        cv2.imwrite(os.path.join(a.out, 'cut', name), cv2.cvtColor(crop, cv2.COLOR_RGBA2BGRA),
                    [cv2.IMWRITE_WEBP_QUALITY, a.quality])
        joints = detect_joints(det, clean) if det else None
        c, L, how = torso(joints, mask)
        t = ts.get(f) if ts else None
        recs.append({'i': idx, 't': round(t if t is not None else idx * a.interval, 4), 'file': 'cut/' + name,
                     'crop': [int(x0), int(y0), int(x1 - x0), int(y1 - y0)],
                     'bbox': [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)],
                     'center': [float(c[0]), float(c[1])], 'torso': L, 'anchorFrom': how, 'debris': removed,
                     **({'joints': joints} if joints else {})})
        if idx % 50 == 0:
            print(idx, f, how, flush=True)
    # 体格補正（撮影距離による変化だけを滑らかに）
    Ls = smooth([r['torso'] for r in recs])
    # 直立時の全高 / 胴の長さ（冒頭の直立 5 コマの中央値）
    standRatio = float(np.median([recs[i]['bbox'][3] / Ls[i] for i in range(min(5, len(recs)))]))
    cx = np.array([r['center'][0] for r in recs])
    cy = np.array([r['center'][1] for r in recs])
    # 胴体中心の推定の揺れだけを抑える（3 コマの中央値。動作そのものは残す）
    mx = np.array([np.median(cx[max(0, i - 1):i + 2]) for i in range(len(cx))])
    my = np.array([np.median(cy[max(0, i - 1):i + 2]) for i in range(len(cy))])
    ext = {'up': 0, 'down': 0, 'left': 0, 'right': 0}
    for i, r in enumerate(recs):
        k = 1.0 / (standRatio * Ls[i])
        r['anchor'] = [round(float(mx[i]), 2), round(float(my[i]), 2)]
        r['k'] = round(float(k), 7)
        bx, by, bw, bh = r['bbox']
        e = {'up': (my[i] - by) * k, 'down': (by + bh - my[i]) * k, 'left': (mx[i] - bx) * k, 'right': (bx + bw - mx[i]) * k}
        r['extent'] = {kk: round(float(v), 4) for kk, v in e.items()}
        for kk in ext:
            ext[kk] = max(ext[kk], float(e[kk]))
        del r['center'], r['torso']
    manifest = {
        'schemaVersion': 1, 'kind': 'seipai-frames', 'standIn': bool(a.stand_in),
        'source': os.path.basename(os.path.normpath(a.src)) + ('（ローカル試験用の代用素材）' if a.stand_in else ''),
        'width': W, 'height': H, 'frameCount': len(recs), 'frameIntervalSeconds': a.interval,
        'durationSeconds': a.duration, 'timesFrom': 'timestamps.csv' if ts else 'index × interval',
        'scale': {'unit': 'standing height', 'standRatio': round(standRatio, 4), 'smoothing': 'median 11 + gaussian σ4 frames of torso length'},
        'extents': {k: round(v, 4) for k, v in ext.items()},
        # 画面に収める倍率の計算に使う値（ゴミ・床の反射が残ったコマに引きずられないよう 99.5 パーセンタイル）
        'fitExtents': {k: round(float(np.percentile([r['extent'][k] for r in recs], 99.5)), 4) for k in ext},
        'frames': recs,
    }
    if det:
        det.close()
    json.dump(manifest, open(os.path.join(a.out, 'manifest.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
    total = sum(os.path.getsize(os.path.join(a.out, 'cut', f)) for f in os.listdir(os.path.join(a.out, 'cut')))
    print(f'{len(recs)} frames, cut images {total / 1e6:.1f} MB, extents {manifest["extents"]}, '
          f'anchor from joints {sum(r["anchorFrom"] == "joints" for r in recs)}/{len(recs)}, debris removed in '
          f'{sum(r["debris"] > 0 for r in recs)} frames')


if __name__ == '__main__':
    main()
