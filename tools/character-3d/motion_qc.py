"""推定モーションの検査と修正（Blender 非依存）。元動画と 3D の動きが食い違う原因を分けるために使う。

  - 左右の取り違え: MediaPipe が左右のラベルを入れ替えるフレームを、画像上の連続性で検出して戻す
  - 前後の反転: 単眼では奥行きの符号があいまいで、体の正面方向が 1 フレームで 180° 近く反転することがある。
    胴体の正面方向の角速度が人間に不可能な値なら、そのフレームの奥行きを腰中心で反転する
  - 跳び: 骨の向きの角速度・胴体の向きの角速度が閾値を超えるフレームを列挙する
  - 再投影誤差: 3D（骨長固定・接地後）の関節を画像へ弱透視投影し、2D 観測との差を胴体長で割った値。
    「2D 観測は合っているが 3D が違う」か「2D 観測そのものが不確か（可視度が低い）」かを分ける
"""
import numpy as np

PAIRS = [(11, 12), (13, 14), (15, 16), (17, 18), (19, 20), (21, 22), (23, 24), (25, 26), (27, 28), (29, 30), (31, 32),
         (1, 4), (2, 5), (3, 6), (7, 8), (9, 10)]
SWAP = np.arange(33)
for a, b in PAIRS:
    SWAP[a], SWAP[b] = b, a
LIMB_IDX = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]


def _arr(f, key):
    return np.asarray(f[key], dtype=float)


def fix_lr_swaps(frames, margin=0.6):
    """画像上で、左右を入れ替えた方が直前のフレームに大きく近い場合に入れ替える。返り値: 修正したフレーム番号"""
    fixed = []
    prev = None
    for t, f in enumerate(frames):
        if f.get('missing'):
            continue
        im = _arr(f, 'image')[:, :2]
        if prev is not None:
            keep = np.linalg.norm(im[LIMB_IDX] - prev[LIMB_IDX], axis=1).sum()
            swap = np.linalg.norm(im[SWAP][LIMB_IDX] - prev[LIMB_IDX], axis=1).sum()
            if swap < keep * margin:
                for k in ('image', 'world'):
                    f[k] = _arr(f, k)[SWAP].tolist()
                im = _arr(f, 'image')[:, :2]
                fixed.append(t)
        prev = im
    return fixed


def facing(w):
    """MediaPipe world（x 右, y 下, z 奥）の胴体の正面方向（水平、単位ベクトル）"""
    across = (w[11] + w[23]) / 2 - (w[12] + w[24]) / 2     # 人物の右 → 左
    up = (w[11] + w[12]) / 2 - (w[23] + w[24]) / 2
    f = np.cross(across, up)
    f[1] = 0
    n = np.linalg.norm(f)
    return f / n if n > 1e-9 else f


CHAINS = [(11, 13, 15), (12, 14, 16), (23, 25, 27), (24, 26, 28)]


def fix_depth_flips(frames, fps, max_deg_per_s=720.0, limb_jump_deg=55.0):
    """単眼の奥行きのあいまいさによる反転を直す。返り値: [(frame, 種類)]

    - 手足: 骨の向きの奥行き成分だけを反転した方が直前のフレームに大きく近いなら反転する（腕が前か後ろか、の取り違え）
    - 胴体: 正面方向が人間に不可能な速さで変わったとき、「左右ラベルの入れ替え＋奥行きの反転」を試し、近い方を採る
      （後ろ向きの人物を前向きと誤認したときに起きる組み合わせ）
    """
    fixed = []
    prev = None
    lim = max(np.radians(max_deg_per_s) / fps, np.radians(100))
    for t, f in enumerate(frames):
        if f.get('missing'):
            continue
        w = _arr(f, 'world')
        if prev is not None:
            fc, fp = facing(w[:, :3]), facing(prev[:, :3])
            if np.arccos(np.clip(fc @ fp, -1, 1)) > lim:
                w2 = w[SWAP].copy()
                c = (w2[23, 2] + w2[24, 2]) / 2
                w2[:, 2] = 2 * c - w2[:, 2]
                if np.arccos(np.clip(facing(w2[:, :3]) @ fp, -1, 1)) < np.arccos(np.clip(fc @ fp, -1, 1)):
                    w = w2
                    if 'image' in f:
                        f['image'] = _arr(f, 'image')[SWAP].tolist()
                    fixed.append((t, 'torso-front-back'))
            for a, b, c in CHAINS:
                for p0, p1, child in ((a, b, [b, c]), (b, c, [c])):
                    d, dp = w[p1, :3] - w[p0, :3], prev[p1, :3] - prev[p0, :3]
                    m = d.copy(); m[2] = -m[2]
                    cos = lambda u, v: u @ v / (np.linalg.norm(u) * np.linalg.norm(v) + 1e-9)
                    a0, a1 = np.degrees(np.arccos(np.clip(cos(d, dp), -1, 1))), np.degrees(np.arccos(np.clip(cos(m, dp), -1, 1)))
                    if a0 > limb_jump_deg and a1 < a0 * 0.5:
                        dz = m[2] - d[2]
                        for k in child:
                            w[k, 2] += dz
                        fixed.append((t, f'limb-depth {p0}-{p1}'))
            f['world'] = w.tolist()
        prev = w
    return fixed


BONES = [('shoulder.L', 'elbow.L'), ('elbow.L', 'wrist.L'), ('shoulder.R', 'elbow.R'), ('elbow.R', 'wrist.R'),
         ('hip.L', 'knee.L'), ('knee.L', 'ankle.L'), ('hip.R', 'knee.R'), ('knee.R', 'ankle.R'), ('hips', 'chest')]


def detect_jumps(Js, fps, bone_deg_s=1400.0, torso_deg_s=600.0):
    """骨の向き・胴体の向きの角速度が閾値を超えたフレーム。返り値: [(frame, kind, deg/s)]"""
    out = []
    for t in range(1, len(Js)):
        for a, b in BONES:
            u = Js[t][b] - Js[t][a]; v = Js[t - 1][b] - Js[t - 1][a]
            ang = np.degrees(np.arccos(np.clip(u @ v / (np.linalg.norm(u) * np.linalg.norm(v) + 1e-9), -1, 1))) * fps
            if ang > bone_deg_s:
                out.append((t, f'{a}-{b}', float(ang)))
        f1 = np.cross(Js[t]['hip.L'] - Js[t]['hip.R'], [0, 0, 1.0])
        f0 = np.cross(Js[t - 1]['hip.L'] - Js[t - 1]['hip.R'], [0, 0, 1.0])
        ang = np.degrees(np.arccos(np.clip(f1 @ f0 / (np.linalg.norm(f1) * np.linalg.norm(f0) + 1e-9), -1, 1))) * fps
        if ang > torso_deg_s:
            out.append((t, 'pelvis-yaw', float(ang)))
    return out


REPROJ = {'shoulder.L': 11, 'shoulder.R': 12, 'elbow.L': 13, 'elbow.R': 14, 'wrist.L': 15, 'wrist.R': 16,
          'hip.L': 23, 'hip.R': 24, 'knee.L': 25, 'knee.R': 26, 'ankle.L': 27, 'ankle.R': 28}


def reprojection(J, frame):
    """3D 関節（モデル座標: X 左, Y 奥, Z 上。カメラは -Y 側）を弱透視で画像へ当てはめた誤差。

    返り値: {'per_joint': {名前: 誤差/胴体長}, 'mean': 平均, 'fit': (倍率, tx, ty), 'proj': {名前: (px, py)}, 'vis': {名前: 可視度}}
    """
    im = np.asarray(frame['image'], dtype=float)
    w, h = frame['size']
    names = list(REPROJ)
    obs = np.array([[im[REPROJ[n], 0] * w, im[REPROJ[n], 1] * h] for n in names])
    vis = np.array([im[REPROJ[n], 3] if im.shape[1] > 3 else 1.0 for n in names])
    X = np.array([[J[n][0], -J[n][2]] for n in names])          # 画像の x 右 = モデル X、画像の y 下 = -Z
    wts = np.clip(vis, 0.2, 1.0)
    # 重み付き最小二乗: obs ≈ s * X + t
    mx, mo = np.average(X, axis=0, weights=wts), np.average(obs, axis=0, weights=wts)
    A, B = X - mx, obs - mo
    s = float((wts[:, None] * A * B).sum() / max(1e-9, (wts[:, None] * A * A).sum()))
    proj = s * A + mo
    torso = np.linalg.norm((obs[0] + obs[1]) / 2 - (obs[6] + obs[7]) / 2)
    err = np.linalg.norm(proj - obs, axis=1) / max(1e-6, torso)
    return {'per_joint': dict(zip(names, err.round(4).tolist())), 'mean': float(np.average(err, weights=wts)),
            'fit': (s, *(mo - s * mx).tolist()), 'proj': dict(zip(names, proj.round(1).tolist())),
            'vis': dict(zip(names, vis.round(3).tolist()))}


def classify(rep, vis_low=0.5, err_high=0.25):
    """関節ごとの原因の目安: 'ok' / '2D 観測が不確か' / '3D・転写の問題'"""
    out = {}
    for n, e in rep['per_joint'].items():
        v = rep['vis'][n]
        out[n] = 'ok' if e < err_high else ('2D-uncertain' if v < vis_low else '3D/retarget')
    return out
