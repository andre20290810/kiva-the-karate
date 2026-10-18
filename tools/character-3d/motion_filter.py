"""単眼推定の関節（MediaPipe world landmarks）を人体モデルの骨長で組み直し、時間方向に整える。Blender 非依存。

推定 3D は測定値ではない。ここでの処理は「破綻しにくくする」ためのもので、奥行きや回転の正確さは保証しない。
  - 可視度で重み付けした時間平滑化（One Euro 相当の適応ローパス）
  - 骨長をモデルの値に固定（区間の向きだけを使う）
  - 接地: 足首の速度が小さく床付近にある区間は足首位置を固定し、2 リンク IK で膝を解く（足滑りの抑制）
  - 腰の高さ: 支持脚の足首が床に着くように決める
"""
import numpy as np

MP = {'nose': 0, 'ear.L': 7, 'ear.R': 8, 'shoulder.L': 11, 'shoulder.R': 12, 'elbow.L': 13, 'elbow.R': 14,
      'wrist.L': 15, 'wrist.R': 16, 'hip.L': 23, 'hip.R': 24, 'knee.L': 25, 'knee.R': 26,
      'ankle.L': 27, 'ankle.R': 28, 'heel.L': 29, 'heel.R': 30, 'toe.L': 31, 'toe.R': 32}


def to_model_axes(w):
    """MediaPipe world（x 右, y 下, z 奥=カメラから遠い）→ モデル座標（X 人物の左, Y 後ろ, Z 上）。カメラは -Y 側。"""
    w = np.asarray(w, dtype=float)
    return np.stack([w[..., 0], w[..., 2], -w[..., 1]], axis=-1)


def one_euro(x, vis, fps, min_cutoff=1.6, beta=0.4, d_cutoff=1.0):
    """x: (T, 3)。可視度が低いフレームは前の値を強く残す。"""
    out = np.empty_like(x)
    out[0] = x[0]
    dx_prev = np.zeros(3)
    dt = 1.0 / fps

    def alpha(c):
        tau = 1.0 / (2 * np.pi * c)
        return 1.0 / (1.0 + tau / dt)
    for t in range(1, len(x)):
        dx = (x[t] - out[t - 1]) / dt
        a_d = alpha(d_cutoff)
        dx_hat = a_d * dx + (1 - a_d) * dx_prev
        c = min_cutoff + beta * np.linalg.norm(dx_hat)
        a = alpha(c) * float(np.clip(vis[t], 0.15, 1.0))
        out[t] = a * x[t] + (1 - a) * out[t - 1]
        dx_prev = dx_hat
    return out


def _unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else v


def two_bone_ik(hip, ankle, knee_hint, a, b):
    d = ankle - hip
    dist = min(np.linalg.norm(d), (a + b) * 0.999)
    u = _unit(d)
    x = (a * a - b * b + dist * dist) / (2 * dist)
    h = np.sqrt(max(0.0, a * a - x * x))
    p = knee_hint - hip
    p = p - u * p.dot(u)
    p = _unit(p) if np.linalg.norm(p) > 1e-6 else np.array([0.0, -1.0, 0.0])
    return hip + u * x + p * h, hip + u * dist


def rebuild(W, rest, L):
    """W: 関節名→推定位置（モデル軸）。rest: 静止姿勢の関節。L: 骨長。区間の向きだけを使って骨長どおりに組み直す。"""
    J = {}
    hip_c = (W['hip.L'] + W['hip.R']) / 2
    sh_c = (W['shoulder.L'] + W['shoulder.R']) / 2
    rest_hip_c = (rest['hip.L'] + rest['hip.R']) / 2
    J['hips'] = rest_hip_c.copy()
    across = _unit(W['hip.L'] - W['hip.R'])
    for s in 'LR':
        J[f'hip.{s}'] = J['hips'] + across * L['hipw'] / 2 * (1 if s == 'L' else -1)
    up = _unit(sh_c - hip_c)
    J['chest'] = J['hips'] + up * L['torso']
    J['neck'] = J['chest']
    sh_across = _unit(W['shoulder.L'] - W['shoulder.R'])
    for s in 'LR':
        J[f'shoulder.{s}'] = J['chest'] + L['sh_off'] * up + sh_across * L['shw'] / 2 * (1 if s == 'L' else -1)
    # 頭: 耳の奥行きは推定が不安定（カメラ側へ寄る傾向を確認）なので、体幹に対する前後成分は使わず左右の傾きだけを使う
    ear_c = (W['ear.L'] + W['ear.R']) / 2
    e = ear_c - sh_c
    up_rest = _unit(rest['head_top'] - rest['chest'])
    hd = up * max(e.dot(up), 1e-3) + sh_across * e.dot(sh_across)
    J['head_top'] = J['chest'] + _unit(_unit(hd) + (up_rest - np.array([0, 0, 1.0]))) * L['head']
    for s in 'LR':
        J[f'elbow.{s}'] = J[f'shoulder.{s}'] + _unit(W[f'elbow.{s}'] - W[f'shoulder.{s}']) * L[f'upper.{s}']
        J[f'wrist.{s}'] = J[f'elbow.{s}'] + _unit(W[f'wrist.{s}'] - W[f'elbow.{s}']) * L[f'fore.{s}']
        J[f'knee.{s}'] = J[f'hip.{s}'] + _unit(W[f'knee.{s}'] - W[f'hip.{s}']) * L[f'thigh.{s}']
        J[f'ankle.{s}'] = J[f'knee.{s}'] + _unit(W[f'ankle.{s}'] - W[f'knee.{s}']) * L[f'shin.{s}']
        # 足: かかと→つま先の向きを使い、静止時の足首→つま先の下向き角を保つ（つま先立ちに見えないように）
        f = W[f'toe.{s}'] - W[f'heel.{s}']
        r = rest[f'toe.{s}'] - rest[f'ankle.{s}']
        theta = np.arctan2(r[2], np.linalg.norm(r[:2]))
        fh = f.copy(); fh[2] = 0
        fh = _unit(fh) if np.linalg.norm(fh) > 1e-6 else np.array([0, -1.0, 0])
        phi = np.clip(np.arctan2(f[2], np.linalg.norm(f[:2])), -0.12, 0.6)
        ang = phi + theta
        J[f'toe.{s}'] = J[f'ankle.{s}'] + (fh * np.cos(ang) + np.array([0, 0, np.sin(ang)])) * L[f'foot.{s}']
    return J


def lengths(rest):
    n = np.linalg.norm
    hip_c = (rest['hip.L'] + rest['hip.R']) / 2
    sh_c = (rest['shoulder.L'] + rest['shoulder.R']) / 2
    L = {'hipw': n(rest['hip.L'] - rest['hip.R']), 'shw': n(rest['shoulder.L'] - rest['shoulder.R']),
         'torso': n(rest['chest'] - hip_c), 'sh_off': (sh_c - rest['chest'])[2], 'head': n(rest['head_top'] - rest['chest'])}
    for s in 'LR':
        L[f'upper.{s}'] = n(rest[f'elbow.{s}'] - rest[f'shoulder.{s}'])
        L[f'fore.{s}'] = n(rest[f'wrist.{s}'] - rest[f'elbow.{s}'])
        L[f'thigh.{s}'] = n(rest[f'knee.{s}'] - rest[f'hip.{s}'])
        L[f'shin.{s}'] = n(rest[f'ankle.{s}'] - rest[f'knee.{s}'])
        L[f'foot.{s}'] = n(rest[f'toe.{s}'] - rest[f'ankle.{s}'])
    return L


def hip_height_from_2d(frames, out, L, fps, qc=None, max_drop=0.30):
    """腰の高さを 2D 画像の縦の距離から推定し、3D の腰が高すぎるときは膝を曲げて下げる（足首の位置は保つ）。

    単眼 3D（MediaPipe world）は、背面から見た構えで膝の曲がり（奥行き方向）を浅く見積もることがある
    （28.2〜33.6 秒の比較で確認）。カメラは腰の高さ付近で水平に近いので、画像の縦の距離は奥行きの影響が小さい。
    倍率は同じフレームの胴体の縦の長さ（3D の胴の長さ / 画像の胴の縦の長さ）から求め、時間方向に平滑化する。
    """
    T = len(out)
    est = np.full(T, np.nan)
    for t, f in enumerate(frames):
        if f.get('missing'):
            continue
        im = np.asarray(f['image'])
        h = f.get('size', [1, 1])[1]
        torso_px = abs((im[11, 1] + im[12, 1]) / 2 - (im[23, 1] + im[24, 1]) / 2) * h
        if torso_px < 1e-3:
            continue
        k = L['torso'] / torso_px
        legs = [((im[27, 1] - im[23, 1]) * h, im[27, 3]), ((im[28, 1] - im[24, 1]) * h, im[28, 3])]
        # 見えている方の脚（可視度の高い方）を主に使う
        w = np.array([max(0.05, v) for _, v in legs])
        est[t] = float(np.dot([d for d, _ in legs], w) / w.sum()) * k
    ok = ~np.isnan(est)
    if ok.sum() < 3:
        return
    idx = np.arange(T)
    est = np.interp(idx, idx[ok], est[ok])
    est = one_euro(est[:, None].repeat(3, 1), np.ones(T), fps, min_cutoff=0.8, beta=0.2)[:, 0]
    # 3D の胴（首の付け根〜股関節）と画像の胴（肩〜MediaPipe の腰点）は測る点が違うので、
    # 冒頭の直立（最初の 1 秒）で「3D の腰の高さ / 画像からの推定」をそろえる
    cur0 = np.array([(J['hip.L'][2] + J['hip.R'][2]) / 2 - (J['ankle.L'][2] + J['ankle.R'][2]) / 2 for J in out])
    n0 = max(3, min(T, int(round(fps))))
    calib = float(np.median(cur0[:n0] / np.maximum(est[:n0], 1e-6)))
    est = est * calib
    if qc is not None:
        qc['hip_height_2d_calibration'] = round(calib, 3)
    drops = []
    for t, J in enumerate(out):
        cur = (J['hip.L'][2] + J['hip.R'][2]) / 2 - (J['ankle.L'][2] + J['ankle.R'][2]) / 2
        d = float(np.clip(cur - est[t], 0, max_drop))
        drops.append(d)
        if d < 0.015:
            continue
        ank = {s: J[f'ankle.{s}'].copy() for s in 'LR'}
        toe = {s: J[f'toe.{s}'].copy() for s in 'LR'}
        for k2 in J:
            J[k2] = J[k2] - np.array([0, 0, d])
        for s in 'LR':
            k_, a_ = two_bone_ik(J[f'hip.{s}'], ank[s], J[f'knee.{s}'] + np.array([0, -0.05, 0]), L[f'thigh.{s}'], L[f'shin.{s}'])
            J[f'knee.{s}'], J[f'ankle.{s}'], J[f'toe.{s}'] = k_, a_, toe[s] + (a_ - ank[s])
    if qc is not None:
        qc['hip_drop_from_2d_m'] = {'mean': round(float(np.mean(drops)), 3), 'max': round(float(np.max(drops)), 3),
                                    'frames_lowered': int(np.sum(np.array(drops) >= 0.015))}


def ground(J, ankle_h):
    """低い方の足首が床（静止時の足首の高さ）に来るように全体を上下させる"""
    dz = ankle_h - min(J['ankle.L'][2], J['ankle.R'][2])
    for k in J:
        J[k] = J[k] + np.array([0, 0, dz])
    return J


def process(frames, rest, fps=30.0, smooth=True, foot_lock=True, lock_speed=0.25, lock_height=0.03, qc=None, hip_from_2d=True):
    """frames: [{'world': 33x4}] → [J]（モデル座標、骨長固定、接地・足固定済み）。欠落フレームは前後で補間。

    qc に dict を渡すと、左右の取り違え・前後反転の修正を先に行い、その記録を入れる（motion_qc.py）。
    """
    # 入力の実際の時刻間隔から fps を決める（5 fps の間引きデータを 30 fps として平滑化・足の速度を計算しないように）
    times = [f.get('time') for f in frames]
    if len(frames) > 2 and all(t is not None for t in times):
        fps = 1.0 / float(np.median(np.diff(times)))
    if qc is not None:
        qc['input_fps'] = round(fps, 3)
    if qc is not None and len(frames) > 1:
        import copy
        import motion_qc
        frames = copy.deepcopy(frames)
        if all('image' in f for f in frames if not f.get('missing')):
            qc['lr_swaps_fixed'] = motion_qc.fix_lr_swaps(frames)
        qc['depth_flips_fixed'] = motion_qc.fix_depth_flips(frames, fps)
    rest = {k: np.asarray(v, dtype=float) for k, v in rest.items()}
    L = lengths(rest)
    T = len(frames)
    names = list(MP)
    P = np.full((T, len(names), 3), np.nan)
    V = np.zeros((T, len(names)))
    for t, f in enumerate(frames):
        if f.get('missing'):
            continue
        w = np.asarray(f['world'], dtype=float)
        m = to_model_axes(w[:, :3])
        for j, nm in enumerate(names):
            P[t, j] = m[MP[nm]]
            V[t, j] = w[MP[nm], 3]
    ok = ~np.isnan(P[:, 0, 0])
    if not ok.any():
        raise ValueError('no landmarks')
    idx = np.arange(T)
    for j in range(len(names)):
        for c in range(3):
            P[:, j, c] = np.interp(idx, idx[ok], P[ok, j, c])
    if smooth and T > 2:
        for j in range(len(names)):
            P[:, j] = one_euro(P[:, j], V[:, j], fps)
    out = [ground(rebuild({nm: P[t, j] for j, nm in enumerate(names)}, rest, L), rest['ankle.L'][2]) for t in range(T)]
    if hip_from_2d and all('image' in f for f in frames if not f.get('missing')):
        hip_height_from_2d(frames, out, L, fps, qc)
    # 腰の水平移動: 推定 world は腰中心のため、支持脚の足首を固定して腰を動かす
    contact = {s: np.zeros(T, dtype=bool) for s in 'LR'}
    if foot_lock and T > 2:
        ank_h = rest['ankle.L'][2]
        offset = np.zeros(3)
        anchor = {}
        for t in range(T):
            J = out[t]
            for k in J:
                J[k] = J[k] + offset
            for s in 'LR':
                a = J[f'ankle.{s}']
                prev = out[t - 1][f'ankle.{s}'] if t else a
                speed = np.linalg.norm((a - prev)[:2]) * fps
                contact[s][t] = (a[2] - ank_h) < lock_height and speed < lock_speed
            # 両足とも接地していなければ固定なし。片足以上が接地していれば、その足（低い方）を前フレームの位置に保つ
            sup = [s for s in 'LR' if contact[s][t]]
            if sup and t:
                s = min(sup, key=lambda q: J[f'ankle.{q}'][2])
                if s in anchor:
                    d = anchor[s] - J[f'ankle.{s}']
                    d[2] = 0
                    offset = offset + d
                    for k in J:
                        J[k] = J[k] + d
                anchor = {q: anchor.get(q, J[f'ankle.{q}'].copy()) for q in sup}
                # もう一方の接地足は IK で位置を保つ
                for q in sup:
                    if q != s and q in anchor:
                        tgt = anchor[q].copy()
                        tgt[2] = J[f'ankle.{q}'][2]
                        k2, a2 = two_bone_ik(J[f'hip.{q}'], tgt, J[f'knee.{q}'], L[f'thigh.{q}'], L[f'shin.{q}'])
                        dt = a2 - J[f'ankle.{q}']
                        J[f'knee.{q}'], J[f'ankle.{q}'] = k2, a2
                        J[f'toe.{q}'] = J[f'toe.{q}'] + dt
            else:
                anchor = {q: J[f'ankle.{q}'].copy() for q in sup}
    if qc is not None:
        import motion_qc
        qc['jumps'] = motion_qc.detect_jumps(out, fps)
    return out, contact
