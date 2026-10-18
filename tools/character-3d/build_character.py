"""KIVA / ALEXANDRE の 3D キャラクターを Blender で組み立てる（無料・ローカル処理）。

  python build_character.py --mh <makehuman/data> --out <出力先> --variant kiva|alexandre [--render]

人体: MakeHuman の基本メッシュ（CC0）に体型ターゲットを適用。骨格: MakeHuman 既定骨格（CC0）から
ゲーム用の人型骨格（顔ボーンは頭へ統合）。ウェイト: MakeHuman 既定ウェイト（4影響に制限・正規化）。
衣装（道着・帯 / ロングコート）と髪は、人体の補助形状から作り、人体のウェイトを転写して骨格で変形させる。
"""
import argparse
import math
import os
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Vector, Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mh_body  # noqa: E402
import garments  # noqa: E402

KEEP_BONES = {
    'root', 'spine05', 'spine04', 'spine03', 'spine02', 'spine01', 'neck01', 'neck02', 'neck03', 'head',
    'pelvis.L', 'pelvis.R', 'upperleg01.L', 'upperleg02.L', 'lowerleg01.L', 'lowerleg02.L', 'foot.L', 'toe1-1.L',
    'upperleg01.R', 'upperleg02.R', 'lowerleg01.R', 'lowerleg02.R', 'foot.R', 'toe1-1.R',
    'clavicle.L', 'shoulder01.L', 'upperarm01.L', 'upperarm02.L', 'lowerarm01.L', 'lowerarm02.L', 'wrist.L',
    'clavicle.R', 'shoulder01.R', 'upperarm01.R', 'upperarm02.R', 'lowerarm01.R', 'lowerarm02.R', 'wrist.R',
}
for side in 'LR':
    for f in range(1, 6):
        for j in range(1, 4):
            KEEP_BONES.add(f'finger{f}-{j}.{side}')
    for m in range(1, 5):
        KEEP_BONES.add(f'metacarpal{m}.{side}')

VARIANTS = {
    # 観察: 女性・若年成人・標準体型（推定）。人種・体重・筋肉量は映像から測定していない推定値。
    'kiva': {
        'targets': [('macrodetails/universal-female-young-averagemuscle-averageweight.target', 1.0),
                    ('macrodetails/asian-female-young.target', 1.0)],
        'skin': (0.42, 0.25, 0.165), 'hair': (0.012, 0.009, 0.008),
    },
    'alexandre': {
        'targets': [('macrodetails/universal-male-young-averagemuscle-averageweight.target', 1.0),
                    ('macrodetails/caucasian-male-young.target', 1.0)],
        'skin': (0.83, 0.66, 0.56), 'hair': (0.78, 0.80, 0.84),
    },
}


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, rough=0.6, sheen=0.0, sss=0.0, metallic=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metallic
    if sss:
        p.inputs['Subsurface Weight'].default_value = sss
        p.inputs['Subsurface Radius'].default_value = (1.0, 0.45, 0.3)
        p.inputs['Subsurface Scale'].default_value = 0.01
    if sheen:
        p.inputs['Sheen Weight'].default_value = sheen
    return m


def build_body(data_dir, variant):
    verts, groups, uvs, face_uv = mh_body.load_obj(os.path.join(data_dir, '3dobjs', 'base.obj'))
    verts = mh_body.apply_targets(verts, data_dir, VARIANTS[variant]['targets'])
    bones = mh_body.skeleton(data_dir, verts)
    wts = mh_body.weights(data_dir)
    bones, wts = mh_body.collapse(bones, wts, KEEP_BONES)
    wts = mh_body.limit_weights(wts, len(verts))
    vb = mh_body.to_blender(verts)
    # 足裏を床（z=0）に合わせる
    body_idx = sorted({i for f in groups['body'] for i in f})
    dz = -vb[body_idx, 2].min()
    vb[:, 2] += dz
    for b in bones.values():
        for k in ('head', 'tail'):
            p = mh_body.to_blender(b[k]); p[2] += dz
            b[k + '_b'] = p
    return vb, groups, uvs, face_uv, bones, wts


def mesh_from_groups(name, vb, groups, names, wts=None):
    faces = [f for g in names for f in groups.get(g, [])]
    used = sorted({i for f in faces for i in f})
    remap = {old: new for new, old in enumerate(used)}
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(vb[i]) for i in used], [], [[remap[i] for i in f] for f in faces])
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    if wts:
        for b, d in wts.items():
            vg = None
            for old, w in d.items():
                if old in remap:
                    if vg is None:
                        vg = ob.vertex_groups.new(name=b)
                    vg.add([remap[old]], w, 'REPLACE')
    for p in me.polygons:
        p.use_smooth = True
    return ob, remap


def build_armature(bones):
    arm = bpy.data.armatures.new('Armature')
    ob = bpy.data.objects.new('Armature', arm)
    bpy.context.collection.objects.link(ob)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    eb = {}
    for name, b in bones.items():
        e = arm.edit_bones.new(name)
        e.head = Vector(b['head_b'])
        e.tail = Vector(b['tail_b'])
        if (e.tail - e.head).length < 1e-4:
            e.tail = e.head + Vector((0, 0, 0.01))
        if b['normal'] is not None:
            e.align_roll(Vector(mh_body.to_blender(b['normal'])))
        eb[name] = e
    for name, b in bones.items():
        if b['parent'] and b['parent'] in eb:
            eb[name].parent = eb[b['parent']]
            if (eb[name].head - eb[b['parent']].tail).length < 1e-3:
                eb[name].use_connect = False
    bpy.ops.object.mode_set(mode='OBJECT')
    return ob


def bind(obj, arm):
    obj.parent = arm
    mod = obj.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm


def transfer_weights(target, source):
    """衣装・髪に人体のウェイトを転写（最も近い面の補間）"""
    for vg in source.vertex_groups:
        if vg.name not in target.vertex_groups:
            target.vertex_groups.new(name=vg.name)
    mod = target.modifiers.new('wt', 'DATA_TRANSFER')
    mod.object = source
    mod.use_vert_data = True
    mod.data_types_verts = {'VGROUP_WEIGHTS'}
    mod.vert_mapping = 'POLYINTERP_NEAREST'
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.datalayout_transfer(modifier=mod.name)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    # 4影響に制限・正規化
    bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)


def rigid(ob, bone):
    for vg in list(ob.vertex_groups):
        ob.vertex_groups.remove(vg)
    g = ob.vertex_groups.new(name=bone)
    g.add(list(range(len(ob.data.vertices))), 1.0, 'REPLACE')


LEG_PREFIX = ('upperleg', 'lowerleg', 'pelvis.')


def soften_skirt(ob, waist_z, depth=0.35, keep=0.45):
    """上着の裾（腰より下）は脚の動きを弱めて骨盤に寄せる（裾が脚に貼り付いて裂けるのを防ぐ）"""
    names = {g.index: g.name for g in ob.vertex_groups}
    root = ob.vertex_groups.get('root') or ob.vertex_groups.new(name='root')
    for v in ob.data.vertices:
        if v.co.z >= waist_z:
            continue
        t = min(1.0, (waist_z - v.co.z) / depth) * (1 - keep)
        moved = 0.0
        for ge in v.groups:
            if names[ge.group].startswith(LEG_PREFIX):
                d = ge.weight * t
                ge.weight -= d
                moved += d
        if moved:
            root.add([v.index], moved, 'ADD')


def add_brows(body, eyes, hair_color):
    """眉: 眼球の上の前向きの面を髪色に近い材質にする（MakeHuman の眉アセットは同梱されていないため）"""
    import numpy as np
    body.data.materials.append(material('Brow', tuple(c * 1.4 for c in hair_color), rough=0.7))
    mi = len(body.data.materials) - 1
    for side in (1, -1):
        pts = np.array([tuple(v.co) for v in eyes.data.vertices if (v.co.x > 0) == (side > 0)])
        if not len(pts):
            continue
        c = pts.mean(axis=0)
        r = (pts.max(axis=0) - pts.min(axis=0)).max() / 2
        for p in body.data.polygons:
            q = p.center
            dx = (q.x - c[0]) * side          # 外側が正
            arch = 0.004 * (1 - (dx / (1.6 * r)) ** 2)
            lo = c[2] + r * 1.25 + arch - 0.0015 * dx / r
            if -0.7 * r < dx < 1.55 * r and lo < q.z < lo + r * 0.42 and q.y < c[1] and p.normal.y < -0.3:
                p.material_index = mi


def skirt_weights(ob, info):
    """裾: 上は骨盤、下へ行くほど左右の大腿に追従（前後中央は両脚に半分ずつ）"""
    g = {n: ob.vertex_groups.new(name=n) for n in ('root', 'upperleg01.L', 'upperleg01.R', 'lowerleg01.L', 'lowerleg01.R')}
    for i, (t, side) in enumerate(info):
        leg = 0.75 * t
        wl = leg * (0.5 + 0.5 * side)
        wr = leg * (0.5 - 0.5 * side)
        shin = 0.15 * max(0.0, t - 0.6) / 0.4
        g['root'].add([i], 1 - leg, 'REPLACE')
        g['upperleg01.L'].add([i], wl * (1 - shin), 'REPLACE')
        g['upperleg01.R'].add([i], wr * (1 - shin), 'REPLACE')
        g['lowerleg01.L'].add([i], wl * shin, 'REPLACE')
        g['lowerleg01.R'].add([i], wr * shin, 'REPLACE')


def paint_gloves_boots(body):
    """手袋とブーツ: 手・足のウェイトを持つ面を革の材質に（形状は素肌のまま。厚みは推定で付けない）"""
    body.data.materials.append(material('GloveLeather', (0.02, 0.02, 0.022), rough=0.35, sheen=0.1))
    body.data.materials.append(material('BootLeather', (0.018, 0.016, 0.016), rough=0.3))
    gi, bi = len(body.data.materials) - 2, len(body.data.materials) - 1
    names = {g.index: g.name for g in body.vertex_groups}
    hand = lambda n: n.startswith(('wrist', 'finger', 'metacarpal'))
    foot = lambda n: n.startswith(('foot', 'toe'))
    wsum = []
    for v in body.data.vertices:
        h = sum(e.weight for e in v.groups if hand(names[e.group]))
        f = sum(e.weight for e in v.groups if foot(names[e.group]))
        wsum.append((h, f, v.co.z))
    ankle = min(z for h, f, z in wsum if f > 0.5)
    for p in body.data.polygons:
        hs = sum(wsum[i][0] for i in p.vertices) / len(p.vertices)
        fs = sum(wsum[i][1] for i in p.vertices) / len(p.vertices)
        if hs > 0.4:
            p.material_index = gi
        elif fs > 0.3 or p.center.z < ankle + 0.17:
            p.material_index = bi


def mesh_obj(name, V, F, mat=None, smooth_shade=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(map(float, v)) for v in V], [], [list(map(int, f)) for f in F])
    me.validate()
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    if mat:
        me.materials.append(mat)
    for p in me.polygons:
        p.use_smooth = smooth_shade
    return ob


def solidify(ob, thickness, offset=1.0, lining=False):
    m = ob.modifiers.new('Solidify', 'SOLIDIFY')
    m.thickness = thickness
    m.offset = offset
    if lining:
        m.material_offset = 1          # 内側の面を 2 番目の材質（裏地）に
    m.use_even_offset = True
    # アーマチュアより先に厚みを付ける（変形後に厚みが崩れない）
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_move_to_index(modifier=m.name, index=0)


def add_garments(variant, vb, groups, wts, bones, body, arm):
    faces = groups['body']
    used = sorted({i for f in faces for i in f})
    remap = {o: k for k, o in enumerate(used)}
    V = vb[used]
    F = [[remap[i] for i in f] for f in faces]
    W = {b: {remap[i]: w for i, w in d.items() if i in remap} for b, d in wts.items()}
    reg, _ = garments.dominant_regions(len(V), W)
    out = []
    if variant == 'kiva':
        gi = material('Gi', (0.86, 0.86, 0.83), rough=0.88, sheen=0.35)
        jv, jf, _ = garments.gi_jacket(V, F, reg, bones)
        pv, pf, _ = garments.gi_pants(V, F, reg, bones)
        jacket = mesh_obj('GiJacket', jv, jf, gi)
        pants = mesh_obj('GiPants', pv, pf, gi)
        bv, bf = garments.belt(jv, bones)
        belt = mesh_obj('Belt', bv, bf, material('BeltBlack', (0.018, 0.018, 0.02), rough=0.55))
        hv, hf, _, _ = garments.hair_cap(V, F, reg, bones)
        hair_m = material('Hair', VARIANTS[variant]['hair'], rough=0.38)
        hair = mesh_obj('Hair', hv, hf, hair_m)
        tv, tf = garments.ponytail(bones)
        tail = mesh_obj('HairTail', tv, tf, hair_m)
        out = [(jacket, 0.004), (pants, 0.004), (belt, 0.006), (hair, 0.0), (tail, 0.0)]
    elif variant == 'alexandre':
        coat_m = material('CoatBlack', (0.008, 0.008, 0.01), rough=0.55, sheen=0.04)
        lining = material('CoatLiningRed', (0.42, 0.015, 0.025), rough=0.45, sheen=0.3)
        # 上半身は腰までの上衣、腰から下は一枚の裾（脚ごとの筒にしない）
        jv, jf, _ = garments.gi_jacket(V, F, reg, bones, hem_below_crotch=-0.12, sleeve=0.95, ease=0.026, coat=True)
        coat = mesh_obj('Coat', jv, jf, coat_m)
        coat.data.materials.append(lining)
        sv, sf, sinfo = garments.coat_skirt(jv, bones)
        skirt = mesh_obj('CoatSkirt', sv, sf, coat_m)
        skirt.data.materials.append(lining)
        skirt_weights(skirt, sinfo)
        pv, pf, _ = garments.gi_pants(V, F, reg, bones, ease=0.012, flare=0.006)
        pants = mesh_obj('Trousers', pv, pf, material('TrousersDark', (0.03, 0.03, 0.035), rough=0.6))
        hv, hf, _, _ = garments.hair_cap(V, F, reg, bones, thickness=0.018, fringe=True, long_back=0.04)
        hair = mesh_obj('Hair', hv, hf, material('HairSilver', VARIANTS[variant]['hair'], rough=0.35, sheen=0.3))
        out = [(coat, 0.006), (skirt, 0.006), (pants, 0.004), (hair, 0.0)]
        paint_gloves_boots(body)
    waist_z = garments.landmarks(bones)['crotch_z'] + 0.1
    for ob, th in out:
        if ob.name == 'CoatSkirt':
            bind(ob, arm)
            solidify(ob, th, lining=True)
            continue
        transfer_weights(ob, body)   # 骨格に結び付ける前に人体のウェイトを転写
        if ob.name == 'Belt':
            rigid(ob, 'root')            # 帯と帯の端は骨盤に固定（脚に引っ張られない）
        elif ob.name in ('GiJacket', 'Coat') and waist_z is not None:
            soften_skirt(ob, waist_z)
        bind(ob, arm)
        if th:
            solidify(ob, th, lining=ob.name == 'Coat')
    return [o for o, _ in out]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mh', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--variant', default='kiva')
    args = ap.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:])
    os.makedirs(args.out, exist_ok=True)
    clear_scene()
    vb, groups, uvs, face_uv, bones, wts = build_body(args.mh, args.variant)
    V = VARIANTS[args.variant]
    body, _ = mesh_from_groups('Body', vb, groups, ['body'], wts)
    body.data.materials.append(material('Skin', V['skin'], rough=0.6, sss=0.05))
    eyes, _ = mesh_from_groups('Eyes', vb, groups, ['helper-l-eye', 'helper-r-eye'], wts)
    # 眼球: 前を向いた面を虹彩（濃い茶）、それ以外を白目に
    eyes.data.materials.append(material('EyeWhite', (0.78, 0.76, 0.72), rough=0.2))
    eyes.data.materials.append(material('Iris', (0.05, 0.03, 0.02), rough=0.15))
    import numpy as _np
    for side in (1, -1):
        idx = [p.index for p in eyes.data.polygons if (p.center.x > 0) == (side > 0)]
        if not idx:
            continue
        c = _np.mean([tuple(eyes.data.polygons[i].center) for i in idx], axis=0)
        r = max(abs(eyes.data.polygons[i].center.y - c[1]) for i in idx)
        for i in idx:
            pc = eyes.data.polygons[i].center
            if pc.y < c[1] - r * 0.55:
                eyes.data.polygons[i].material_index = 1
    add_brows(body, eyes, V['hair'])
    arm = build_armature(bones)
    for ob in (body, eyes):
        bind(ob, arm)
    add_garments(args.variant, vb, groups, wts, bones, body, arm)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.out, f'{args.variant}_body.blend'))
    print('bones', len(arm.data.bones), 'verts', len(body.data.vertices))


if __name__ == '__main__':
    main()
