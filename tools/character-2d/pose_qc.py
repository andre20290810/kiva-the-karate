"""生成した ALEXANDRE スプライトの姿勢を KIVA の元動画の姿勢と比べる（自動検査＋比較シート）。

  python pose_qc.py --model pose_landmarker_heavy.task --kiva-pose kiva_pose.json --kiva-dir kiva --controls controls10 \
      --gen gen10 --ref ref_sheet.png --frames 0,120,... --out qc10

生成画像（透過 PNG、576×1024）を灰色に重ねて MediaPipe Pose で関節を測り、同じコマの KIVA の 2D 関節と比べる。
長さは KIVA の胴（肩の中点〜腰の中点）で割った値。

自動で判定するもの（1 つでも外れたら NG）:
- 検出できない
- 肩・肘・手首・腰・膝・足首の位置ずれ（1 点でも 0.35 超、平均 0.18 超）
- 腕・脚の左右の取り違え（入れ替えた方が 30% 以上よく合う）
- 肘・膝の曲がり角の差（45° 超）
- 体の向き（推定 3D の胸の向き）の差（60° 超。横向き付近は推定が不安定なので目安）
- 足元: 足の一番低い点の高さの差（0.12 超）
自動で判定できないもの（指の本数、脚の本数、顔・髪・衣装の同一性）は比較シートを目で見て記入する（manual 欄）。
"""
import argparse
import json
import os

import cv2
import mediapipe as mp
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.core.base_options import BaseOptions
import numpy as np

JOINTS = {'L_shoulder': 11, 'R_shoulder': 12, 'L_elbow': 13, 'R_elbow': 14, 'L_wrist': 15, 'R_wrist': 16,
          'L_hip': 23, 'R_hip': 24, 'L_knee': 25, 'R_knee': 26, 'L_ankle': 27, 'R_ankle': 28}
ARMS = ([11, 13, 15], [12, 14, 16])
LEGS = ([23, 25, 27, 29, 31], [24, 26, 28, 30, 32])
LIMITS = {'joint_max': 0.35, 'joint_mean': 0.18, 'swap_ratio': 0.7, 'bend_deg': 45, 'facing_deg': 60, 'foot': 0.12}


def detector(model):
    opts = vision.PoseLandmarkerOptions(base_options=BaseOptions(model_asset_path=model),
                                        running_mode=vision.RunningMode.IMAGE, num_poses=1,
                                        min_pose_detection_confidence=0.3)
    return vision.PoseLandmarker.create_from_options(opts)


def on_grey(rgba):
    a = rgba[..., 3:4].astype(np.float32) / 255
    return (rgba[..., :3] * a + 120 * (1 - a)).astype(np.uint8)


def facing(W):
    """推定 3D の胴の向き（度、0 = カメラ正面、+ = 人物が画面右へ向く）。kiva_pose.json の yaw と同じ式。"""
    W = np.asarray(W)[:, :3]
    across = (W[11] + W[23]) / 2 - (W[12] + W[24]) / 2
    up = (W[11] + W[12]) / 2 - (W[23] + W[24]) / 2
    f = np.cross(across, up)
    return float(np.degrees(np.arctan2(f[0], -f[2])))


def bend(P, a, b, c):
    u, v = P[a] - P[b], P[c] - P[b]
    return float(np.degrees(np.arccos(np.clip(u @ v / (np.linalg.norm(u) * np.linalg.norm(v) + 1e-9), -1, 1))))


def check(K, G, Wk, Wg):
    """K, G: (33,2) 画素座標。戻り値: 指標と NG 理由。"""
    torso = np.linalg.norm((K[11] + K[12]) / 2 - (K[23] + K[24]) / 2) + 1e-6
    err = {n: float(np.linalg.norm(G[j] - K[j]) / torso) for n, j in JOINTS.items()}
    reasons = []
    if max(err.values()) > LIMITS['joint_max']:
        worst = max(err, key=err.get)
        reasons.append(f'関節位置 {worst} {err[worst]:.2f}')
    if np.mean(list(err.values())) > LIMITS['joint_mean']:
        reasons.append(f'関節位置の平均 {np.mean(list(err.values())):.2f}')
    swaps = {}
    for name, (l, r) in (('腕', ARMS), ('脚', LEGS)):
        same = np.linalg.norm(G[l] - K[l], axis=1).sum() + np.linalg.norm(G[r] - K[r], axis=1).sum()
        cross = np.linalg.norm(G[l] - K[r], axis=1).sum() + np.linalg.norm(G[r] - K[l], axis=1).sum()
        swaps[name] = round(float(cross / (same + 1e-6)), 2)
        if cross < LIMITS['swap_ratio'] * same:
            reasons.append(f'{name}の左右取り違え（入替 {cross / same:.2f}）')
    bends = {}
    for n, (a, b, c) in {'L_elbow': (11, 13, 15), 'R_elbow': (12, 14, 16), 'L_knee': (23, 25, 27), 'R_knee': (24, 26, 28)}.items():
        d = abs(bend(G, a, b, c) - bend(K, a, b, c))
        bends[n] = round(d, 1)
        if d > LIMITS['bend_deg']:
            reasons.append(f'{n} の曲がり {d:.0f}°')
    fk, fg = facing(Wk), facing(Wg)
    dface = abs((fg - fk + 180) % 360 - 180)
    if dface > LIMITS['facing_deg']:
        reasons.append(f'体の向き {fk:.0f}° → {fg:.0f}°')
    foot = float(abs(G[[27, 28, 29, 30, 31, 32], 1].max() - K[[27, 28, 29, 30, 31, 32], 1].max()) / torso)
    if foot > LIMITS['foot']:
        reasons.append(f'足元の高さ {foot:.2f}')
    return {'joint_err': {k: round(v, 3) for k, v in err.items()}, 'joint_err_mean': round(float(np.mean(list(err.values()))), 3),
            'swap_ratio': swaps, 'bend_diff_deg': bends, 'facing_kiva': round(fk), 'facing_gen': round(fg),
            'foot_diff': round(foot, 3)}, reasons


def skeleton(img, P, color, th=2):
    for a, b in [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24), (23, 25), (25, 27),
                 (24, 26), (26, 28), (27, 31), (28, 32)]:
        cv2.line(img, tuple(int(v) for v in P[a]), tuple(int(v) for v in P[b]), color, th, cv2.LINE_AA)
    for j, c in ((15, (0, 0, 255)), (16, (255, 0, 0)), (27, (0, 0, 255)), (28, (255, 0, 0))):  # 左 = 赤、右 = 青
        cv2.circle(img, tuple(int(v) for v in P[j]), 6, c, -1)


def text(img, lines, color, font=os.environ.get('QC_FONT', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc')):
    """理由（日本語）を画像の左上に書く。フォントが無ければ書かない。"""
    if not lines or not os.path.exists(font):
        return img
    from PIL import Image, ImageDraw, ImageFont
    im = Image.fromarray(img[..., ::-1].copy())
    d, f = ImageDraw.Draw(im), ImageFont.truetype(font, 20)
    for k, t in enumerate(lines):
        d.text((10, 45 + 26 * k), t, font=f, fill=color[::-1], stroke_width=2, stroke_fill=(0, 0, 0))
    return np.asarray(im)[..., ::-1].copy()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--kiva-pose', required=True)
    ap.add_argument('--kiva-dir', required=True)
    ap.add_argument('--controls', required=True)
    ap.add_argument('--gen', required=True)
    ap.add_argument('--ref', help='外見参考の一覧画像（比較シートの各段に縮小して付ける）')
    ap.add_argument('--frames', required=True)
    ap.add_argument('--label', default='generated')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    K = json.load(open(a.kiva_pose))
    frames = [int(x) for x in a.frames.split(',')]
    ref = cv2.imread(a.ref) if a.ref else None
    rows, results = [], []
    with detector(a.model) as det:
        for i in frames:
            path = os.path.join(a.gen, f'alexandre_frame_{i:04d}.png')
            rec = {'frame': i, 't': K[i]['t']}
            if not os.path.exists(path):
                rec.update(result='MISSING', reasons=['画像なし'])
                results.append(rec)
                continue
            rgba = cv2.cvtColor(cv2.imread(path, cv2.IMREAD_UNCHANGED), cv2.COLOR_BGRA2RGBA)
            h, w = rgba.shape[:2]
            alpha = rgba[..., 3]
            rec['canvas'] = [w, h]
            rec['transparent_ratio'] = round(float((alpha < 8).mean()), 3)
            rec['alpha_has_partial'] = bool(((alpha > 8) & (alpha < 247)).any())
            grey = on_grey(rgba)
            r = det.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(grey)))
            Kp = np.asarray(K[i]['image'])[:, :2]
            reasons = []
            if rec['transparent_ratio'] < 0.3:
                reasons.append('背景が透過していない')
            if not r.pose_landmarks:
                reasons.append('人物を検出できない')
                G = None
            else:
                G = np.array([[p.x * w, p.y * h] for p in r.pose_landmarks[0]])
                Wg = [[p.x, p.y, p.z] for p in r.pose_world_landmarks[0]]
                m, rs = check(Kp, G, K[i]['world'], Wg)
                rec.update(m)
                reasons += rs
            rec['reasons'] = reasons
            rec['result'] = 'OK' if not reasons else 'NG'
            rec['manual'] = '目視: 顔・髪・衣装の同一性、指・脚の本数（未記入）'
            results.append(rec)
            # 比較シートの 1 段: 元動画 / 姿勢制御 / 生成（灰） / 生成に骨格（白 = KIVA、黄 = 生成から検出）
            src = cv2.imread(os.path.join(a.kiva_dir, f'kiva_{i:04d}.png'))
            ctl = cv2.imread(os.path.join(a.controls, f'pose_{i:04d}.png'))
            g = cv2.cvtColor(grey, cv2.COLOR_RGB2BGR)
            ov = g.copy()
            skeleton(ov, Kp, (255, 255, 255), 3)
            if G is not None:
                skeleton(ov, G, (0, 220, 255), 2)
            cells = [src, ctl if ctl is not None else np.zeros_like(src), g, ov]
            if ref is not None:
                rh = h
                cells.insert(1, cv2.resize(ref, (int(ref.shape[1] * rh / ref.shape[0]), rh)))
            row = np.hstack([cv2.resize(c, (int(c.shape[1] * 512 / c.shape[0]), 512)) for c in cells])
            color = (60, 200, 60) if rec['result'] == 'OK' else (40, 40, 230)
            cv2.rectangle(row, (0, 0), (row.shape[1] - 1, 511), color, 4)
            cv2.putText(row, f"#{i}  t={K[i]['t']:.1f}s  {rec['result']}", (10, 30), 0, 0.8, color, 2, cv2.LINE_AA)
            rows.append(text(row, reasons[:4], color))
    if rows:
        wmax = max(r.shape[1] for r in rows)
        sheet = np.vstack([np.pad(r, ((0, 0), (0, wmax - r.shape[1]), (0, 0))) for r in rows])
        head = np.full((40, wmax, 3), 30, np.uint8)
        cols = 'KIVA source | ' + ('appearance ref | ' if ref is not None else '') + f'OpenPose control | {a.label} | skeleton: white=KIVA yellow=detected (L=red R=blue)'
        cv2.putText(head, cols, (10, 27), 0, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.imwrite(os.path.join(a.out, 'qc_sheet.jpg'), np.vstack([head, sheet]), [cv2.IMWRITE_JPEG_QUALITY, 88])
    json.dump({'label': a.label, 'limits': LIMITS, 'frames': results}, open(os.path.join(a.out, 'qc.json'), 'w'),
              ensure_ascii=False, indent=1)
    lines = [f'# 姿勢検査: {a.label}', '', '| コマ | 時刻 | 判定 | 関節ずれ平均 | 向き KIVA→生成 | 足元 | 理由 |', '|---|---|---|---|---|---|---|']
    for r in results:
        lines.append(f"| {r['frame']} | {r['t']:.1f} | {r['result']} | {r.get('joint_err_mean', '-')} | "
                     f"{r.get('facing_kiva', '-')}→{r.get('facing_gen', '-')} | {r.get('foot_diff', '-')} | {'; '.join(r['reasons'])} |")
    ok = sum(r['result'] == 'OK' for r in results)
    lines += ['', f'自動検査 OK {ok} / {len(results)}。顔・髪・衣装の同一性と指・脚の本数は自動では判定しない（目視）。']
    open(os.path.join(a.out, 'qc.md'), 'w').write('\n'.join(lines) + '\n')
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
