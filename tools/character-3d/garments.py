"""人体メッシュから衣装・髪の形状を作る（numpy のみ。Blender 非依存）。

道着・コートは「人体表面の一部を複製 → 法線方向へ膨らませる → 平滑化で体の細部を消す」方式。
人体と同じ位相の連続した面なので、人体のウェイトを転写すれば骨格どおりに変形する
（独立した円柱を関節に置く方式ではない）。帯・髪の房は断面の輪を積み重ねた連続メッシュ。
"""
import math
from collections import defaultdict

import numpy as np

REGIONS = {
    'torso': ('spine01', 'spine02', 'spine03', 'spine04', 'spine05', 'root'),
    'neck': ('neck01', 'neck02', 'neck03'),
    'head': ('head',),
    'shoulder': ('clavicle', 'shoulder01'),
    'upperarm': ('upperarm01', 'upperarm02'),
    'forearm': ('lowerarm01', 'lowerarm02'),
    'hand': ('wrist', 'metacarpal', 'finger'),
    'pelvis': ('pelvis',),
    'thigh': ('upperleg01', 'upperleg02'),
    'shin': ('lowerleg01', 'lowerleg02'),
    'foot': ('foot', 'toe'),
}


def region_of(bone):
    base = bone.split('.')[0]
    for r, names in REGIONS.items():
        if any(base == n or base.startswith(n) for n in names):
            return r
    return 'torso'


def dominant_regions(n, wts):
    best = np.zeros(n)
    reg = np.array(['torso'] * n, dtype=object)
    bone = np.array([''] * n, dtype=object)
    for b, d in wts.items():
        for i, w in d.items():
            if w > best[i]:
                best[i] = w
                reg[i] = region_of(b)
                bone[i] = b
    return reg, bone


def vertex_normals(V, F):
    N = np.zeros_like(V)
    for f in F:
        for k in range(1, len(f) - 1):
            a, b, c = V[f[0]], V[f[k]], V[f[k + 1]]
            n = np.cross(b - a, c - a)
            for i in (f[0], f[k], f[k + 1]):
                N[i] += n
    L = np.linalg.norm(N, axis=1, keepdims=True)
    return N / np.maximum(L, 1e-12)


def adjacency(F, n):
    adj = [set() for _ in range(n)]
    for f in F:
        for k in range(len(f)):
            a, b = f[k], f[(k + 1) % len(f)]
            adj[a].add(b); adj[b].add(a)
    return adj


def submesh(V, F, keep):
    faces = [f for f in F if all(keep[i] for i in f)]
    used = sorted({i for f in faces for i in f})
    remap = {o: k for k, o in enumerate(used)}
    return V[used].copy(), [[remap[i] for i in f] for f in faces], np.array(used)


def smooth(V, F, iters=8, lam=0.5, pin=None):
    adj = adjacency(F, len(V))
    V = V.copy()
    for _ in range(iters):
        avg = np.array([V[list(a)].mean(axis=0) if a else V[i] for i, a in enumerate(adj)])
        delta = lam * (avg - V)
        if pin is not None:
            delta[pin] = 0
        V += delta
    return V


def boundary_vertices(F, n):
    cnt = defaultdict(int)
    for f in F:
        for k in range(len(f)):
            e = tuple(sorted((f[k], f[(k + 1) % len(f)])))
            cnt[e] += 1
    b = np.zeros(n, dtype=bool)
    for (a, c), m in cnt.items():
        if m == 1:
            b[a] = b[c] = True
    return b


def boundary_edges(F):
    cnt = defaultdict(int)
    for f in F:
        for k in range(len(f)):
            cnt[tuple(sorted((f[k], f[(k + 1) % len(f)])))] += 1
    return [e for e, m in cnt.items() if m == 1]


def tidy_edges(V, F, iters=30, lam=0.5, relax=6):
    """袖口・裾・襟・生え際のギザギザを取る: 境界線に沿って平滑化 → 内側を整える"""
    nb = defaultdict(list)
    for a, c in boundary_edges(F):
        nb[a].append(c); nb[c].append(a)
    V = V.copy()
    idx = np.array(sorted(nb))
    loops = _loops(nb)
    before = [(V[l].mean(axis=0), np.linalg.norm(V[l] - V[l].mean(axis=0), axis=1).mean()) for l in loops]
    if len(idx):
        for _ in range(iters):
            avg = np.array([V[nb[i]].mean(axis=0) for i in idx])
            V[idx] += lam * (avg - V[idx])
        # 輪の平滑化は輪を縮めるので、元の大きさ（平均半径）に戻す（袖口・裾が絞られないように）
        for l, (c0, r0) in zip(loops, before):
            c1 = V[l].mean(axis=0)
            r1 = np.linalg.norm(V[l] - c1, axis=1).mean()
            if r1 > 1e-6 and len(l) > 6:
                V[l] = c1 + (V[l] - c1) * (r0 / r1)
    pin = np.zeros(len(V), dtype=bool); pin[idx] = True
    return smooth(V, F, iters=relax, lam=0.4, pin=pin)


def _loops(nb):
    seen, loops = set(), []
    for s0 in nb:
        if s0 in seen:
            continue
        loop, stack = [], [s0]
        while stack:
            v = stack.pop()
            if v in seen:
                continue
            seen.add(v); loop.append(v)
            stack.extend(nb[v])
        loops.append(np.array(loop))
    return loops


def landmarks(bones):
    g = lambda name, k='head_b': np.asarray(bones[name][k])
    lm = {
        'crotch_z': min(g('upperleg01.L')[2], g('upperleg01.R')[2]) - 0.06,
        'waist_z': g('spine04')[2] if 'spine04' in bones else g('spine03')[2],
        'neck_z': g('neck01')[2],
        'head_z': g('head')[2],
        'ankle_z': min(g('foot.L')[2], g('foot.R')[2]),
        'center_xy': (g('spine03')[:2] if 'spine03' in bones else g('neck01')[:2]),
    }
    for s in 'LR':
        lm[f'elbow.{s}'] = g(f'lowerarm01.{s}')
        lm[f'wrist.{s}'] = g(f'wrist.{s}')
    return lm


def gi_jacket(V, F, reg, bones, *, hem_below_crotch=0.18, sleeve=0.86, ease=0.022, coat=False):
    """道着の上衣（coat=True でロングコート: 裾を膝下まで・ゆとりを大きく）"""
    lm = landmarks(bones)
    n = len(V)
    keep = np.zeros(n, dtype=bool)
    hem_z = lm['crotch_z'] - hem_below_crotch
    for i in range(n):
        r = reg[i]
        z = V[i, 2]
        if r in ('torso', 'shoulder', 'upperarm'):
            keep[i] = True
        elif r == 'forearm':
            s = 'L' if V[i, 0] > 0 else 'R'
            e, w = lm[f'elbow.{s}'], lm[f'wrist.{s}']
            t = np.dot(V[i] - e, w - e) / max(1e-9, np.dot(w - e, w - e))
            keep[i] = t <= sleeve
        elif r in ('pelvis', 'thigh', 'shin'):
            keep[i] = z >= hem_z
        elif r == 'neck':
            keep[i] = z < lm['neck_z'] + 0.02
    # V字の襟（前面 = -y）
    cx, cy = lm['center_xy']
    v_top = lm['neck_z'] + 0.01
    # 襟元は浅い V（道着は襟が重なる。下に白い肌着を着ている想定で、深く開けない）
    v_depth = 0.11 if not coat else 0.07
    for i in range(n):
        if V[i, 1] < cy - 0.02 and V[i, 2] > v_top - v_depth:
            if abs(V[i, 0] - cx) < (V[i, 2] - (v_top - v_depth)) * 0.42 + 0.012:
                keep[i] = False
    Vs, Fs, used = submesh(V, F, keep)
    N = vertex_normals(Vs, Fs)
    r_sub = reg[used]
    off = np.full(len(Vs), ease)
    for k in range(len(Vs)):
        if r_sub[k] == 'forearm':
            off[k] += 0.016          # 袖口はゆったり
        elif r_sub[k] == 'upperarm':
            off[k] += 0.010
        elif r_sub[k] in ('pelvis', 'thigh', 'shin'):
            off[k] += 0.012 + (0.04 if coat else 0.0) * max(0.0, (lm['crotch_z'] - Vs[k, 2]) / 0.5)
    Vo = Vs + N * off[:, None]
    Vo = smooth(Vo, Fs, iters=10, lam=0.5, pin=boundary_vertices(Fs, len(Vs)))
    # 平滑化で縮んだ分を戻す（元の体表から最低 ease 離す）
    N2 = vertex_normals(Vo, Fs)
    gap = np.einsum('ij,ij->i', Vo - Vs, N2)
    Vo += N2 * np.maximum(0, ease * 0.8 - gap)[:, None]
    Vo = tidy_edges(Vo, Fs)
    return clamp_offset(Vo, Vs, Fs, 0.03 if not coat else 0.07), Fs, used


def clamp_offset(Vo, Vs, Fs, max_off, iters=3):
    """体表から離れすぎた頂点（股・お尻の谷で縁の整形に引っ張られたひれ状の突起）を戻してならす"""
    out = Vo.copy()
    for _ in range(iters):
        d = out - Vs
        n = np.linalg.norm(d, axis=1)
        bad = n > max_off
        if not bad.any():
            break
        out[bad] = Vs[bad] + d[bad] * (max_off / n[bad])[:, None]
        out = smooth(out, Fs, iters=2, lam=0.3, pin=~bad)
    d = out - Vs
    n = np.linalg.norm(d, axis=1)
    bad = n > max_off
    out[bad] = Vs[bad] + d[bad] * (max_off / n[bad])[:, None]
    print('clamp_offset: vertices pulled back', int(bad.sum()), 'max offset before %.3f' % float(np.linalg.norm(Vo - Vs, axis=1).max()))
    return out


def gi_pants(V, F, reg, bones, *, ease=0.016, flare=0.03, waist_up=0.03):
    lm = landmarks(bones)
    n = len(V)
    keep = np.zeros(n, dtype=bool)
    top = lm['waist_z'] + waist_up
    for i in range(n):
        r, z = reg[i], V[i, 2]
        if r in ('pelvis', 'thigh', 'shin') or (r == 'torso' and z < top):
            keep[i] = z > lm['ankle_z'] + 0.05
    Vs, Fs, used = submesh(V, F, keep)
    N = vertex_normals(Vs, Fs)
    t = np.clip((lm['crotch_z'] - Vs[:, 2]) / max(0.2, lm['crotch_z'] - lm['ankle_z']), 0, 1)
    off = ease + flare * t
    Vo = Vs + N * off[:, None]
    Vo = smooth(Vo, Fs, iters=8, lam=0.5, pin=boundary_vertices(Fs, len(Vs)))
    N2 = vertex_normals(Vo, Fs)
    gap = np.einsum('ij,ij->i', Vo - Vs, N2)
    Vo += N2 * np.maximum(0, ease * 0.8 - gap)[:, None]
    return tidy_edges(Vo, Fs), Fs, used


def ring_profile(points, center, z, bins=48, pad=0.006):
    """高さ z 付近の点群の、角度ごとの最大半径（凸包に近い輪郭）"""
    ang = np.arctan2(points[:, 1] - center[1], points[:, 0] - center[0])
    rad = np.hypot(points[:, 0] - center[0], points[:, 1] - center[1])
    out = np.zeros(bins)
    for k in range(bins):
        a0 = -math.pi + 2 * math.pi * k / bins
        m = np.abs((ang - a0 + math.pi) % (2 * math.pi) - math.pi) < (math.pi / bins) * 1.6
        out[k] = rad[m].max() if m.any() else 0
    # 欠けた角度は隣から補間
    for k in range(bins):
        if out[k] == 0:
            out[k] = max(out[(k - 1) % bins], out[(k + 1) % bins])
    return out + pad


def belt(jacket_V, bones, *, height=0.045, z=None, bins=48):
    lm = landmarks(bones)
    zc = z if z is not None else lm['crotch_z'] + 0.17
    cx, cy = lm['center_xy']
    # 胴体の断面だけを使う（A ポーズでは腕・手が帯の高さにある）
    sel = jacket_V[(np.abs(jacket_V[:, 2] - zc) < 0.025) & (np.abs(jacket_V[:, 0] - cx) < 0.2)]
    prof = ring_profile(sel, (cx, cy), zc, bins=bins, pad=0.007)
    verts, faces = [], []
    for row, dz in enumerate((-height / 2, height / 2)):
        for k in range(bins):
            a = -math.pi + 2 * math.pi * k / bins
            verts.append((cx + math.cos(a) * prof[k], cy + math.sin(a) * prof[k], zc + dz))
    for k in range(bins):
        k2 = (k + 1) % bins
        faces.append([k, k2, bins + k2, bins + k])
    # 結び目と垂れ（前面 = -y の方向）
    front = int(round((-math.pi / 2 + math.pi) / (2 * math.pi) * bins)) % bins
    fy = cy - prof[front] - 0.006
    def box(x0, x1, z0, z1, y0, y1, tilt=0.0):
        b = len(verts)
        for z in (z0, z1):
            for (x, y) in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
                verts.append((x + tilt * (zc - z), y, z))
        faces.extend([[b, b + 1, b + 2, b + 3], [b + 4, b + 7, b + 6, b + 5], [b, b + 4, b + 5, b + 1],
                      [b + 1, b + 5, b + 6, b + 2], [b + 2, b + 6, b + 7, b + 3], [b + 3, b + 7, b + 4, b]])
    box(cx - 0.035, cx + 0.035, zc - 0.03, zc + 0.03, fy - 0.022, fy)          # 結び目
    box(cx - 0.042, cx - 0.006, zc - 0.29, zc - 0.03, fy - 0.016, fy - 0.006, tilt=0.14)   # 垂れ（左）
    box(cx + 0.006, cx + 0.042, zc - 0.27, zc - 0.03, fy - 0.016, fy - 0.006, tilt=-0.12)  # 垂れ（右）
    return np.array(verts), faces


def tube(path, radii, segments=14):
    """中心線 path（N×3）と半径列から連続した筒（端は閉じる）"""
    path = np.asarray(path); N = len(path)
    verts, faces = [], []
    a_prev = None
    for i in range(N):
        t = path[min(i + 1, N - 1)] - path[max(i - 1, 0)]
        t /= np.linalg.norm(t)
        if a_prev is None:
            ref = np.array([1.0, 0, 0]) if abs(t[0]) < 0.9 else np.array([0, 1.0, 0])
            a = np.cross(t, ref)
        else:
            a = a_prev - np.dot(a_prev, t) * t   # 平行移動フレーム（ねじれない）
        a /= np.linalg.norm(a)
        a_prev = a
        b = np.cross(t, a)
        for k in range(segments):
            th = 2 * math.pi * k / segments
            verts.append(path[i] + radii[i] * (math.cos(th) * a + math.sin(th) * b))
    for i in range(N - 1):
        for k in range(segments):
            k2 = (k + 1) % segments
            faces.append([i * segments + k, i * segments + k2, (i + 1) * segments + k2, (i + 1) * segments + k])
    c0 = len(verts); verts.append(path[0]); c1 = len(verts); verts.append(path[-1])
    for k in range(segments):
        faces.append([c0, (k + 1) % segments, k])
        faces.append([c1, (N - 1) * segments + k, (N - 1) * segments + (k + 1) % segments])
    return np.array(verts), faces


def _ring_distance(F, n, seeds):
    adj = adjacency(F, n)
    d = np.full(n, 1e9)
    frontier = [int(i) for i in np.nonzero(seeds)[0]] if getattr(seeds, 'dtype', None) == bool else [int(i) for i in seeds]
    for i in frontier:
        d[i] = 0
    k = 0
    while frontier:
        k += 1
        nxt = []
        for i in frontier:
            for j in adj[i]:
                if d[j] > k:
                    d[j] = k
                    nxt.append(j)
        frontier = nxt
    return d


def hair_cap(V, F, reg, bones, *, thickness=0.016, fringe=False, long_back=0.0, part=False):
    """頭皮を覆う髪の土台。顔の前面は残す。"""
    head = np.asarray(bones['head']['head_b'])
    n = len(V)
    keep = np.zeros(n, dtype=bool)
    hv = V[[i for i in range(n) if reg[i] == 'head']]
    top = hv[:, 2].max()
    face_y = hv[:, 1].min()
    hairline_z = head[2] + (top - head[2]) * (0.45 if not fringe else 0.40)
    back_y = head[1] + 0.005
    for i in range(n):
        if reg[i] != 'head':
            continue
        x, y, z = V[i]
        front = y < back_y - 0.035
        if z > hairline_z or (not front and z > head[2] - 0.02 - long_back):
            # 顔の前面は髪で覆わない。耳は覆わず、耳の上を通って後ろへまとめる
            if front and z < hairline_z + 0.015 and abs(x - head[0]) < 0.06:
                continue
            if not front and z < head[2] + 0.035 and abs(x - head[0]) > 0.062 and y < head[1] + 0.03:
                continue
            keep[i] = True
    Vs, Fs, used = submesh(V, F, keep)
    N = vertex_normals(Vs, Fs)
    # 生え際は厚みを 0 へ細らせる（縁が段差にならないように）
    ring = _ring_distance(Fs, len(Vs), boundary_vertices(Fs, len(Vs)))
    taper = np.clip(ring / 4.0, 0.15, 1.0) ** 0.8
    Vo = Vs + N * (thickness * taper)[:, None]
    Vo = smooth(Vo, Fs, iters=6, lam=0.45, pin=boundary_vertices(Fs, len(Vs)))
    N2 = vertex_normals(Vo, Fs)
    gap = np.einsum('ij,ij->i', Vo - Vs, N2)
    Vo += N2 * np.maximum(0, thickness * 0.8 * taper - gap)[:, None]
    Vo = tidy_edges(Vo, Fs, iters=20)
    if part:
        Vo = center_part(Vo, Vs, head)
    return Vo, Fs, used, {'top': top, 'face_y': face_y}


def ponytail(bones, *, length=0.15, base_r=0.034, tip_r=0.02, bun=True):
    """後頭部で束ねた髪（観察: 後ろで一つに束ねている。房の長さ・太さは推定）"""
    head = np.asarray(bones['head']['head_b'])
    neck = np.asarray(bones['neck01']['head_b'])
    start = head + np.array([0, 0.09, 0.015])   # 後頭部の低い位置で束ねる（推定）
    pts, radii = [], []
    steps = 12
    for i in range(steps):
        t = i / (steps - 1)
        p = start + np.array([0, 0.03 * math.sin(t * math.pi) + 0.012 * t, -length * t])
        pts.append(p)
        r = base_r * (1 - t) + tip_r * t
        if bun and t < 0.25:
            r *= 1.0 + 0.18 * math.sin(t / 0.25 * math.pi)
        radii.append(r)
    return tube(pts, radii, segments=16)


def coat_skirt(jacket_V, bones, *, below_knee=0.12, flare=0.16, bins=64, rows=16, opening=0.30):
    """ロングコートの腰から下（脚ごとの筒ではなく一枚の裾）。前は打ち合わせが開く（裏地が見える）。

    返り値: 頂点, 面, 各頂点の (高さ比 t, x 方向の左右比 side)。重みは build 側で付ける。
    """
    lm = landmarks(bones)
    cx, cy = lm['center_xy']
    z0 = lm['crotch_z'] + 0.15
    knee = min(np.asarray(bones['lowerleg01.L']['head_b'])[2], np.asarray(bones['lowerleg01.R']['head_b'])[2])
    z1 = knee - below_knee
    sel = jacket_V[(np.abs(jacket_V[:, 2] - z0) < 0.03) & (np.abs(jacket_V[:, 0] - cx) < 0.24)]
    prof = ring_profile(sel, (cx, cy), z0, bins=bins, pad=0.004)
    # 前中心（-y）の開き: 上は閉じ、下ほど開く
    verts, info = [], []
    for r in range(rows + 1):
        t = r / rows
        z = z0 + (z1 - z0) * t
        gap = opening * t ** 1.3
        for k in range(bins + 1):
            u = k / bins
            # 角度は前中心の右側から一周して前中心の左側まで（開きの分だけ詰める）
            a = -math.pi / 2 + gap / 2 + u * (2 * math.pi - gap)
            kk = int(round((a + math.pi) / (2 * math.pi) * bins)) % bins
            rad = prof[kk] + flare * t ** 1.15 + 0.012 * t
            x = cx + math.cos(a) * rad
            y = cy + math.sin(a) * rad * (1 + 0.15 * t)
            verts.append((x, y, z))
            side = float(np.clip((x - cx) / max(1e-6, rad), -1, 1))
            info.append((t, side))
    faces = []
    W = bins + 1
    for r in range(rows):
        for k in range(bins):
            faces.append([r * W + k, (r + 1) * W + k, (r + 1) * W + k + 1, r * W + k + 1])   # 外向き
    V = np.array(verts)
    V = smooth(V, faces, iters=4, lam=0.3, pin=np.array([i < W for i in range(len(V))]))
    return V, faces, info


def _head_surface(V, reg, z, ang, center):
    """頭部の、高さ z・水平方向 ang（-y=正面を 0、+x 側が正）での表面の点"""
    hv = V[[i for i in range(len(V)) if reg[i] == 'head']]
    near = hv[np.abs(hv[:, 2] - z) < 0.008]
    d = near[:, :2] - center[:2]
    a = np.arctan2(d[:, 0], -d[:, 1])
    sel = near[np.abs((a - ang + math.pi) % (2 * math.pi) - math.pi) < 0.12]
    if not len(sel):
        sel = near
    r = np.linalg.norm(sel[:, :2] - center[:2], axis=1)
    p = sel[np.argmax(r)].copy()
    return p, (p[:2] - center[:2]) / max(1e-6, np.linalg.norm(p[:2] - center[:2]))


def ellipsoid(c, r, nu=24, nv=14):
    verts, faces = [], []
    for i in range(nv + 1):
        th = math.pi * i / nv
        for j in range(nu):
            ph = 2 * math.pi * j / nu
            verts.append(c + np.array([r[0] * math.sin(th) * math.cos(ph), r[1] * math.sin(th) * math.sin(ph), r[2] * math.cos(th)]))
    for i in range(nv):
        for j in range(nu):
            j2 = (j + 1) % nu
            faces.append([i * nu + j, i * nu + j2, (i + 1) * nu + j2, (i + 1) * nu + j])
    return np.array(verts), faces


def hair_bun_and_strands(V, reg, bones, *, bun_r=(0.028, 0.020, 0.024), bun_drop=0.02, strand_r=0.003, strands=False, tail=0.07):
    """後ろで低くまとめた髷（シニヨン）と、こめかみから垂れる数本の後れ毛。

    観察（補助動画 1VrFkxAX…、0.5/8/38/49/79 s 正面・17/59/91/105/118 s 背面）: 中央分けで後ろへ強く引き、
    うなじの高さで丸くまとめている。こめかみの両側に細い毛束が垂れる。大きさ・本数は推定。
    """
    head = np.asarray(bones['head']['head_b'])
    hv = V[[i for i in range(len(V)) if reg[i] == 'head']]
    center = np.array([head[0], hv[:, 1].mean(), head[2]])
    zb = head[2] - 0.005 - bun_drop
    back, _ = _head_surface(V, reg, zb + 0.03, math.pi, center)
    bc = np.array([head[0], back[1] + bun_r[1] * 0.35, zb])
    bv, bf = ellipsoid(bc, bun_r)
    parts = [(bv, bf)]
    if tail:
        # 結び目から襟元へ垂れる短い毛先（側面・背面フレームで襟に掛かって見える）
        pts = [bc + np.array([0, 0.004 + 0.012 * t, -bun_r[2] * 0.5 - tail * t]) for t in np.linspace(0, 1, 8)]
        parts.append(tube(pts, [0.017 * (1 - 0.3 * t) for t in np.linspace(0, 1, 8)], segments=12))
    top = hv[:, 2].max()
    for side in ((1, -1) if strands else ()):
        pts = []
        for k in range(9):
            t = k / 8
            z = head[2] + (top - head[2]) * (0.50 - 0.45 * t)
            p, n = _head_surface(V, reg, z, side * (1.38 + 0.08 * t), center)
            off = 0.016 + 0.006 * t
            pts.append(np.array([p[0] + n[0] * off, p[1] + n[1] * off, z]))
        radii = [strand_r * (1.0 - 0.5 * (k / 8)) for k in range(9)]
        parts.append(tube(pts, radii, segments=8))
    verts, faces = [], []
    for v, f in parts:
        b = len(verts)
        verts.extend(v.tolist())
        faces.extend([[b + i for i in q] for q in f])
    return np.array(verts), faces


def center_part(Vo, Vs, head, *, width=0.006, depth=0.6):
    """髪の土台の中央に分け目を付ける（前頭部〜頭頂の中心線で厚みを減らす）"""
    out = Vo.copy()
    for i in range(len(Vo)):
        dx = abs(Vs[i, 0] - head[0])
        if dx < width * 2 and Vs[i, 1] < head[1] + 0.03 and Vs[i, 2] > head[2] + 0.12:
            w = max(0.0, 1 - dx / (width * 2)) ** 2 * depth
            out[i] = Vo[i] + (Vs[i] - Vo[i]) * w
    return out


def envelope(Vo, c, z0, na=72, nz=40, blur=2):
    """髪の外形を、頭の周りの角度×高さごとの最大半径でならす（耳の凹凸に沿わず、上を覆うように）"""
    d = Vo[:, :2] - c
    r = np.linalg.norm(d, axis=1)
    a = np.arctan2(d[:, 0], -d[:, 1])
    zmin, zmax = Vo[:, 2].min(), Vo[:, 2].max()
    ia = ((a + math.pi) / (2 * math.pi) * na).astype(int) % na
    iz = np.clip(((Vo[:, 2] - zmin) / max(1e-6, zmax - zmin) * nz).astype(int), 0, nz - 1)
    env = np.zeros((na, nz))
    np.maximum.at(env, (ia, iz), r)
    k = np.exp(-np.arange(-blur, blur + 1) ** 2 / (blur ** 2))
    k /= k.sum()
    sm = env.copy()
    for _ in range(2):
        sm = np.maximum(sm, np.stack([sum(k[j] * np.roll(sm[:, z], j - blur) for j in range(len(k))) for z in range(nz)], 1))
        sm = np.maximum(sm, np.stack([np.convolve(np.pad(sm[i], blur, mode='edge'), k, mode='valid') for i in range(na)], 0))
    target = sm[ia, iz] * 0.985
    grow = np.maximum(r, target) / np.maximum(r, 1e-6)
    out = Vo.copy()
    out[:, :2] = c + d * grow[:, None]
    return out


def hair_shell(V, F, reg, bones, *, thickness=0.015, front=0.60, temple=0.22, nape=-0.03, ear_x=1.0):
    """後ろへ引いてまとめた髪の土台。生え際を「頭の周りの角度 → 高さ」の曲線で決める。

    観察（補助動画の正面・背面フレーム）: 中央分け、こめかみと耳の上半分を髪が覆い、後頭部はうなじまで覆う。
    生え際の高さ（頭頂までの比）front/temple と耳の位置 ear_x は推定値。
    返り値: 頂点, 面, 分け目の面の番号（地肌の色にする）
    """
    head = np.asarray(bones['head']['head_b'])
    hv = V[[i for i in range(len(V)) if reg[i] == 'head']]
    top = hv[:, 2].max()
    h0 = top - head[2]
    c = np.array([head[0], hv[:, 1].mean()])
    keep = np.zeros(len(V), dtype=bool)

    def line(a):
        a = abs(a)
        if a < 0.35:
            return front
        if a < 1.25:
            return front + (temple - front) * (a - 0.35) / 0.9
        if a < 1.95:
            return temple + (nape / h0 - temple) * (a - 1.25) / 0.7
        return nape / h0

    for i in range(len(V)):
        if reg[i] not in ('head', 'neck'):
            continue
        x, y, z = V[i]
        a = math.atan2(x - c[0], -(y - c[1]))
        if (z - head[2]) / h0 < line(a):
            continue
        # 耳（横に張り出した部分）は髪から出す
        if abs(x - c[0]) > ear_x and (z - head[2]) / h0 < temple + 0.12 and 0.9 < abs(a) < 2.2:
            continue
        keep[i] = True
    Vs, Fs, used = submesh(V, F, keep)
    N = vertex_normals(Vs, Fs)
    ring = _ring_distance(Fs, len(Vs), boundary_vertices(Fs, len(Vs)))
    taper = np.clip(ring / 4.0, 0.15, 1.0) ** 0.8
    # 頭頂に少しだけ量感（引っ詰め髪なので控えめ）
    crown = np.clip(((Vs[:, 2] - head[2]) / h0 - 0.7) / 0.3, 0, 1)
    Vo = Vs + N * ((thickness + 0.004 * crown) * taper)[:, None]
    Vo = smooth(Vo, Fs, iters=6, lam=0.45, pin=boundary_vertices(Fs, len(Vs)))
    N2 = vertex_normals(Vo, Fs)
    gap = np.einsum('ij,ij->i', Vo - Vs, N2)
    Vo += N2 * np.maximum(0, thickness * 0.8 * taper - gap)[:, None]
    Vo = envelope(Vo, c, head[2])
    Vo = tidy_edges(Vo, Fs, iters=20)
    part = [k for k, f in enumerate(Fs)
            if abs(Vo[f, 0].mean() - c[0]) < 0.0022 and Vo[f, 1].mean() < c[1] + 0.02 and (Vo[f, 2].mean() - head[2]) / h0 > front]
    return Vo, Fs, part
