"""ALEXANDRE の外見参考を gen_sprites.py 用にまとめる（refs.json と切り出し画像）。

  python make_refs.py --pack source/character-reference-video --style source/alexandre_sprites_style.webp --out refs

参考資料の README の優先順位に従う:
- 顔の主基準（全コマ共通）: D01_front_face_hair、D02_oblique_face_hair
- 全身（体の向きが近いものを毎コマ 1 枚）: 01〜09。10_front_return は比較用なので使わない
- 画風（全コマ共通）: alexandre_sprites.png の 10 体のうち --style-pick 番目（黒地から切り出して透過）
向き: 0° = 正面、+ = 人物が画面右へ向く、±180° = 背面。正面側は回転動画を MediaPipe で測った値、
背面側（05〜07）は測定が不安定なので画像名の向き。
"""
import argparse
import json
import os

import cv2
import numpy as np

BODY = [('01_front.png', -9.5, '測定'), ('02_front_left_oblique.png', -34.5, '測定'),
        ('03_left_face_oblique.png', -67.9, '測定'), ('04_left_side.png', -100, '測定 -114 と名前 -90 の間'),
        ('05_rear_left_oblique.png', -135, '名前'), ('06_back.png', 180, '名前'),
        ('07_rear_right_oblique.png', 135, '名前'), ('08_right_side.png', 100, '測定 117 と名前 90 の間'),
        ('09_front_right_oblique.png', 57.1, '測定')]
FACE = ['D01_front_face_hair.png', 'D02_oblique_face_hair.png']


def style_panels(path, out, cols=5, rows=2):
    """黒地の一覧画像（5 列 × 2 段に等間隔で並んだ人物）を 1 人ずつ切り出して透過 PNG にする。"""
    bgr = cv2.imread(path)
    H, W = bgr.shape[:2]
    files = []
    for r in range(rows):
        for c in range(cols):
            x0, x1, y0, y1 = W * c // cols, W * (c + 1) // cols, H * r // rows, H * (r + 1) // rows
            cell = bgr[y0:y1, x0:x1]
            v = cell.max(axis=2)
            m = cv2.morphologyEx((v > 3).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))  # 背景は完全な黒
            n, lab, st, _ = cv2.connectedComponentsWithStats(m)
            if n < 2:
                continue
            keep = 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])
            body = (lab == keep).astype(np.uint8)
            # 外周につながらない穴（黒いコートの内側）だけを埋める。脚の間など外周につながる黒は背景
            n2, lab2 = cv2.connectedComponents((1 - body).astype(np.uint8))
            edge = set(np.unique(np.concatenate([lab2[0], lab2[-1], lab2[:, 0], lab2[:, -1]])))
            body[~np.isin(lab2, list(edge))] = 1
            a = cv2.GaussianBlur(cv2.erode(body, np.ones((3, 3), np.uint8)).astype(np.float32), (5, 5), 0)
            x, y, w, h = st[keep, :4]
            f = os.path.join(out, f'style_{len(files):02d}.png')
            cv2.imwrite(f, np.dstack([cell, (a * 255).astype(np.uint8)])[y:y + h, x:x + w])
            files.append(f)
    return files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pack', required=True)
    ap.add_argument('--style')
    ap.add_argument('--style-pick', type=int, default=0)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    face = [os.path.abspath(os.path.join(a.pack, '02_face_hair_costume_crops', f)) for f in FACE]
    body = [{'file': os.path.abspath(os.path.join(a.pack, '01_fullbody_transparent', f)), 'yaw': y, 'yaw_source': s}
            for f, y, s in BODY]
    style = style_panels(a.style, a.out) if a.style else []
    refs = {'face': face + ([os.path.abspath(style[a.style_pick])] if style else []), 'body': body,
            'style_panels': [os.path.abspath(s) for s in style],
            'note': '顔の主基準 D01/D02 と画風 1 枚は全コマ共通。全身は向きが最も近い 1 枚。10_front_return は使わない。'}
    for f in face + [b['file'] for b in body]:
        assert os.path.exists(f), f
    json.dump(refs, open(os.path.join(a.out, 'refs.json'), 'w'), indent=1, ensure_ascii=False)
    print('face', len(face), 'body', len(body), 'style panels', len(style))


if __name__ == '__main__':
    main()
