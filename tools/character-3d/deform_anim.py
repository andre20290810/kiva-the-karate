"""変形確認アニメーション（肩・肘・膝・腰）を作って .blend に保存する。

  python deform_anim.py -- --blend kiva_body.blend --out kiva_deform.blend [--sec 1.0]
確認用に手で作った姿勢を順につないだもの（元動画のモーションではない）。
"""
import argparse
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pose_tests  # noqa: E402
import posing  # noqa: E402

SEQ = ['neutral', 'elbow_bend', 'arms_raised', 'neutral', 'kiba_dachi', 'zenkutsu_zuki', 'knee_raise', 'turn_back', 'neutral']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--blend', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--sec', type=float, default=1.0)
    a = ap.parse_args(sys.argv[sys.argv.index('--') + 1:])
    bpy.ops.wm.open_mainfile(filepath=a.blend)
    arm = bpy.data.objects['Armature']
    body = bpy.data.objects['Body']
    R = posing.rest_joints(arm)
    sc = bpy.context.scene
    sc.render.fps = 24
    step = int(round(a.sec * 24))
    arm.animation_data_create()
    act = bpy.data.actions.new('DeformCheck')
    arm.animation_data.action = act
    for k, name in enumerate(SEQ):
        posing.pose_from_joints(arm, pose_tests.make_pose(name, R))
        posing.ground_root(arm, body)
        for f in (k * step, k * step + step // 3):
            for pb in arm.pose.bones:
                pb.keyframe_insert('rotation_quaternion', frame=f)
                if pb.parent is None:
                    pb.keyframe_insert('location', frame=f)
    posing.fix_quat_signs(act)
    sc.frame_start, sc.frame_end = 0, (len(SEQ) - 1) * step + step // 3
    bpy.ops.wm.save_as_mainfile(filepath=a.out)
    print('frames', sc.frame_end)


if __name__ == '__main__':
    main()
