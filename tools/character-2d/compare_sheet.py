"""代表フレームの比較シート: KIVA 元画像 | 使った ALEXANDRE 参照（向きが近いコマ） | 生成した ALEXANDRE（灰色背景）| 生成を KIVA の背景に重ねたもの"""
import argparse
import json
import os

import numpy as np
from PIL import Image, ImageDraw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--kiva-dir', required=True)
    ap.add_argument('--ref-dir', required=True)
    ap.add_argument('--gen-dir', required=True)
    ap.add_argument('--kiva-pose', required=True)
    ap.add_argument('--ref-pose', required=True)
    ap.add_argument('--frames', required=True)
    ap.add_argument('--labels', default='')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    K = json.load(open(a.kiva_pose))
    R = [r for r in json.load(open(a.ref_pose)) if 'yaw' in r]
    ids = [int(x) for x in a.frames.split(',')]
    labels = a.labels.split(',') if a.labels else [''] * len(ids)
    W, H = 216, 384
    S = Image.new('RGB', (W * 4, (H + 22) * len(ids) + 24), (18, 18, 22))
    d = ImageDraw.Draw(S)
    for c, t in enumerate(['KIVA source (pose template)', 'ALEXANDRE ref (nearest yaw)', 'generated ALEXANDRE', 'generated over KIVA bg']):
        d.text((c * W + 6, 6), t, fill=(230, 230, 230))
    for r, (i, lab) in enumerate(zip(ids, labels)):
        y = 24 + r * (H + 22)
        yaw = K[i]['yaw']
        dd = np.abs((np.array([x['yaw'] for x in R]) - yaw + 180) % 360 - 180)
        ref = R[int(np.argmin(dd))]
        kiva = Image.open(os.path.join(a.kiva_dir, f'kiva_{i:04d}.png')).convert('RGB')
        gen = Image.open(os.path.join(a.gen_dir, f'alexandre_frame_{i:04d}.png')).convert('RGBA')
        grey = Image.new('RGBA', gen.size, (120, 120, 126, 255)); grey.alpha_composite(gen)
        over = kiva.convert('RGBA'); over.alpha_composite(gen)
        refim = Image.open(os.path.join(a.ref_dir, f"alex_{ref['i']:04d}.png")).convert('RGB')
        for c, im in enumerate([kiva, refim, grey.convert('RGB'), over.convert('RGB')]):
            S.paste(im.resize((W, H)), (c * W, y + 22))
        d.text((6, y + 4), f'#{i:04d}  t={K[i]["t"]:.1f}s  KIVA yaw {yaw:.0f}  -> ref frame {ref["i"]} (t={ref["t"]:.2f}s, yaw {ref["yaw"]:.0f})  {lab}', fill=(255, 220, 120))
    S.save(a.out)


if __name__ == '__main__':
    main()
