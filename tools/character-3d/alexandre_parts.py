"""ALEXANDRE の衣装・髪（numpy のみ）。参照: alexandre.mp4（回転動画、ID 1JR5EW3X…）と提供静止画 3 枚。

観察した特徴（参照で確認できたもの）:
  髪   銀〜薄紫の長髪。前髪を後ろへ流して頭頂に量感、顔の両脇に胸まで届く毛束、後頭部上で一部を結ぶ（ハーフアップ）、
       残りは背中の中ほど（腰の上）まで真っ直ぐ垂れる
  コート 黒い革のロングコート。ふくらはぎの中ほどまでの丈、立ち襟（高く、上に開く）、広い襟（ラペル）、前を開けて着る、
       背中の中心に深いスリット、裏地は赤、腰の両脇から細い革紐が垂れる、袖口にベルト付きのカフ
  中   黒いベスト、白いシャツ（襟元を開ける）、ベルト（銀の留め金）、黒いズボン
  靴   膝下までの乗馬ブーツ（濃い赤茶）、足先は黒い革靴の形
  手   黒い革手袋
推定で補った部分: 髪の本数・毛束の幅、コートの布の厚み、ブーツのかかとの高さ、背面の細部。
"""
import math

import numpy as np

import garments as g


def _surface_y(V, mask, x, z, side, r=0.03):
    """mask の頂点のうち (x, z) 近傍で最も前（side=-1）/後ろ（+1）の y"""
    P = V[mask]
    d = (P[:, 0] - x) ** 2 + (P[:, 2] - z) ** 2
    near = P[d < r * r]
    if not len(near):
        near = P[np.argsort(d)[:20]]
    return near[:, 1].max() if side > 0 else near[:, 1].min()


def ribbon(path, widths, normal_hint, twist=0.0):
    """中心線 path（N×3）に沿う平たい帯（髪の毛束・革紐）。幅方向は進行方向と normal_hint の外積"""
    path = np.asarray(path, float)
    N = len(path)
    verts, faces = [], []
    for i in range(N):
        t = path[min(i + 1, N - 1)] - path[max(i - 1, 0)]
        t /= np.linalg.norm(t) + 1e-12
        h = np.asarray(normal_hint, float)
        w = np.cross(t, h)
        if np.linalg.norm(w) < 1e-6:
            w = np.cross(t, [1.0, 0, 0])
        w /= np.linalg.norm(w)
        if twist:
            a = twist * i / max(1, N - 1)
            w = w * math.cos(a) + np.cross(t, w) * math.sin(a)
        verts.append(path[i] - w * widths[i] / 2)
        verts.append(path[i] + w * widths[i] / 2)
    for i in range(N - 1):
        faces.append([2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2])
    return np.array(verts), faces


def merge(parts):
    V, F, tags = [], [], []
    for k, (v, f) in enumerate(parts):
        b = len(V)
        V.extend(np.asarray(v).tolist())
        F.extend([[b + i for i in q] for q in f])
        tags.extend([k] * len(v))
    return np.array(V), F, np.array(tags)


def long_hair(V, F, reg, bones, *, length_z=None, n_back=26, seed=5):
    """頭の土台（後ろへ流した形）＋背中へ垂れる毛束＋顔の両脇の毛束＋ハーフアップの結び目。

    返り値: (頭の土台の頂点, 面, 分け目の面), (毛束の頂点, 面, 各頂点の「根元からの距離比」), 結び目の頂点・面
    """
    rng = np.random.default_rng(seed)
    lm = g.landmarks(bones)
    head = np.asarray(bones['head']['head_b'])
    hv = V[[i for i in range(len(V)) if reg[i] == 'head']]
    top = hv[:, 2].max()
    h0 = top - head[2]
    cx, cy = head[0], hv[:, 1].mean()
    # 頭の土台: 額は出す（後ろへ流す）、こめかみ・耳の上は覆う、頭頂に量感
    cap_v, cap_f, part = g.hair_shell(V, F, reg, bones, thickness=0.018, front=0.66, temple=0.30, nape=-0.06)
    crown = np.clip(((cap_v[:, 2] - head[2]) / h0 - 0.55) / 0.45, 0, 1) * np.clip((cy + 0.03 - cap_v[:, 1]) / 0.12, 0, 1)
    d = cap_v[:, :2] - [cx, cy]
    cap_v = cap_v.copy()
    cap_v[:, 2] += 0.022 * crown                    # 前頭部〜頭頂の盛り上がり（前髪を後ろへ流した量感）
    cap_v[:, :2] += d / (np.linalg.norm(d, axis=1, keepdims=True) + 1e-9) * (0.006 * crown)[:, None]
    z_end = length_z if length_z is not None else lm['waist_z'] - 0.04     # 腰の高さまで（背面の参照）
    mv, mf = hair_mass(V, reg, bones, z_end=z_end)
    lv, lf = face_locks(V, reg, bones)
    sv, sf, tags = merge([(mv, mf), (lv, lf)])
    srel = np.zeros(len(sv))
    # ハーフアップの結び目（後頭部の上、頭頂から少し下）
    p_tie, nrm = g._head_surface(V, reg, head[2] + h0 * 0.72, math.pi, np.array([cx, cy, head[2]]))
    tv, tf = g.ellipsoid(p_tie + np.array([0, 0.018, 0]), (0.018, 0.012, 0.014), nu=16, nv=10)
    return (cap_v, cap_f, part), (sv, sf, srel), (tv, tf)


def stand_collar(V, reg, bones, *, height=0.10, flare=0.03, gap=1.1, bins=48):
    """立ち襟: 首の付け根から高く立ち上がり、上ほど外へ開く。前は開いている"""
    lm = g.landmarks(bones)
    cx, cy = lm['center_xy']
    neck = V[np.array([r == 'neck' for r in reg])]
    zb = lm['neck_z'] - 0.02
    ring = neck[np.abs(neck[:, 2] - (zb + 0.02)) < 0.02]
    prof = g.ring_profile(ring, (cx, cy), zb, bins=bins, pad=0.022)
    verts, faces = [], []
    rows = 6
    W = bins + 1
    for r in range(rows + 1):
        t = r / rows
        for k in range(W):
            a = -math.pi / 2 + gap / 2 + k / bins * (2 * math.pi - gap)
            kk = int(round((a + math.pi) / (2 * math.pi) * bins)) % bins
            back = 0.5 + 0.5 * math.sin(a)                 # 後ろほど高い
            rad = prof[kk] + flare * t ** 1.4
            verts.append((cx + math.cos(a) * rad, cy + math.sin(a) * rad, zb + height * (0.65 + 0.35 * back) * t))
    for r in range(rows):
        for k in range(bins):
            faces.append([r * W + k, r * W + k + 1, (r + 1) * W + k + 1, (r + 1) * W + k])
    return np.array(verts), faces


def lapels(coat_V, bones, *, width=0.085, z_top=None, z_bot=None):
    """広い襟（ラペル）: 前の打ち合わせの縁に沿って胸の上に折り返した三角形の面"""
    lm = g.landmarks(bones)
    cx, cy = lm['center_xy']
    z_top = z_top if z_top is not None else lm['neck_z'] - 0.03
    z_bot = z_bot if z_bot is not None else lm['waist_z'] + 0.06
    parts = []
    for side in (1, -1):
        pts_in, pts_out = [], []
        for t in np.linspace(0, 1, 10):
            z = z_top + (z_bot - z_top) * t
            sel = coat_V[(np.abs(coat_V[:, 2] - z) < 0.012) & ((coat_V[:, 0] - cx) * side > 0) & (coat_V[:, 1] < cy)]
            if not len(sel):
                continue
            # 開きの縁 = 前面で中心に最も近い点
            e = sel[np.argmin(np.abs(sel[:, 0] - cx))]
            w = width * (1 - t) ** 0.8 + 0.008
            pts_in.append(e + np.array([0, -0.006, 0]))
            pts_out.append(e + np.array([side * w, -0.012 - 0.01 * (1 - t), 0.01 * (1 - t)]))
        n = len(pts_in)
        v = np.array(pts_in + pts_out)
        f = [[i, i + 1, n + i + 1, n + i] if side > 0 else [i, n + i, n + i + 1, i + 1] for i in range(n - 1)]
        parts.append((v, f))
    return merge(parts)[:2]


def vented_skirt(coat_V, bones, *, below_knee=0.20, flare=0.10, rows=18, bins=40, front_gap=0.95, vent=0.28, vent_from=0.15):
    """腰から下の裾（左右 2 枚）。前は開き、背中の中心に深いスリット。info: (高さ比 t, 左右 side)"""
    lm = g.landmarks(bones)
    cx, cy = lm['center_xy']
    z0 = lm['crotch_z'] + 0.16
    knee = min(np.asarray(bones['lowerleg01.L']['head_b'])[2], np.asarray(bones['lowerleg01.R']['head_b'])[2])
    z1 = knee - below_knee
    sel = coat_V[(np.abs(coat_V[:, 2] - z0) < 0.03) & (np.abs(coat_V[:, 0] - cx) < 0.25)]
    prof = g.ring_profile(sel, (cx, cy), z0, bins=96, pad=0.006)
    parts, infos = [], []
    for side in (1, -1):
        verts, info = [], []
        for r in range(rows + 1):
            t = r / rows
            z = z0 + (z1 - z0) * t
            gf = front_gap * (0.35 + 0.65 * t)
            gv = vent * np.clip((t - vent_from) / (1 - vent_from), 0, 1) ** 0.8
            if side > 0:
                a0, a1 = -math.pi / 2 + gf / 2, math.pi / 2 - gv / 2
            else:
                a0, a1 = math.pi / 2 + gv / 2, 3 * math.pi / 2 - gf / 2
            for k in range(bins + 1):
                a = a0 + (a1 - a0) * k / bins
                kk = int(round(((a + math.pi) % (2 * math.pi)) / (2 * math.pi) * 96)) % 96
                rad = prof[kk] + flare * t ** 1.2 + 0.01 * t
                verts.append((cx + math.cos(a) * rad, cy + math.sin(a) * rad * (1 + 0.18 * t), z))
                info.append((t, side))
        W = bins + 1
        # 角度は両側とも反時計回りに増えるので、面の向きは左右同じ（外向き）
        f = [[r * W + k, (r + 1) * W + k, (r + 1) * W + k + 1, r * W + k + 1] for r in range(rows) for k in range(bins)]
        v = g.smooth(np.array(verts), f, iters=3, lam=0.3, pin=np.array([i < W for i in range(len(verts))]))
        parts.append((v, f))
        infos.extend(info)   # 左右の裾はそれぞれ同じ側の脚に追従（背中のスリットで分かれている）
    V, F, _ = merge(parts)
    return V, F, infos


def straps(bones, *, n=2):
    """腰の両脇から垂れる細い革紐（中心線と幅）"""
    lm = g.landmarks(bones)
    cx, cy = lm['center_xy']
    hipw = abs(np.asarray(bones['upperleg01.L']['head_b'])[0] - np.asarray(bones['upperleg01.R']['head_b'])[0])
    knee = np.asarray(bones['lowerleg01.L']['head_b'])[2]
    parts, info = [], []
    for side in (1, -1):
        for j in range(n):
            x0 = cx + side * (hipw / 2 + 0.085 + 0.012 * j)
            pts = [np.array([x0 + side * 0.03 * t * t, cy - 0.02 + 0.03 * j + 0.02 * t, lm['waist_z'] + 0.02 - (lm['waist_z'] - knee + 0.05 + 0.06 * j) * t])
                   for t in np.linspace(0, 1, 10)]
            v, f = ribbon(pts, [0.03] * 10, [1, 0, 0])
            parts.append((v, f))
            info.extend([(t, side) for t in np.repeat(np.linspace(0, 1, 10), 2)])
    V, F, _ = merge(parts)
    return V, F, info


def cuffs(bones, sleeve_V, *, at=0.86, height=0.06):
    """袖口のカフ（袖より一回り太い輪）"""
    lm = g.landmarks(bones)
    parts = []
    for s in 'LR':
        e, w = lm[f'elbow.{s}'], lm[f'wrist.{s}']
        axis = (w - e) / np.linalg.norm(w - e)
        c = e + (w - e) * at
        sel = sleeve_V[np.abs((sleeve_V - c) @ axis) < 0.02]
        r = np.median(np.linalg.norm((sel - c) - np.outer((sel - c) @ axis, axis), axis=1)) + 0.006 if len(sel) else 0.05
        path = [c - axis * height / 2, c + axis * height / 2]
        v, f = g.tube(np.array(path), [r, r * 1.05], segments=20)
        parts.append((v, f))
    return merge(parts)[:2]


def boots(V, F, reg, bones, *, top_below_knee=0.04, ease=0.016, toe_smooth=120):
    """膝下までのブーツ。脚の表面を複製して膨らませ、足先は指の凹凸を消して靴の形にする。

    返り値: 頂点, 面, 各面が靴部分（足首より下）かどうか
    """
    knee = min(np.asarray(bones['lowerleg01.L']['head_b'])[2], np.asarray(bones['lowerleg01.R']['head_b'])[2])
    ankle0 = min(np.asarray(bones['foot.L']['head_b'])[2], np.asarray(bones['foot.R']['head_b'])[2])
    keep = np.array([r == 'shin' and ankle0 - 0.01 < V[i, 2] < knee - top_below_knee for i, r in enumerate(reg)])
    Vs, Fs, used = g.submesh(V, F, keep)
    N = g.vertex_normals(Vs, Fs)
    rs = reg[used]
    ankle = min(np.asarray(bones['foot.L']['head_b'])[2], np.asarray(bones['foot.R']['head_b'])[2])
    foot = rs == 'foot'
    off = np.where(foot, ease + 0.004, ease + 0.004 * np.clip((Vs[:, 2] - ankle) / 0.3, 0, 1))
    Vo = Vs + N * off[:, None]
    # 指を消す: 足の部分だけ強く平滑化し、足裏は床に
    pin = ~foot
    Vo = g.smooth(Vo, Fs, iters=toe_smooth, lam=0.5, pin=pin)
    # 指の間の凹みを埋める: 足の部分は、平滑化前の位置より内側に入らないよう外側へ戻す
    inward = np.einsum('ij,ij->i', Vo - (Vs + N * off[:, None]), N)
    Vo[foot] -= (N[foot] * np.minimum(0, inward[foot])[:, None])
    Vo[:, 2] = np.maximum(Vo[:, 2], 0.0)
    N2 = g.vertex_normals(Vo, Fs)
    gap = np.einsum('ij,ij->i', Vo - Vs, N2)
    Vo += N2 * np.maximum(0, 0.006 - gap)[:, None]
    Vo = g.tidy_edges(Vo, Fs, iters=10)
    shoe = [bool(np.mean(Vo[f, 2]) < ankle + 0.03) for f in Fs]
    return Vo, Fs, used, shoe


def gloves(V, F, reg, bones, *, ease=0.0035, cuff=0.05):
    """手袋: 手と手首の上（袖口の中まで）の表面を少し膨らませた殻"""
    lm = g.landmarks(bones)
    keep = np.zeros(len(V), dtype=bool)
    for i, r in enumerate(reg):
        if r == 'hand':
            keep[i] = True
        elif r == 'forearm':
            s = 'L' if V[i, 0] > 0 else 'R'
            e, w = lm[f'elbow.{s}'], lm[f'wrist.{s}']
            keep[i] = np.dot(V[i] - w, (w - e) / np.linalg.norm(w - e)) > -cuff
    Vs, Fs, used = g.submesh(V, F, keep)
    N = g.vertex_normals(Vs, Fs)
    Vo = g.smooth(Vs + N * ease, Fs, iters=2, lam=0.3, pin=g.boundary_vertices(Fs, len(Vs)))
    return Vo, Fs, used


def vest(V, F, reg, bones, *, ease=0.007, v_depth=0.11):
    """ベスト（胴だけ）。襟元は V に開けて白いシャツ（体の表面の色）を見せる"""
    lm = g.landmarks(bones)
    cx, cy = lm['center_xy']
    keep = np.array([r == 'torso' and lm['crotch_z'] + 0.08 < V[i, 2] for i, r in enumerate(reg)])
    v_top = lm['neck_z'] - 0.01
    for i in np.nonzero(keep)[0]:
        if V[i, 1] < cy - 0.02 and V[i, 2] > v_top - v_depth and abs(V[i, 0] - cx) < (V[i, 2] - (v_top - v_depth)) * 0.5 + 0.01:
            keep[i] = False
        if V[i, 2] > v_top - 0.02:
            keep[i] = False
    Vs, Fs, used = g.submesh(V, F, keep)
    N = g.vertex_normals(Vs, Fs)
    Vo = g.smooth(Vs + N * ease, Fs, iters=6, lam=0.4, pin=g.boundary_vertices(Fs, len(Vs)))
    return g.tidy_edges(Vo, Fs, iters=10), Fs, used


def hair_sheet(V, reg, bones, *, z_top_frac=0.55, z_end=None, cols=24, rows=26):
    """背中へ垂れる髪の主な量（一枚の連続した面。毛束の帯はこの上に重ねて質感だけを足す）"""
    lm = g.landmarks(bones)
    head = np.asarray(bones['head']['head_b'])
    hv = V[[i for i in range(len(V)) if reg[i] == 'head']]
    top = hv[:, 2].max()
    h0 = top - head[2]
    cx = head[0]
    z0 = head[2] + h0 * z_top_frac
    z1 = z_end if z_end is not None else lm['waist_z'] + 0.02
    torso = np.array([r in ('torso', 'shoulder', 'neck', 'head') for r in reg])
    verts = []
    for r in range(rows + 1):
        t = r / rows
        z = z0 + (z1 - z0) * t
        # 幅: 頭の幅 → 肩でやや広がり → 毛先で細る
        w = 0.08 + 0.085 * math.sin(min(1, t * 1.8) * math.pi / 2) - 0.04 * max(0, t - 0.65) / 0.35   # 肩甲骨の幅まで広がる（背面の参照）
        for c in range(cols + 1):
            u = c / cols * 2 - 1
            x = cx + u * w
            yb = _surface_y(V, torso, x, z, +1, r=0.035)
            bulge = 0.018 * (1 - u * u) + 0.006
            verts.append((x, yb + 0.045 + bulge * (0.6 + 0.4 * (1 - t)), z))   # コート（体から約 3 cm）の外側
    W = cols + 1
    faces = [[r * W + c, r * W + c + 1, (r + 1) * W + c + 1, (r + 1) * W + c] for r in range(rows) for c in range(cols)]
    Vv = g.smooth(np.array(verts), faces, iters=4, lam=0.4)
    return Vv, faces


def shoes(V, reg, bones, *, ease=0.010, slices=16):
    """足先の靴: 足の頂点の断面（幅・高さ）から、指の凹凸のない靴の形を断面の積み重ねで作る（閉じた形）"""
    parts = []
    for s in 'LR':
        sign = 1 if s == 'L' else -1
        ankle = np.asarray(bones[f'foot.{s}']['head_b'])
        toe = np.asarray(bones[f'toe1-1.{s}']['tail_b'] if 'tail_b' in bones[f'toe1-1.{s}'] else bones[f'toe1-1.{s}']['head_b'])
        P = V[[i for i in range(len(V)) if reg[i] == 'foot' and (V[i, 0] - 0) * sign > 0]]
        u = toe - ankle; u[2] = 0; u /= np.linalg.norm(u)
        w = np.array([-u[1], u[0], 0])
        proj = (P - ankle) @ u
        lo, hi = proj.min() - 0.006, proj.max() + 0.012
        rings = []
        for k in range(slices + 1):
            t = k / slices
            a = lo + (hi - lo) * t
            sel = P[np.abs(proj - a) < (hi - lo) / slices]
            if len(sel) < 3:
                sel = P[np.argsort(np.abs(proj - a))[:8]]
            half = np.abs((sel - ankle) @ w).max() + ease
            ctr_w = ((sel - ankle) @ w).mean()
            height = sel[:, 2].max() + ease
            tip = math.sin(min(1.0, t / 0.12) * math.pi / 2) * math.sin(min(1.0, (1 - t) / 0.18) * math.pi / 2) ** 0.6
            half *= 0.35 + 0.65 * tip
            height = max(0.025, height * (0.55 + 0.45 * tip))
            ring = []
            for j in range(20):
                th = 2 * math.pi * j / 20
                cx_, cz = math.cos(th), math.sin(th)
                # 底は平ら（靴底）、上は丸い
                z = (height / 2) * (1 + (np.sign(cz) * abs(cz) ** 0.7))
                z = max(0.0, z) if cz < 0 else z
                ring.append(ankle + u * a + w * (ctr_w + half * np.sign(cx_) * abs(cx_) ** 0.8) + np.array([0, 0, z - ankle[2]]))
            rings.append(ring)
        verts = [p for ring in rings for p in ring]
        faces = [[k * 20 + j, k * 20 + (j + 1) % 20, (k + 1) * 20 + (j + 1) % 20, (k + 1) * 20 + j] for k in range(slices) for j in range(20)]
        c0 = len(verts); verts.append(np.mean(rings[0], axis=0)); c1 = len(verts); verts.append(np.mean(rings[-1], axis=0))
        faces += [[c0, (j + 1) % 20, j] for j in range(20)] + [[c1, slices * 20 + j, slices * 20 + (j + 1) % 20] for j in range(20)]
        parts.append((np.array(verts), faces))
    return merge(parts)[:2]


def hair_mass(V, reg, bones, *, z_end=None, rows=30, cols=26, arc_top=1.85, offset=0.024):
    """後ろへ垂れる髪の量感を一続きの面で作る。

    上（耳の高さより上）は頭の周りの弧（後ろ中心 ±arc_top rad、耳の後ろまで）、首から下は背中に沿う平たい弧、
    その間は滑らかに移る。厚みは build 側の Solidify。
    """
    lm = g.landmarks(bones)
    head = np.asarray(bones['head']['head_b'])
    hv = V[[i for i in range(len(V)) if reg[i] == 'head']]
    top = hv[:, 2].max()
    h0 = top - head[2]
    cx, cy = head[0], hv[:, 1].mean()
    center = np.array([cx, cy, head[2]])
    torso = np.array([r in ('torso', 'shoulder', 'neck') for r in reg])
    z0 = head[2] + h0 * 0.62
    z_end = z_end if z_end is not None else lm['waist_z'] - 0.04
    z_neck = lm['neck_z'] - 0.03
    verts = []
    rng = np.random.default_rng(11)
    tips = [z_end - 0.07 * (1 - (c / cols * 2 - 1) ** 2) + rng.uniform(-0.015, 0.015) for c in range(cols + 1)]   # 中央が長く、毛先は不揃い
    for r in range(rows + 1):
        t = r / rows
        for c in range(cols + 1):
            u = c / cols * 2 - 1
            z = z0 + (tips[c] - z0) * t
            # 頭の周りの点
            a = math.pi + u * arc_top * (1 - 0.25 * max(0, (z0 - z) / (z0 - head[2] + 1e-6)))
            zh = max(z, head[2] + 0.01)
            p, nrm = g._head_surface(V, reg, zh, a if a <= math.pi else a - 2 * math.pi, center)
            off_h = offset * (0.35 + 0.65 * min(1.0, t * 4))      # 上端は頭の土台に沈めて段差を作らない
            ph = np.array([p[0] + nrm[0] * off_h, p[1] + nrm[1] * off_h, z])
            # 背中に沿う点（肩甲骨の幅まで広がる）
            tb = np.clip((z_neck - z) / max(1e-6, z_neck - z_end), 0, 1)
            w = 0.11 + 0.06 * math.sin(min(1, tb * 1.8) * math.pi / 2) - 0.05 * max(0, tb - 0.65) / 0.35
            x = cx + u * w
            yb = _surface_y(V, torso, x, z, +1, r=0.035) + 0.05 + 0.02 * (1 - u * u)
            pb = np.array([x, yb, z])
            k = np.clip((head[2] + 0.02 - z) / max(1e-6, head[2] + 0.02 - z_neck), 0, 1)     # 0: 頭 → 1: 背中
            k = k * k * (3 - 2 * k)
            verts.append(ph * (1 - k) + pb * k)
    W = cols + 1
    faces = [[r * W + c, r * W + c + 1, (r + 1) * W + c + 1, (r + 1) * W + c] for r in range(rows) for c in range(cols)]
    Vv = g.smooth(np.array(verts), faces, iters=6, lam=0.4, pin=np.array([i < W for i in range(len(verts))]))
    # 表面の毛筋: 縦の列に沿って細い筒を少し浮かせて重ねる（一枚板に見えないように）
    N = g.vertex_normals(Vv, faces)
    grooves = []
    for c in range(1, cols, 2):
        idx = [r * W + c for r in range(3, rows + 1)]
        path = Vv[idx] + N[idx] * 0.004
        grooves.append(g.tube(path, [0.0045 * (1 - 0.6 * k / len(idx)) for k in range(len(idx))], segments=6))
    gv, gf, _ = merge([(Vv, faces)] + grooves)
    return gv, gf


def face_locks(V, reg, bones, *, n=3, r0=0.0065):
    """顔の両脇の毛束（こめかみの横から、頬の外側を通って鎖骨の前へ）。顔の前には掛けない"""
    lm = g.landmarks(bones)
    head = np.asarray(bones['head']['head_b'])
    hv = V[[i for i in range(len(V)) if reg[i] == 'head']]
    h0 = hv[:, 2].max() - head[2]
    cx, cy = head[0], hv[:, 1].mean()
    center = np.array([cx, cy, head[2]])
    torso = np.array([r in ('torso', 'shoulder', 'neck') for r in reg])
    parts = []
    for side in (1, -1):
        for j in range(n):
            pts = []
            a = side * (1.45 + 0.12 * j)
            z_start = head[2] + h0 * (0.62 - 0.06 * j)
            z_stop = lm['neck_z'] - 0.16 - 0.05 * j
            for t in np.linspace(0, 1, 14):
                z = z_start + (z_stop - z_start) * t
                if z > head[2]:
                    p, nrm = g._head_surface(V, reg, z, a, center)
                    pts.append(np.array([p[0] + nrm[0] * 0.03, p[1] + nrm[1] * 0.03, z]))
                else:
                    x = pts[-1][0] if pts else cx + side * 0.08
                    x = x + (cx + side * (0.075 + 0.02 * j) - x) * 0.4
                    y = _surface_y(V, torso, x, z, -1) - 0.045
                    pts.append(np.array([x, y, z]))
            path = g.smooth(np.array(pts), [[i, i + 1] for i in range(len(pts) - 1)], iters=3, lam=0.4,
                            pin=np.array([i in (0, len(pts) - 1) for i in range(len(pts))]))
            parts.append(g.tube(path, [r0 * (1 - 0.5 * k / 13) for k in range(14)], segments=10))
    return merge(parts)[:2]


def swept_strands(cap_v, bones, *, n=9):
    """頭頂の上を額から後頭部の結び目へ流れる筋（前髪を後ろへ流した表情）"""
    head = np.asarray(bones['head']['head_b'])
    top = cap_v[:, 2].max()
    cx = head[0]
    parts = []
    for k in range(n):
        u = (k / (n - 1)) * 2 - 1
        pts = []
        for t in np.linspace(0, 1, 12):
            x = cx + u * 0.055 * (1 - 0.5 * t)
            # 帽子の表面の上（同じ x の頂点の中で、前から後ろへ）
            sel = cap_v[np.abs(cap_v[:, 0] - x) < 0.008]
            if not len(sel):
                continue
            ymin, ymax = sel[:, 1].min(), sel[:, 1].max()
            y = ymin + (ymax - ymin) * (0.15 + 0.6 * t)
            near = sel[np.abs(sel[:, 1] - y) < 0.01]
            z = (near[:, 2].max() if len(near) else top) + 0.004
            pts.append(np.array([x, y, z]))
        if len(pts) > 3:
            parts.append(g.tube(np.array(pts), [0.006] * len(pts), segments=8))
    return merge(parts)[:2]
