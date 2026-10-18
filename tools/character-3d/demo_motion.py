"""確認用の演武デモ（TECH PREVIEW）を作り、GLB に書き出す。

セーパイの元動画・関節データがない環境で、Three.js 側（スキン変形・エフェクトの骨追従・同期）を検証するためのもの。
補助動画（突きの型）12 枚から推定した姿勢と確認用の手作り姿勢を、キー姿勢として時間に並べる。
**セーパイの動きではない。** 本番のモーションは retarget.py で seipai.mp4 の推定関節から作る。

  python demo_motion.py -- --blend kiva_body.blend --lm tsuki_lm.json --duration 82.2 --glb out.glb
"""
import argparse
import json
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import motion_filter  # noqa: E402
import pose_tests  # noqa: E402
import posing  # noqa: E402
from retarget import rest_np, to_vec  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--blend', required=True)
    ap.add_argument('--lm', required=True)
    ap.add_argument('--duration', type=float, default=82.2)
    ap.add_argument('--fps', type=int, default=30)
    ap.add_argument('--glb', required=True)
    ap.add_argument('--save')
    a = ap.parse_args(sys.argv[sys.argv.index('--') + 1:])
    bpy.ops.wm.open_mainfile(filepath=a.blend)
    arm = bpy.data.objects['Armature']
    rest = rest_np(arm)
    R = posing.rest_joints(arm)
    frames = [f for f in json.load(open(a.lm))['frames'] if not f.get('missing')]
    keys = [to_vec(pose_tests.make_pose('neutral', R))]
    hand = ['kiba_dachi', 'zenkutsu_zuki', 'knee_raise', 'elbow_bend', 'turn_back']
    for i, f in enumerate(frames):
        Js, _ = motion_filter.process([f], rest, smooth=False, foot_lock=False)
        keys.append(to_vec(Js[0]))
        if i % 3 == 2 and hand:
            keys.append(pose_tests.make_pose(hand.pop(0), R))
    keys.append(to_vec(pose_tests.make_pose('neutral', R)))
    sc = bpy.context.scene
    sc.render.fps = a.fps
    total = int(round(a.duration * a.fps))
    sc.frame_start, sc.frame_end = 0, total
    arm.animation_data_create()
    act = bpy.data.actions.new('DemoKata_TECH_PREVIEW')
    arm.animation_data.action = act
    step = total / (len(keys) - 1)
    body = bpy.data.objects['Body']
    root = arm.pose.bones['root']
    for k, J in enumerate(keys):
        posing.pose_from_joints(arm, J)
        # 手作りの姿勢は腰の高さを床に合わせていないため、最も低い頂点が床に来るよう骨盤を上下させる
        posing.ground_root(arm, body)
        # 各キー姿勢を少し保持してから次へ（突き・構えの「止め」に見えるように）
        # 技は速く（約 0.4 秒で次の姿勢へ）、決めの姿勢を保持する
        for f in sorted({int(round(k * step)), min(total, int(round(k * step + max(step * 0.35, step - 0.4 * a.fps))))}):
            for pb in arm.pose.bones:
                pb.keyframe_insert('rotation_quaternion', frame=f)
                if pb.parent is None:
                    pb.keyframe_insert('location', frame=f)
    posing.fix_quat_signs(act)
    if a.save:
        bpy.ops.wm.save_as_mainfile(filepath=a.save)
    bpy.ops.export_scene.gltf(filepath=a.glb, export_format='GLB', export_animations=True, export_skins=True,
                              export_morph=False, export_force_sampling=True, export_frame_step=2,
                              export_optimize_animation_size=True)
    print('keys', len(keys), 'frames', total)


if __name__ == '__main__':
    main()
