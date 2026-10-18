"""生成された人物メッシュ（画像→3D の AI ツールの出力など）を参照画像と同じ物差しで評価する。

  python mesh_compare.py -- --mesh generated.glb --ref-face face_ref.json --face-model face_landmarker.task
                            --pose-model pose_landmarker_heavy.task --ref-body ref_front.png --out dir [--height 1.62]

 1. メッシュを読み込み、身長を --height に合わせて床に立たせる（向きは -Y 正面を仮定。--yaw で補正）
 2. 正面・斜め・側面・背面・顔の正面を描画
 3. 顔の正面描画に参照と同じ顔検出（478 点）をかけ、face_metrics の比率を参照と比べる
 4. 全身の正面描画に参照と同じ姿勢検出をかけ、body_metrics の比率を参照と比べる
 判定（目安）: 顔の比率がすべて参照の平均 ±2σ（σ が 0.01 未満なら ±0.02）に入り、全身の比率の差が 5% 以内なら「候補」。
 それ以外は不採用。顔が検出できない（崩れている）場合も不採用。数値は目安で、最終判断は並べた画像を目で確認する。
"""
import argparse
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import face_landmarks as fl  # noqa: E402
import face_metrics  # noqa: E402


def load(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ext = os.path.splitext(path)[1].lower()
    if ext in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == '.obj':
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == '.ply':
        bpy.ops.wm.ply_import(filepath=path)
    elif ext == '.blend':
        bpy.ops.wm.open_mainfile(filepath=path)
    else:
        raise ValueError(ext)
    return [o for o in bpy.context.scene.objects if o.type == 'MESH']


def bbox(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in objs:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        pts += [ev.matrix_world @ v.co for v in me.vertices]
        ev.to_mesh_clear()
    P = np.array([p[:] for p in pts])
    return P.min(0), P.max(0)


def setup(objs, height, yaw):
    root = bpy.data.objects.new('Root', None)
    bpy.context.scene.collection.objects.link(root)
    for o in objs:
        if o.parent is None:
            o.parent = root
    root.rotation_euler = (0, 0, math.radians(yaw))
    bpy.context.view_layer.update()
    lo, hi = bbox(objs)
    s = height / max(1e-6, hi[2] - lo[2])
    root.scale = (s, s, s)
    bpy.context.view_layer.update()
    lo, hi = bbox(objs)
    root.location = (-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2])
    bpy.context.view_layer.update()
    return bbox(objs)


def render(path, cam_loc, target, ortho, size):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = 12
    sc.render.resolution_x, sc.render.resolution_y = size
    sc.view_settings.view_transform = 'Standard'
    if not sc.world:
        sc.world = bpy.data.worlds.new('W')
    sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.4, 0.4, 0.42, 1)
    sc.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
    if 'Key' not in bpy.data.objects:
        l = bpy.data.lights.new('Key', 'SUN'); l.energy = 3.0
        o = bpy.data.objects.new('Key', l); sc.collection.objects.link(o); o.rotation_euler = (math.radians(50), 0, math.radians(25))
    cam = bpy.data.objects.get('Cam') or bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    if cam.name not in sc.collection.objects:
        sc.collection.objects.link(cam)
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = ortho
    cam.location = cam_loc
    cam.rotation_euler = (Vector(target) - Vector(cam_loc)).to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    from PIL import Image
    return np.asarray(Image.open(path).convert('RGB'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mesh', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--ref-face')
    ap.add_argument('--ref-body')
    ap.add_argument('--face-model')
    ap.add_argument('--pose-model')
    ap.add_argument('--height', type=float, default=1.62)
    ap.add_argument('--yaw', type=float, default=0.0)
    a = ap.parse_args(sys.argv[sys.argv.index('--') + 1:])
    os.makedirs(a.out, exist_ok=True)
    objs = load(a.mesh)
    lo, hi = setup(objs, a.height, a.yaw)
    H = hi[2] - lo[2]
    c = Vector((0, 0, H / 2))
    views = {'front': (0, -6, H / 2), 'oblique': (4.2, -4.2, H / 2), 'side': (6, 0, H / 2), 'back': (0, 6, H / 2)}
    for k, loc in views.items():
        render(os.path.join(a.out, f'body_{k}.png'), loc, c, H * 1.1, (520, 880))
    head_c = Vector((0, 0, H * 0.925))
    face_img = render(os.path.join(a.out, 'face_front.png'), (0, -6, head_c.z), head_c, H * 0.17, (640, 640))
    result = {'mesh': os.path.basename(a.mesh), 'verts': sum(len(o.data.vertices) for o in objs)}
    if a.ref_face and a.face_model:
        det = fl.landmarker(a.face_model)
        res = fl.detect(det, face_img)
        ref, _ = face_metrics.summarize(a.ref_face)
        if res is None:
            result['face'] = 'NOT DETECTED (face missing or broken) -> reject'
        else:
            m = face_metrics.metrics(res['canonical_cm'])
            rows, ok = {}, True
            for k, (mu, sd) in ref.items():
                tol = max(2 * sd, 0.02)
                inside = abs(m[k] - mu) <= tol
                ok &= inside
                rows[k] = {'mesh': round(m[k], 3), 'ref': round(mu, 3), 'tol': round(tol, 3), 'inside': bool(inside)}
            result['face'] = rows
            result['face_ok'] = bool(ok)
    if a.ref_body and a.pose_model:
        import body_metrics
        mb = body_metrics.metrics(body_metrics.detect(a.pose_model, os.path.join(a.out, 'body_front.png')))
        rb = body_metrics.metrics(body_metrics.detect(a.pose_model, a.ref_body))
        result['body'] = {k: {'mesh': round(mb[k], 3), 'ref': round(rb[k], 3), 'diff_%': round(100 * (mb[k] / rb[k] - 1), 1)} for k in rb}
        result['body_ok'] = all(abs(v['diff_%']) <= 5 for v in result['body'].values())
    result['verdict'] = 'candidate (check images by eye)' if result.get('face_ok') and result.get('body_ok', True) else 'reject'
    json.dump(result, open(os.path.join(a.out, 'mesh_compare.json'), 'w'), indent=1, ensure_ascii=False)
    print(json.dumps({k: result[k] for k in ('mesh', 'verdict')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
