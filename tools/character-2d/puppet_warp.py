"""ALEXANDRE の 2D フレーム（パラパラ漫画方式）を作る: 直立 360° 回転動画の 1 枚を、KIVA の各コマの姿勢へ 2D 変形する。

3D モデルは使わない。顔だけの差し替えでもない。手順（コマごと）:
  1. KIVA のそのコマの体の向き（MediaPipe の推定）に最も近い向きの ALEXANDRE 参照コマを選ぶ
  2. 参照コマの人物を白背景から切り抜き、細かい三角形メッシュにする。各頂点を体の部位（胴・頭・上腕・前腕・大腿・下腿）
     に距離で重み付けする（2D のスキニング）
  3. 目標の骨格: 骨の向きは KIVA のそのコマ、骨の長さは ALEXANDRE の体（KIVA の画像上の短縮率だけ反映）
  4. 部位ごとのアフィン変換を重みで混ぜて頂点を動かし、三角形ごとに画像を貼る。腕は KIVA の奥行き推定で
     体の前／後ろに描き分ける。腕が元あった場所の体は周囲の色で埋める
  5. KIVA の足の位置に合わせて置き、576×1024 の透過 PNG に書く

限界（必ず確認すること）: 参照は直立・腕を下ろした姿なので、大きく曲げた腕・脚・しゃがみでは布や髪が引き伸ばされる。
裏に隠れていた面（腕の内側など）は元画像に無いので作れない。顔の表情・指は参照のまま。
"""
import argparse
import json
import os

import cv2
import numpy as np

J = {'nose': 0, 'earL': 7, 'earR': 8, 'shL': 11, 'shR': 12, 'elL': 13, 'elR': 14, 'wrL': 15, 'wrR': 16,
     'hipL': 23, 'hipR': 24, 'knL': 25, 'knR': 26, 'anL': 27, 'anR': 28, 'toeL': 31, 'toeR': 32}
LIMBS = [('uarmL', 'shL', 'elL'), ('farmL', 'elL', 'wrL'), ('uarmR', 'shR', 'elR'), ('farmR', 'elR', 'wrR'),
         ('thighL', 'hipL', 'knL'), ('shinL', 'knL', 'anL'), ('thighR', 'hipR', 'knR'), ('shinR', 'knR', 'anR')]
ARM = {'uarmL', 'farmL', 'uarmR', 'farmR'}


def pts(rec):
    P = np.asarray(rec['image'], float)
    out = {k: P[i, :2] for k, i in J.items()}
    out['hipC'] = (out['hipL'] + out['hipR']) / 2
    out['shC'] = (out['shL'] + out['shR']) / 2
    out['earC'] = (out['earL'] + out['earR']) / 2
    return out


WJ = {'shL': 11, 'shR': 12, 'elL': 13, 'elR': 14, 'wrL': 15, 'wrR': 16, 'hipL': 23, 'hipR': 24, 'knL': 25, 'knR': 26,
      'anL': 27, 'anR': 28, 'earL': 7, 'earR': 8}


def world_len(rec, a, b):
    W = np.asarray(rec['world'], float)
    def p(k):
        if k == 'shC':
            return (W[11] + W[12]) / 2
        if k == 'hipC':
            return (W[23] + W[24]) / 2
        if k == 'earC':
            return (W[7] + W[8]) / 2
        return W[WJ[k]]
    return float(np.linalg.norm(p(b) - p(a)))


BONES = [(n, a, b) for n, a, b in [('torso', 'hipC', 'shC'), ('head', 'shC', 'earC')]] + []


def px_per_m(rec):
    """画像の画素 / 推定 3D の長さ。正面を向いている（短縮の少ない）骨ほど大きいので、上位の値を使う"""
    P = pts(rec)
    r = []
    for n, a, b in [('torso', 'hipC', 'shC')] + [(n, a, b) for n, a, b in LIMBS]:
        wl = world_len(rec, a, b)
        if wl > 1e-3:
            r.append(np.linalg.norm(P[b] - P[a]) / wl)
    return float(np.sort(r)[-2])


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else np.array([0.0, -1.0])


def white_alpha(bgr, foot_y):
    """白背景から人物を切り抜く（白からの距離でアルファ。足元の影・床の反射は足の高さで切る）"""
    d = 255 - bgr.astype(np.int32).min(axis=2)
    sat = bgr.astype(np.int32).max(axis=2) - bgr.astype(np.int32).min(axis=2)
    a = np.clip((np.maximum(d, sat) - 14) / 36.0, 0, 1)
    a[int(foot_y):, :] = 0
    m = (a > 0.5).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
    if n > 1:
        keep = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
        big = cv2.dilate((lab == keep).astype(np.uint8), np.ones((9, 9), np.uint8))
        a = a * big
    return cv2.GaussianBlur(a.astype(np.float32), (3, 3), 0)


def seg_dist(P, a, b):
    ab = b - a
    t = np.clip(((P - a) @ ab) / max(1e-9, ab @ ab), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)


def poly_dist(P, poly):
    inside = np.array([cv2.pointPolygonTest(poly.astype(np.float32), (float(x), float(y)), True) for x, y in P])
    return np.maximum(0, -inside)


def limb_affine(a_s, b_s, a_t, b_t, perp):
    """骨 (a_s→b_s) を (a_t→b_t) へ: 骨方向は長さの比、直交方向は perp 倍"""
    u_s, u_t = unit(b_s - a_s), unit(b_t - a_t)
    n_s, n_t = np.array([-u_s[1], u_s[0]]), np.array([-u_t[1], u_t[0]])
    k = float(np.clip(np.linalg.norm(b_t - a_t) / max(1e-6, np.linalg.norm(b_s - a_s)), 0.25, 2.5))   # 短く写った骨の過大な引き伸ばしを防ぐ
    M = np.outer(u_t, u_s) * k + np.outer(n_t, n_s) * perp
    return np.c_[M, a_t - M @ a_s]


def torso_affine(R, T):
    """胴: 腰の中心→肩の中心を軸に、幅は肩幅・腰幅の平均。横向きで幅が潰れても不安定にならないよう最小幅を設ける"""
    def frame(P):
        c = P['hipC']; up = P['shC'] - P['hipC']; L = np.linalg.norm(up); u = up / max(L, 1e-6)
        n = np.array([u[1], -u[0]])
        wv = ((P['shL'] - P['shR']) + (P['hipL'] - P['hipR'])) / 2
        wd = wv @ n
        if abs(wd) < 0.3 * L:
            wd = np.sign(wd if wd != 0 else 1) * 0.3 * L
        return c, u * L, n * wd
    cs, us, ns = frame(R)
    ct, ut, nt = frame(T)
    Ms = np.c_[us, ns]; Mt = np.c_[ut, nt]
    M = Mt @ np.linalg.inv(Ms)
    return np.c_[M, ct - M @ cs]


def fit_affine(src, dst):
    A = np.c_[src, np.ones(len(src))]
    X, *_ = np.linalg.lstsq(A, dst, rcond=None)
    return X.T


class Reference:
    def __init__(self, ref_dir, ref_pose):
        self.dir = ref_dir
        self.recs = [r for r in json.load(open(ref_pose)) if 'image' in r]
        self.yaws = np.array([r['yaw'] for r in self.recs])
        front = self.recs[int(np.argmin(np.abs(self.yaws)))]
        P = pts(front)
        # ALEXANDRE の骨の長さ（正面・腕を下ろした直立。画素、参照動画の縮尺）
        self.len = {name: np.linalg.norm(P[b] - P[a]) for name, a, b in LIMBS}
        self.len['torso'] = np.linalg.norm(P['shC'] - P['hipC'])
        self.len['head'] = np.linalg.norm(P['earC'] - P['shC'])
        self.height = np.linalg.norm(P['nose'] - (P['anL'] + P['anR']) / 2)

    def nearest(self, yaw):
        d = np.abs((self.yaws - yaw + 180) % 360 - 180)
        return self.recs[int(np.argmin(d))]


def target_skeleton(K, R, ratio, g):
    """K: KIVA の関節（画素）。骨の向きと画像上の長さ（短縮を含む）は KIVA、長さの比は ALEXANDRE/KIVA の推定 3D の比。
    幅（肩幅・腰幅）は同じ向きの参照コマの幅を g 倍"""
    T = {}
    T['hipC'] = K['hipC'].copy()
    hw = np.linalg.norm(R['hipL'] - R['hipR']) * g
    ax = unit(K['hipL'] - K['hipR'])
    T['hipL'], T['hipR'] = T['hipC'] + ax * hw / 2, T['hipC'] - ax * hw / 2
    T['shC'] = T['hipC'] + (K['shC'] - K['hipC']) * ratio['torso']
    sw = np.linalg.norm(R['shL'] - R['shR']) * g
    ax = unit(K['shL'] - K['shR'])
    T['shL'], T['shR'] = T['shC'] + ax * sw / 2, T['shC'] - ax * sw / 2
    T['earC'] = T['shC'] + (K['earC'] - K['shC']) * ratio['head']
    for name, a, b in LIMBS:
        # 肩・股関節は ALEXANDRE の幅で置いたので、そこから KIVA の骨のベクトル（長さは比で補正）をつなぐ
        T[b] = T[a] + (K[b] - K[a]) * ratio[name]
    return T


def render(ref_img, alpha, R, T, g, arm_front, out_size, step=6):
    h, w = alpha.shape
    ys, xs = np.nonzero(alpha > 0.02)
    x0, x1, y0, y1 = xs.min() - step, xs.max() + step, ys.min() - step, ys.max() + step
    gx = np.arange(max(0, x0), min(w, x1) + step, step)
    gy = np.arange(max(0, y0), min(h, y1) + step, step)
    GX, GY = np.meshgrid(gx, gy)
    V = np.c_[GX.ravel(), GY.ravel()].astype(float)
    nx = len(gx)
    # 部位の重み
    sigma = 0.035 * np.linalg.norm(R['nose'] - (R['anL'] + R['anR']) / 2)
    names = ['torso', 'head'] + [n for n, _, _ in LIMBS]
    D = np.zeros((len(V), len(names)))
    torso_poly = np.array([R['shL'], R['shR'], R['hipR'], R['hipL']])
    D[:, 0] = poly_dist(V, torso_poly)
    D[:, 1] = seg_dist(V, R['shC'], R['earC'] + (R['earC'] - R['shC']) * 0.6)
    for k, (n, a, b) in enumerate(LIMBS):
        bb = R[b] + (R[b] - R[a]) * (0.35 if n.startswith(('farm', 'shin')) else 0.0)   # 手・足先まで
        D[:, 2 + k] = seg_dist(V, R[a], bb)
    # コートの裾・垂れた髪: 腰より下で脚の芯から離れた所は胴（骨盤）に従わせる（脚を広げても裾が翼のように裂けない）
    leg_cols = [2 + k for k, (n, _, _) in enumerate(LIMBS) if n.startswith(('thigh', 'shin'))]
    hip_y = (R['hipL'][1] + R['hipR'][1]) / 2
    leg_core = D[:, leg_cols].min(1)
    below = np.clip((V[:, 1] - hip_y) / (0.1 * np.linalg.norm(R['nose'] - (R['anL'] + R['anR']) / 2)), 0, 1)
    skirt = below * np.clip((leg_core - 0.45 * sigma) / sigma, 0, 1)
    D[:, 0] = D[:, 0] * (1 - skirt) + np.minimum(D[:, 0], leg_core * 0.5) * skirt
    # 最も近い部位の重みが常に 1 になるようにずらす（どの骨からも遠い髪の先・紐が原点へ飛ばないように）
    W = np.exp(-(D ** 2 - D.min(1, keepdims=True) ** 2) / sigma ** 2)
    W /= W.sum(1, keepdims=True)
    dom = np.array(names)[np.argmax(W, 1)]
    # 部位ごとの変換
    A = {'torso': torso_affine(R, T)}
    A['head'] = limb_affine(R['shC'], R['earC'], T['shC'], T['earC'], g)
    for n, a, b in LIMBS:
        A[n] = limb_affine(R[a], R[b], T[a], T[b], g)
    Vh = np.c_[V, np.ones(len(V))]
    Vt = sum(W[:, k:k + 1] * (Vh @ A[n].T) for k, n in enumerate(names))
    # 三角形（人物の上だけ）
    tris = []
    for r in range(len(gy) - 1):
        for c in range(nx - 1):
            i0 = r * nx + c
            q = [i0, i0 + 1, i0 + nx + 1, i0 + nx]
            ya, yb, xa, xb = int(gy[r]), min(h - 1, int(gy[r + 1])), int(gx[c]), min(w - 1, int(gx[c + 1]))
            if alpha[ya:yb + 1, xa:xb + 1].max() < 0.02:
                continue
            tris.append((q[0], q[1], q[2]))
            tris.append((q[0], q[2], q[3]))
    # 腕の層と体の層に分ける。体の層は腕のあった所を周囲の色で埋める
    rgba = np.dstack([ref_img.astype(np.float32), alpha * 255]).astype(np.float32)
    arm_mask = np.zeros((h, w), np.uint8)
    layers = {'body': [], 'armL': [], 'armR': []}
    for t in tris:
        d = [dom[i] for i in t]
        key = 'armL' if sum(x in ('uarmL', 'farmL') for x in d) >= 2 else 'armR' if sum(x in ('uarmR', 'farmR') for x in d) >= 2 else 'body'
        layers[key].append(t)
        if key != 'body':
            cv2.fillConvexPoly(arm_mask, V[list(t)].astype(np.int32), 255)
    body_src = rgba.copy()
    if arm_mask.any():
        bgr8 = ref_img.copy()
        body_src[..., :3] = cv2.inpaint(bgr8, arm_mask, 5, cv2.INPAINT_TELEA).astype(np.float32)
        # 腕の後ろが体（胴の輪郭の内側）なら不透明、外なら透明にする
        a8 = (alpha * 255).astype(np.uint8)
        body_only = a8.copy(); body_only[arm_mask > 0] = 0
        closed = cv2.morphologyEx(body_only, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
        body_src[..., 3] = np.where(arm_mask > 0, closed, body_src[..., 3])
    out_layers = {}
    ss = 2   # 2 倍で描いて縮小（三角形の継ぎ目・ギザギザを消す）
    for key, tl in layers.items():
        canvas = np.zeros((out_size[1] * ss, out_size[0] * ss, 4), np.float32)
        src = body_src if key == 'body' else rgba
        for t in tl:
            warp_tri(src, canvas, V[list(t)], Vt[list(t)] * ss)
        # 不透明度で色を重み付けして縮小（縁の黒ずみを防ぐ）
        pre = canvas.copy(); pre[..., :3] *= pre[..., 3:4] / 255.0
        small = cv2.resize(pre, out_size, interpolation=cv2.INTER_AREA)
        a = small[..., 3:4] / 255.0
        small[..., :3] = np.where(a > 1e-4, small[..., :3] / np.maximum(a, 1e-4), 0)
        out_layers[key] = small
    order = ['armL' if not arm_front['L'] else None, 'armR' if not arm_front['R'] else None, 'body',
             'armL' if arm_front['L'] else None, 'armR' if arm_front['R'] else None]
    out = np.zeros((out_size[1], out_size[0], 4), np.float32)
    for key in order:
        if key is None:
            continue
        L = out_layers[key]
        a = L[..., 3:4] / 255.0
        out[..., :3] = L[..., :3] * a + out[..., :3] * (1 - a)
        out[..., 3:4] = 255 * (a + out[..., 3:4] / 255.0 * (1 - a))
    return out


def warp_tri(src, dst, ts, td):
    r_s = cv2.boundingRect(ts.astype(np.float32))
    r_d = cv2.boundingRect(td.astype(np.float32))
    if r_d[2] <= 0 or r_d[3] <= 0:
        return
    H, W = dst.shape[:2]
    x, y, w, h = r_d
    if x >= W or y >= H or x + w <= 0 or y + h <= 0:
        return
    ts_l = (ts - r_s[:2]).astype(np.float32)
    td_l = (td - r_d[:2]).astype(np.float32)
    patch = src[r_s[1]:r_s[1] + r_s[3], r_s[0]:r_s[0] + r_s[2]]
    if patch.size == 0:
        return
    M = cv2.getAffineTransform(ts_l, td_l)
    warped = cv2.warpAffine(patch, M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)
    mask = np.zeros((h, w), np.float32)
    cv2.fillConvexPoly(mask, np.round(td_l).astype(np.int32), 1.0)     # 隣の三角形と隙間なく接する（アンチエイリアスは縮小で）
    xa, ya, xb, yb = max(0, x), max(0, y), min(W, x + w), min(H, y + h)
    m = mask[ya - y:yb - y, xa - x:xb - x, None]
    dst[ya:yb, xa:xb] = warped[ya - y:yb - y, xa - x:xb - x] * m + dst[ya:yb, xa:xb] * (1 - m)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ref-dir', required=True)
    ap.add_argument('--ref-pose', required=True)
    ap.add_argument('--kiva-pose', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--frames', default='', help='a-b または i,j,k（空なら全部）')
    ap.add_argument('--size', default='576x1024')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    ref = Reference(a.ref_dir, a.ref_pose)
    K_all = json.load(open(a.kiva_pose))
    size = tuple(map(int, a.size.split('x')))
    # ALEXANDRE と KIVA の骨の長さの比（MediaPipe の推定 3D、メートル）。KIVA は全コマの中央値、ALEXANDRE は正面の直立
    front = ref.recs[int(np.argmin(np.abs(ref.yaws)))]
    names = [('torso', 'hipC', 'shC'), ('head', 'shC', 'earC')] + LIMBS
    ratio = {}
    for n, aa, b in names:
        kl = np.median([world_len(k, aa, b) for k in K_all])
        ratio[n] = float(world_len(front, aa, b) / max(1e-6, kl))
    alex_px_m = {r['i']: px_per_m(r) for r in ref.recs}
    if a.frames:
        sel = list(range(*[int(x) + i for i, x in enumerate(a.frames.split('-'))])) if '-' in a.frames else [int(x) for x in a.frames.split(',')]
    else:
        sel = range(len(K_all))
    Ks = {i: pts(K_all[i]) for i in sel}
    print('bone length ratio ALEXANDRE/KIVA:', {k: round(v, 2) for k, v in ratio.items()})
    log = []
    for i in sel:
        kr = K_all[i]
        K = Ks[i]
        rr = ref.nearest(kr['yaw'])
        R = pts(rr)
        g = px_per_m(kr) / alex_px_m[rr['i']]     # 参照コマの画素 → KIVA のコマの画素（その距離での大きさ）
        print('  g', round(g, 3), 'kiva px/m', round(px_per_m(kr), 1), 'alex px/m', round(alex_px_m[rr['i']], 1))
        T = target_skeleton(K, R, ratio, g)
        # 足元を KIVA の足元にそろえる（脚の長さが違うので腰ではなく足で合わせる）
        dy = max(K['anL'][1], K['anR'][1]) - max(T['anL'][1], T['anR'][1])
        for k in T:
            T[k] = T[k] + np.array([0.0, dy])
        w = np.asarray(kr['world'])
        torso_z = (w[11, 2] + w[12, 2] + w[23, 2] + w[24, 2]) / 4
        arm_front = {'L': bool((w[15, 2] + w[13, 2]) / 2 < torso_z), 'R': bool((w[16, 2] + w[14, 2]) / 2 < torso_z)}
        img = cv2.imread(os.path.join(a.ref_dir, f"alex_{rr['i']:04d}.png"))
        foot_y = max(R['anL'][1], R['anR'][1], R['toeL'][1], R['toeR'][1]) + 0.012 * ref.height
        if not np.isfinite(g) or g <= 0:
            g = 0.3
        alpha = white_alpha(img, foot_y)
        out = render(img, alpha, R, T, g, arm_front, size)
        bgra = np.dstack([out[..., :3], out[..., 3]]).clip(0, 255).astype(np.uint8)
        cv2.imwrite(os.path.join(a.out, f'alexandre_frame_{i:04d}.png'), bgra)
        log.append({'frame': i, 't': kr['t'], 'kiva_yaw': round(kr['yaw'], 1), 'ref_frame': rr['i'], 'ref_time_s': rr['t'],
                    'ref_yaw': round(rr['yaw'], 1), 'arm_front': arm_front})
        print('frame', i, 'yaw', round(kr['yaw']), '-> ref', rr['i'], round(rr['yaw']), flush=True)
    json.dump(log, open(os.path.join(a.out, f'ref_choice_{sel[0]}_{sel[-1]}.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
