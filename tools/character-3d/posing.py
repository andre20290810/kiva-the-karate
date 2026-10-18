"""骨格の姿勢付け（方向指定）。動作の転写（3D 関節位置 → ボーン回転）と変形確認の両方で使う。

各ボーンを「親の姿勢を反映したうえで、ボーンの向き（Y 軸）を指定方向へ最小回転させる」。
MakeHuman 骨格は上腕・前腕・大腿・下腿が 2 本ずつ（ねじれ分割）なので、先頭のボーンを向け、2本目は親に追従させる。
"""
import math

import bpy
from mathutils import Matrix, Quaternion, Vector

# 目標方向を与える区間: ボーン → (始点ジョイント, 終点ジョイント)
CHAINS = {
    'spine05': ('hips', 'chest'), 'spine03': ('hips', 'chest'), 'neck01': ('neck', 'head_top'),
    'upperarm01.L': ('shoulder.L', 'elbow.L'), 'lowerarm01.L': ('elbow.L', 'wrist.L'),
    'upperarm01.R': ('shoulder.R', 'elbow.R'), 'lowerarm01.R': ('elbow.R', 'wrist.R'),
    'upperleg01.L': ('hip.L', 'knee.L'), 'lowerleg01.L': ('knee.L', 'ankle.L'),
    'upperleg01.R': ('hip.R', 'knee.R'), 'lowerleg01.R': ('knee.R', 'ankle.R'),
    'foot.L': ('ankle.L', 'toe.L'), 'foot.R': ('ankle.R', 'toe.R'),
}
ORDER = ['spine05', 'spine03', 'neck01', 'upperarm01.L', 'lowerarm01.L', 'upperarm01.R', 'lowerarm01.R',
         'upperleg01.L', 'lowerleg01.L', 'upperleg01.R', 'lowerleg01.R', 'foot.L', 'foot.R']


REST_JOINT_BONES = {
    'shoulder.L': ('upperarm01.L', 'head'), 'elbow.L': ('lowerarm01.L', 'head'), 'wrist.L': ('wrist.L', 'head'),
    'shoulder.R': ('upperarm01.R', 'head'), 'elbow.R': ('lowerarm01.R', 'head'), 'wrist.R': ('wrist.R', 'head'),
    'hip.L': ('upperleg01.L', 'head'), 'knee.L': ('lowerleg01.L', 'head'), 'ankle.L': ('foot.L', 'head'),
    'hip.R': ('upperleg01.R', 'head'), 'knee.R': ('lowerleg01.R', 'head'), 'ankle.R': ('foot.R', 'head'),
    'toe.L': ('toe1-1.L', 'head'), 'toe.R': ('toe1-1.R', 'head'),
    'chest': ('neck01', 'head'), 'neck': ('neck01', 'head'), 'head_top': ('head', 'tail'),
}


def rest_joints(arm):
    B = arm.data.bones
    J = {k: Vector(getattr(B[b], f'{e}_local')) for k, (b, e) in REST_JOINT_BONES.items()}
    J['hips'] = (J['hip.L'] + J['hip.R']) / 2
    return J


def reset(arm):
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = (1, 0, 0, 0)
        pb.location = (0, 0, 0)
    bpy.context.view_layer.update()


def aim(arm, bone, direction, up=None):
    """bone の向きを direction（アーマチュア座標）へ。up があればねじれ（Z 軸）も合わせる。"""
    pb = arm.pose.bones[bone]
    pb.rotation_quaternion = (1, 0, 0, 0)
    bpy.context.view_layer.update()
    M = pb.matrix.copy()
    cur = (M.to_3x3() @ Vector((0, 1, 0))).normalized()
    d = Vector(direction).normalized()
    R = cur.rotation_difference(d).to_matrix().to_4x4()
    if up is not None:
        z = (R.to_3x3() @ M.to_3x3() @ Vector((0, 0, 1)))
        u = Vector(up) - d * Vector(up).dot(d)
        if u.length > 1e-6 and z.length > 1e-6:
            u.normalize()
            zp = (z - d * z.dot(d)).normalized()
            ang = zp.angle(u)
            if zp.cross(u).dot(d) < 0:
                ang = -ang
            R = Quaternion(d, ang).to_matrix().to_4x4() @ R
    head = M.translation.copy()
    newM = Matrix.Translation(head) @ R @ Matrix.Translation(-head) @ M
    pb.matrix = newM
    bpy.context.view_layer.update()


def bend(arm, bone, axis_local, degrees):
    """局所軸まわりの追加回転（指の握り・手首など）"""
    pb = arm.pose.bones[bone]
    pb.rotation_quaternion = Quaternion(Vector(axis_local), math.radians(degrees)) @ pb.rotation_quaternion
    bpy.context.view_layer.update()


def fist(arm, side, amount=1.0):
    """握り拳（指を各関節で曲げる。軸は MakeHuman 骨格の局所 X）"""
    for f in range(2, 6):
        for j, deg in ((1, 70), (2, 95), (3, 60)):
            b = f'finger{f}-{j}.{side}'
            if b in arm.pose.bones:
                bend(arm, b, (1, 0, 0), deg * amount)
    for j, deg in ((1, 20), (2, 35), (3, 30)):
        b = f'finger1-{j}.{side}'
        if b in arm.pose.bones:
            bend(arm, b, (1, 0, 0), deg * amount)


def pose_from_joints(arm, J, *, fists=True):
    """J: ジョイント名 → アーマチュア座標の位置（m）。腰の位置も合わせる。"""
    reset(arm)
    root = arm.pose.bones.get('root') or arm.pose.bones[0]
    # 骨盤の位置・向き
    hips = (Vector(J['hip.L']) + Vector(J['hip.R'])) / 2
    rest_hips = (arm.data.bones['upperleg01.L'].head_local + arm.data.bones['upperleg01.R'].head_local) / 2
    across = (Vector(J['hip.L']) - Vector(J['hip.R'])).normalized()
    rest_across = (arm.data.bones['upperleg01.L'].head_local - arm.data.bones['upperleg01.R'].head_local).normalized()
    up = (Vector(J['chest']) - hips).normalized()
    fwd = across.cross(up).normalized()
    rest_fwd = rest_across.cross(Vector((0, 0, 1))).normalized()
    Rm = Matrix((across, fwd, across.cross(fwd))).transposed()
    Rr = Matrix((rest_across, rest_fwd, rest_across.cross(rest_fwd))).transposed()
    R = (Rm @ Rr.inverted()).to_4x4()
    M = root.matrix.copy()
    root.matrix = Matrix.Translation(hips) @ R @ Matrix.Translation(-rest_hips) @ M
    bpy.context.view_layer.update()
    J = dict(J)
    J.setdefault('hips', hips)
    RJ = rest_joints(arm)
    for b in ORDER:
        if b not in arm.pose.bones:
            continue
        a, c = CHAINS[b]
        if a in J and c in J:
            # ボーンの静止方向と関節区間の静止方向のずれ（首の前傾など）を保ったまま区間の回転を適用
            rest_seg = RJ[c] - RJ[a]
            seg = Vector(J[c]) - Vector(J[a])
            bone_rest = arm.data.bones[b].vector_local if hasattr(arm.data.bones[b], 'vector_local') else \
                (arm.data.bones[b].tail_local - arm.data.bones[b].head_local)
            # 骨盤の回転を先に適用し、残りを最小回転で合わせる（向きを変えた姿勢で体が反らないように）
            base = R.to_3x3() @ rest_seg
            d = base.rotation_difference(seg) @ (R.to_3x3() @ Vector(bone_rest))
            up_v = None
            if b.startswith(('spine', 'neck')):
                # ねじれは骨盤の回転に揃える（ボーンの静止ロール軸を骨盤と同じだけ回す）
                up_v = R.to_3x3() @ (arm.data.bones[b].matrix_local.to_3x3() @ Vector((0, 0, 1)))
            aim(arm, b, d, up=up_v)
    if fists:
        fist(arm, 'L'); fist(arm, 'R')


def ground_root(arm, body, floor=0.0):
    """評価後のメッシュの最下点が床に来るようにルートを上下させる"""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = body.evaluated_get(dg)
    me = ev.to_mesh()
    zmin = min((ev.matrix_world @ v.co).z for v in me.vertices)
    ev.to_mesh_clear()
    root = arm.pose.bones.get('root') or arm.pose.bones[0]
    root.matrix = Matrix.Translation((0, 0, floor - zmin)) @ root.matrix
    bpy.context.view_layer.update()


def action_fcurves(act):
    """Blender 4.4 以降のレイヤー付きアクションと旧 API の両方から F カーブを列挙する"""
    if hasattr(act, 'fcurves') and not hasattr(act, 'layers'):
        return list(act.fcurves)
    out = []
    for layer in act.layers:
        for strip in layer.strips:
            for slot in act.slots:
                cb = strip.channelbag(slot)
                if cb:
                    out.extend(cb.fcurves)
    return out


def fix_quat_signs(act):
    """隣り合うキーのクォータニオンが反対符号だと補間で大回りするので、符号を揃える"""
    curves = action_fcurves(act)
    for path in {fc.data_path for fc in curves if fc.data_path.endswith('rotation_quaternion')}:
        fcs = sorted([fc for fc in curves if fc.data_path == path], key=lambda c: c.array_index)
        if len(fcs) != 4:
            continue
        prev = None
        for i in range(len(fcs[0].keyframe_points)):
            q = [fc.keyframe_points[i].co[1] for fc in fcs]
            if prev is not None and sum(a * b for a, b in zip(q, prev)) < 0:
                q = [-x for x in q]
                for c, fc in enumerate(fcs):
                    fc.keyframe_points[i].co[1] = q[c]
            prev = q
        for fc in fcs:
            fc.update()
