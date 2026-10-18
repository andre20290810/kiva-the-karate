"""変形確認用の姿勢（肘・膝・肩・腰）と代表的な空手の姿勢を作ってレンダリングする。

  python pose_tests.py -- --blend kiva_body.blend --out dir [--only name] [--views front_left,side]

姿勢は関節位置（アーマチュア座標）で指定し、posing.pose_from_joints で骨格に転写する。
ここでの姿勢は確認用に手で作ったもので、元動画から測定したモーションではない。
"""
import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import posing  # noqa: E402

FRONT = Vector((0, -1, 0))
UP = Vector((0, 0, 1))


def rest_joints(arm):
    B = arm.data.bones
    J = {
        'shoulder.L': B['upperarm01.L'].head_local, 'elbow.L': B['lowerarm01.L'].head_local, 'wrist.L': B['wrist.L'].head_local,
        'shoulder.R': B['upperarm01.R'].head_local, 'elbow.R': B['lowerarm01.R'].head_local, 'wrist.R': B['wrist.R'].head_local,
        'hip.L': B['upperleg01.L'].head_local, 'knee.L': B['lowerleg01.L'].head_local, 'ankle.L': B['foot.L'].head_local,
        'hip.R': B['upperleg01.R'].head_local, 'knee.R': B['lowerleg01.R'].head_local, 'ankle.R': B['foot.R'].head_local,
        'toe.L': B['toe1-1.L'].head_local, 'toe.R': B['toe1-1.R'].head_local,
        'chest': B['neck01'].head_local, 'neck': B['neck01'].head_local, 'head_top': B['head'].tail_local,
    }
    return {k: Vector(v) for k, v in J.items()}


def seg_lengths(J):
    L = {}
    for s in 'LR':
        L[f'upper.{s}'] = (J[f'elbow.{s}'] - J[f'shoulder.{s}']).length
        L[f'fore.{s}'] = (J[f'wrist.{s}'] - J[f'elbow.{s}']).length
        L[f'thigh.{s}'] = (J[f'knee.{s}'] - J[f'hip.{s}']).length
        L[f'shin.{s}'] = (J[f'ankle.{s}'] - J[f'knee.{s}']).length
        L[f'foot.{s}'] = (J[f'toe.{s}'] - J[f'ankle.{s}']).length
    return L


def leg(J, L, s, hip, knee_dir, ankle_dir, foot_dir=FRONT):
    J[f'hip.{s}'] = hip
    J[f'knee.{s}'] = hip + knee_dir.normalized() * L[f'thigh.{s}']
    J[f'ankle.{s}'] = J[f'knee.{s}'] + ankle_dir.normalized() * L[f'shin.{s}']
    J[f'toe.{s}'] = J[f'ankle.{s}'] + (foot_dir.normalized() + Vector((0, 0, -0.35))).normalized() * L[f'foot.{s}']


def leg_ik(J, L, s, hip, ankle, pole, foot_dir=FRONT):
    """足首を床上の位置に置き、膝は pole 方向に曲げる（2 リンク IK）"""
    a, b = L[f'thigh.{s}'], L[f'shin.{s}']
    d = ankle - hip
    dist = min(d.length, (a + b) * 0.999)
    u = d.normalized()
    x = (a * a - b * b + dist * dist) / (2 * dist)
    h = math.sqrt(max(0.0, a * a - x * x))
    p = pole - u * pole.dot(u)
    p = p.normalized() if p.length > 1e-6 else Vector((0, -1, 0))
    J[f'hip.{s}'] = hip
    J[f'knee.{s}'] = hip + u * x + p * h
    J[f'ankle.{s}'] = hip + u * dist
    J[f'toe.{s}'] = J[f'ankle.{s}'] + (foot_dir.normalized() + Vector((0, 0, -0.35))).normalized() * L[f'foot.{s}']


def armpose(J, L, s, upper_dir, fore_dir):
    J[f'elbow.{s}'] = J[f'shoulder.{s}'] + upper_dir.normalized() * L[f'upper.{s}']
    J[f'wrist.{s}'] = J[f'elbow.{s}'] + fore_dir.normalized() * L[f'fore.{s}']


def make_pose(name, R):
    """R: 静止姿勢の関節。足が床に着くよう腰の高さを計算する。"""
    J = {k: v.copy() for k, v in R.items()}
    L = seg_lengths(R)
    hipw = (R['hip.L'] - R['hip.R']).length
    pelvis = (R['hip.L'] + R['hip.R']) / 2
    ankle_h = R['ankle.L'].z
    torso = R['chest'] - pelvis
    side = Vector((1, 0, 0))

    def place_hips(drop, shift=Vector((0, 0, 0)), yaw=0.0):
        c = pelvis + Vector((0, 0, -drop)) + shift
        ax = Vector((math.cos(yaw), math.sin(yaw), 0))
        return c + ax * hipw / 2, c - ax * hipw / 2, c, ax

    def shoulders(c, ax, lean=Vector((0, 0, 0))):
        J['chest'] = c + torso + lean
        J['neck'] = J['chest']
        J['head_top'] = J['chest'] + (R['head_top'] - R['chest'])
        sw = (R['shoulder.L'] - R['shoulder.R']).length / 2
        sh = (R['shoulder.L'] + R['shoulder.R']) / 2 - R['chest']
        J['shoulder.L'] = J['chest'] + sh + ax * sw
        J['shoulder.R'] = J['chest'] + sh - ax * sw

    if name == 'neutral':
        hl, hr, c, ax = place_hips(0)
        shoulders(c, ax)
        armpose(J, L, 'L', Vector((0.15, 0, -1)), Vector((0.1, -0.15, -1)))
        armpose(J, L, 'R', Vector((-0.15, 0, -1)), Vector((-0.1, -0.15, -1)))
        leg(J, L, 'L', hl, Vector((0.03, 0, -1)), Vector((0, 0, -1)))
        leg(J, L, 'R', hr, Vector((-0.03, 0, -1)), Vector((0, 0, -1)))
    elif name == 'elbow_bend':
        hl, hr, c, ax = place_hips(0)
        shoulders(c, ax)
        armpose(J, L, 'L', Vector((0.2, -1, -0.15)), Vector((0, -0.15, 1)))      # 上腕を前、前腕を上（肘 約90°）
        armpose(J, L, 'R', Vector((-0.2, 0, -1)), Vector((0, -1, 0.05)))        # 上腕を下、前腕を前（肘 約90°）
        leg(J, L, 'L', hl, Vector((0.03, 0, -1)), Vector((0, 0, -1)))
        leg(J, L, 'R', hr, Vector((-0.03, 0, -1)), Vector((0, 0, -1)))
    elif name == 'arms_raised':
        hl, hr, c, ax = place_hips(0)
        shoulders(c, ax)
        armpose(J, L, 'L', Vector((0.5, 0, 1)), Vector((0.25, 0, 1)))          # 肩を大きく上げる
        armpose(J, L, 'R', Vector((-1, 0, 0.05)), Vector((-1, 0, 0.05)))       # 真横
        leg(J, L, 'L', hl, Vector((0.03, 0, -1)), Vector((0, 0, -1)))
        leg(J, L, 'R', hr, Vector((-0.03, 0, -1)), Vector((0, 0, -1)))
    elif name == 'kiba_dachi':            # 騎馬立ち（膝を深く曲げる）
        hl, hr, c, ax = place_hips(0.17)
        shoulders(c, ax)
        leg_ik(J, L, 'L', hl, Vector((0.36, 0.0, ankle_h)), Vector((0.6, -0.4, 0)), Vector((0.3, -1, 0)))
        leg_ik(J, L, 'R', hr, Vector((-0.36, 0.0, ankle_h)), Vector((-0.6, -0.4, 0)), Vector((-0.3, -1, 0)))
        armpose(J, L, 'L', Vector((0.35, 0.1, -1)), Vector((0.05, -1, 0.1)))   # 腰の拳（引き手）
        armpose(J, L, 'R', Vector((-0.35, 0.1, -1)), Vector((-0.05, -1, 0.1)))
    elif name == 'zenkutsu_zuki':         # 前屈立ちで中段突き
        hl, hr, c, ax = place_hips(0.11, Vector((0, -0.08, 0)))
        shoulders(c, ax, lean=Vector((0, -0.03, 0)))
        leg_ik(J, L, 'L', hl, Vector((0.14, -0.42, ankle_h)), Vector((0, -1, 0)))                       # 前脚を曲げる
        leg_ik(J, L, 'R', hr, Vector((-0.16, 0.50, ankle_h)), Vector((0, -1, 0)), Vector((-0.4, -1, 0)))  # 後脚を伸ばす
        armpose(J, L, 'R', Vector((0.25, -1, -0.12)), Vector((0.12, -1, -0.02)))  # 突き（伸ばす）
        armpose(J, L, 'L', Vector((0.25, 0.55, -1)), Vector((0, -1, 0.15)))      # 引き手
    elif name == 'knee_raise':            # 片膝を高く上げる
        hl, hr, c, ax = place_hips(0.02)
        shoulders(c, ax)
        leg(J, L, 'L', hl, Vector((0.05, -1, 0.15)), Vector((0, 0.1, -1)))      # 大腿を水平に
        leg(J, L, 'R', hr, Vector((-0.03, 0, -1)), Vector((0, 0, -1)))
        armpose(J, L, 'L', Vector((0.4, -0.6, -0.6)), Vector((-0.2, -1, 0.5)))
        armpose(J, L, 'R', Vector((-0.4, -0.6, -0.6)), Vector((0.2, -1, 0.5)))
    elif name == 'turn_back':             # 体を 180° 回した構え（背面の確認）
        hl, hr, c, ax = place_hips(0.06, yaw=math.pi)
        shoulders(c, ax)
        leg_ik(J, L, 'L', hl, Vector((-0.22, 0.05, ankle_h)), Vector((-0.4, 1, 0)), Vector((0, 1, 0)))
        leg_ik(J, L, 'R', hr, Vector((0.22, 0.05, ankle_h)), Vector((0.4, 1, 0)), Vector((0, 1, 0)))
        armpose(J, L, 'L', Vector((-0.3, 0.6, -0.7)), Vector((0.2, 1, 0.4)))
        armpose(J, L, 'R', Vector((0.3, 0.6, -0.7)), Vector((-0.2, 1, 0.4)))
    else:
        raise ValueError(name)
    return J


POSES = ['neutral', 'elbow_bend', 'arms_raised', 'kiba_dachi', 'zenkutsu_zuki', 'knee_raise', 'turn_back']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--blend', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--only', default='')
    a = ap.parse_args(sys.argv[sys.argv.index('--') + 1:])
    bpy.ops.wm.open_mainfile(filepath=a.blend)
    arm = bpy.data.objects['Armature']
    R = posing.rest_joints(arm)
    os.makedirs(a.out, exist_ok=True)
    for name in (a.only.split(',') if a.only else POSES):
        J = make_pose(name, R)
        posing.pose_from_joints(arm, J)
        # 姿勢を保存（render_views で読む）
        pose = {pb.name: list(pb.rotation_quaternion) for pb in arm.pose.bones}
        pose['__root_matrix__'] = [list(r) for r in arm.pose.bones[0].matrix]
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(a.out, f'pose_{name}.blend'), copy=True)
        print('posed', name)


if __name__ == '__main__':
    main()
