"""推定関節（landmarks_mp.py の出力）を人体モデルの骨格へ転写する。

  静止画（参照フレームとの比較）:
    python retarget.py -- --blend kiva_body.blend --lm tsuki_lm.json --out dir --stills
  動画（アクションとして焼き込み、GLB を書き出す）:
    python retarget.py -- --blend kiva_body.blend --lm seipai_lm.json --out dir --fps 30 [--glb kiva_seipai.glb]

推定 3D は単眼画像からの推定で、奥行き・回転の正確さは保証しない。
"""
import argparse
import json
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import motion_filter  # noqa: E402
import posing  # noqa: E402


def rest_np(arm):
    return {k: np.array(v) for k, v in posing.rest_joints(arm).items()}


def to_vec(J):
    return {k: Vector(tuple(v)) for k, v in J.items()}


def bake(arm, Js, fps, frame_start=0, times=None):
    """times があれば各姿勢を元動画の時刻の位置に置く（GLB の 0 秒 = 動画の 0 秒。ゲームの同期はこれを前提にする）"""
    sc = bpy.context.scene
    sc.render.fps = int(round(fps))
    frames = [frame_start + (int(round(t * fps)) if times else i) for i, t in enumerate(times or [0] * len(Js))]
    sc.frame_start = 0
    sc.frame_end = max(frames)
    arm.animation_data_create()
    act = bpy.data.actions.new('Seipai')
    arm.animation_data.action = act
    for t, J in enumerate(Js):
        posing.pose_from_joints(arm, to_vec(J))
        # Rigid bones must never acquire shear/scale during IK matrix decomposition.
        # Degenerate foot targets previously yielded scale thousands of times larger.
        for pb in arm.pose.bones:
            pb.scale = (1.0, 1.0, 1.0)
        bpy.context.view_layer.update()
        f = frames[t]
        for pb in arm.pose.bones:
            pb.keyframe_insert('rotation_quaternion', frame=f)
            if pb.parent is None:
                pb.keyframe_insert('location', frame=f)
    posing.fix_quat_signs(act)
    return act


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--blend', required=True)
    ap.add_argument('--lm', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--stills', action='store_true')
    ap.add_argument('--fps', type=float, default=30.0)
    ap.add_argument('--glb')
    a = ap.parse_args(sys.argv[sys.argv.index('--') + 1:])
    bpy.ops.wm.open_mainfile(filepath=a.blend)
    arm = bpy.data.objects['Armature']
    rest = rest_np(arm)
    data = json.load(open(a.lm))
    os.makedirs(a.out, exist_ok=True)
    if a.stills:
        for f in data['frames']:
            if f.get('missing'):
                continue
            Js, _ = motion_filter.process([f], rest, smooth=False, foot_lock=False)
            posing.pose_from_joints(arm, to_vec(Js[0]))
            name = os.path.splitext(f['name'])[0]
            bpy.ops.wm.save_as_mainfile(filepath=os.path.join(a.out, f'fit_{name}.blend'), copy=True)
            print('fitted', name)
        return
    Js, contact = motion_filter.process(data['frames'], rest, fps=a.fps)
    times = [f.get('time') for f in data['frames']]
    bake(arm, Js, a.fps, times=times if all(t is not None for t in times) else None)
    json.dump({s: c.tolist() for s, c in contact.items()}, open(os.path.join(a.out, 'foot_contact.json'), 'w'))
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(a.out, 'kiva_motion.blend'))
    if a.glb:
        bpy.ops.export_scene.gltf(filepath=a.glb, export_format='GLB', export_animations=True, export_skins=True,
                                  export_morph=False, export_force_sampling=True, export_frame_step=2,
                                  export_optimize_animation_size=True)
    print('baked', len(Js), 'frames')


if __name__ == '__main__':
    main()
