"""MakeHuman（CC0）の基本人体メッシュ・骨格・ウェイトを読み込み、体型ターゲットを適用する（Blender 外でも使える純粋処理）。

座標: MakeHuman は Y 上・単位 dm。返す座標は Blender 用に Z 上・単位 m（x, -z, y）* 0.1。
"""
import json
import os
from collections import defaultdict

import numpy as np


def load_obj(path):
    verts, groups, cur = [], defaultdict(list), None
    uvs, face_uv = [], defaultdict(list)
    with open(path) as f:
        for line in f:
            if line.startswith('v '):
                verts.append([float(x) for x in line.split()[1:4]])
            elif line.startswith('vt '):
                uvs.append([float(x) for x in line.split()[1:3]])
            elif line.startswith('g '):
                cur = line.split(None, 1)[1].strip()
            elif line.startswith('f '):
                items = [p.split('/') for p in line.split()[1:]]
                groups[cur].append([int(p[0]) - 1 for p in items])
                face_uv[cur].append([int(p[1]) - 1 if len(p) > 1 and p[1] else -1 for p in items])
    return np.array(verts), dict(groups), np.array(uvs) if uvs else None, dict(face_uv)


def load_target(path):
    idx, d = [], []
    with open(path) as f:
        for line in f:
            if not line.strip() or line.startswith('#'):
                continue
            p = line.split()
            idx.append(int(p[0]))
            d.append([float(p[1]), float(p[2]), float(p[3])])
    return np.array(idx, dtype=int), np.array(d)


def apply_targets(verts, data_dir, targets):
    """targets: [(相対パス, 重み)]"""
    v = verts.copy()
    for rel, w in targets:
        if w == 0:
            continue
        idx, d = load_target(os.path.join(data_dir, 'targets', rel))
        if len(idx):  # 平均体型のターゲットは空（差分なし）
            v[idx] += d * w
    return v


def to_blender(v):
    v = np.asarray(v)
    return np.stack([v[..., 0], -v[..., 2], v[..., 1]], axis=-1) * 0.1


def skeleton(data_dir, verts):
    """骨格（ボーン名 → head/tail/parent/plane 法線）。ジョイント位置は頂点群の平均。"""
    s = json.load(open(os.path.join(data_dir, 'rigs', 'default.mhskel')))
    jpos = {k: verts[np.array(vs)].mean(axis=0) for k, vs in s['joints'].items()}
    planes = s.get('planes', {})
    bones = {}
    for name, b in s['bones'].items():
        plane = planes.get(b['rotation_plane']) if b.get('rotation_plane') else None
        normal = None
        if plane:
            p = [jpos[j] for j in plane]
            normal = np.cross(p[1] - p[0], p[2] - p[1])
            n = np.linalg.norm(normal)
            normal = normal / n if n > 1e-9 else None
        bones[name] = {'head': jpos[b['head']], 'tail': jpos[b['tail']], 'parent': b['parent'], 'normal': normal}
    return bones


def weights(data_dir):
    w = json.load(open(os.path.join(data_dir, 'rigs', 'default_weights.mhw')))['weights']
    return {b: [(int(i), float(x)) for i, x in lst] for b, lst in w.items()}


def collapse(bones, wts, keep):
    """keep に無いボーンのウェイトを、残る最も近い祖先へ移す。"""
    def kept_ancestor(b):
        while b is not None and b not in keep:
            b = bones[b]['parent']
        return b
    out = defaultdict(lambda: defaultdict(float))
    for b, lst in wts.items():
        tgt = kept_ancestor(b)
        if tgt is None:
            continue
        for i, x in lst:
            out[tgt][i] += x
    new_bones = {}
    for b in bones:
        if b in keep:
            nb = dict(bones[b])
            nb['parent'] = kept_ancestor(bones[b]['parent']) if bones[b]['parent'] else None
            new_bones[b] = nb
    return new_bones, {b: dict(v) for b, v in out.items()}


def limit_weights(wts, n_verts, max_influences=4):
    per_v = defaultdict(list)
    for b, d in wts.items():
        for i, x in d.items():
            if x > 1e-4:
                per_v[i].append((x, b))
    out = defaultdict(dict)
    for i, lst in per_v.items():
        lst.sort(reverse=True)
        lst = lst[:max_influences]
        s = sum(x for x, _ in lst)
        for x, b in lst:
            out[b][i] = x / s
    return dict(out)
