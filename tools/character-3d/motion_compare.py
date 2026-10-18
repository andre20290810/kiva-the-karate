"""元映像と 3D を同じ時刻で並べ、ずれを数値で出す（Blender 不要）。

  静止画: python motion_compare.py --lm tsuki_lm.json --rest rest_joints.json --images-dir refdir --out outdir [--render-dir dir]
  動画:   python motion_compare.py --lm seipai_lm.json --rest rest_joints.json --video seipai.mp4 --from 28.2 --to 33.6
                                   --out outdir [--render-dir capture_frames] [--fps 30]

各フレームの画像（左: 元映像に 2D 観測（緑）と 3D の再投影（桃）、右: 3D の描画）と、
metrics.json（関節ごとの再投影誤差 / 胴体長、原因の目安、跳び、修正した左右・奥行きの反転）を書く。
--render-dir の 3D 画像は tests/capture-3d.mjs --keep-frames で同じ時刻・同じ枚数を作る。
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import motion_filter as mf  # noqa: E402
import motion_qc as qcm  # noqa: E402

EDGES = [('shoulder.L', 'shoulder.R'), ('hip.L', 'hip.R'), ('shoulder.L', 'hip.L'), ('shoulder.R', 'hip.R'),
         ('shoulder.L', 'elbow.L'), ('elbow.L', 'wrist.L'), ('shoulder.R', 'elbow.R'), ('elbow.R', 'wrist.R'),
         ('hip.L', 'knee.L'), ('knee.L', 'ankle.L'), ('hip.R', 'knee.R'), ('knee.R', 'ankle.R')]


def draw(img, pts, color, width=3):
    d = ImageDraw.Draw(img)
    for a, b in EDGES:
        if a in pts and b in pts:
            d.line([tuple(pts[a]), tuple(pts[b])], fill=color, width=width)
    for p in pts.values():
        d.ellipse([p[0] - 3, p[1] - 3, p[0] + 3, p[1] + 3], fill=color)


def frames_from_video(path, times):
    import cv2
    cap = cv2.VideoCapture(path)
    for t in times:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, bgr = cap.read()
        yield Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)) if ok else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lm', required=True)
    ap.add_argument('--rest', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--images-dir')
    ap.add_argument('--video')
    ap.add_argument('--from', dest='t0', type=float, default=0)
    ap.add_argument('--to', dest='t1', type=float, default=1e9)
    ap.add_argument('--fps', type=float, default=30)
    ap.add_argument('--render-dir')
    ap.add_argument('--height', type=int, default=720)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    rest = {k: np.array(v) for k, v in json.load(open(a.rest)).items()}
    data = json.load(open(a.lm))
    still = a.images_dir is not None
    frames = data['frames']
    if not still:
        # 区間の前後 2 秒も含めて処理し（平滑化・足固定の助走）、区間だけを出力する
        frames = [f for f in frames if a.t0 - 2 <= f.get('time', 0) <= a.t1 + 2]
    qc = {}
    if still:
        Js = [mf.process([f], rest, smooth=False, foot_lock=False)[0][0] if not f.get('missing') else None for f in frames]
    else:
        Js, _ = mf.process(frames, rest, fps=a.fps, qc=qc)
    sel = [i for i, f in enumerate(frames) if not f.get('missing') and (still or a.t0 <= f['time'] <= a.t1)]
    imgs = (Image.open(os.path.join(a.images_dir, frames[i]['name'])).convert('RGB') for i in sel) if still else \
        frames_from_video(a.video, [frames[i]['time'] for i in sel])
    rows = []
    for k, (i, src) in enumerate(zip(sel, imgs)):
        f = frames[i]
        rep = qcm.reprojection(Js[i], f)
        cls = qcm.classify(rep)
        w, h = f['size']
        obs = {n: (np.array(f['image'])[j, 0] * w, np.array(f['image'])[j, 1] * h) for n, j in qcm.REPROJ.items()}
        if src is None:
            continue
        left = src.copy()
        draw(left, obs, (60, 230, 90))
        draw(left, {n: tuple(p) for n, p in rep['proj'].items()}, (255, 60, 200), width=2)
        d = ImageDraw.Draw(left)
        label = f.get('name') or f"t={f['time']:.2f}s"
        d.rectangle([0, 0, w, 40], fill=(0, 0, 0))
        d.text((6, 4), f'{label}  reproj err {rep["mean"]:.3f} x torso  green=2D obs  pink=3D reprojected', fill=(255, 255, 255))
        bad = [n for n, c in cls.items() if c != 'ok']
        d.text((6, 22), ('mismatch: ' + ', '.join(f'{n}({cls[n]})' for n in bad))[:110] if bad else 'all joints within 0.25 torso', fill=(255, 220, 120))
        panels = [left]
        if a.render_dir:
            rp = os.path.join(a.render_dir, f'{k:05d}.png')
            if os.path.exists(rp):
                panels.append(Image.open(rp).convert('RGB'))
        H = a.height
        panels = [p.resize((int(p.width * H / p.height), H)) for p in panels]
        out = Image.new('RGB', (sum(p.width for p in panels), H))
        x = 0
        for p in panels:
            out.paste(p, (x, 0)); x += p.width
        out.save(os.path.join(a.out, f'{k:05d}.png'))
        rows.append({'frame': i, 'label': label, 'mean': rep['mean'], 'per_joint': rep['per_joint'], 'class': cls})
    joints = list(qcm.REPROJ)
    summary = {j: {'mean': float(np.mean([r['per_joint'][j] for r in rows])) if rows else None,
                   'over_0.25': float(np.mean([r['per_joint'][j] > 0.25 for r in rows])) if rows else None} for j in joints}
    json.dump({'note': '再投影誤差は胴体長に対する比。3D は単眼推定で、奥行きは画像からは検証できない（横から見た向きは別途目視）',
               'summary': summary, 'frames': rows,
               'qc': {k: v for k, v in qc.items()}}, open(os.path.join(a.out, 'metrics.json'), 'w'), indent=1)
    print(len(rows), 'frames; mean reproj', np.mean([r['mean'] for r in rows]).round(3) if rows else None)


if __name__ == '__main__':
    main()
