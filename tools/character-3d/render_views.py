"""キャラクターの確認用レンダリング（Cycles CPU。無料・ローカル）。

  python render_views.py -- --blend X.blend --out dir --name kiva [--views front,side,back] [--pose pose.json]
         [--size 520x900] [--samples 24] [--frame N] [--focus head]
"""
import argparse
import json
import math
import os
import sys

import bpy
from mathutils import Vector, Euler

VIEW_ANGLES = {'front': 0, 'front_left': -35, 'side': -90, 'back': 180, 'side_right': 90}


def setup_render(w, h, samples):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = samples
    try:
        sc.cycles.use_denoising = True
    except Exception:
        pass
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'AgX'
    world = bpy.data.worlds.new('W') if not sc.world else sc.world
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.045, 0.05, 0.065, 1)
    bg.inputs['Strength'].default_value = 1.0


def add_lights(target):
    def area(name, loc, energy, size, color=(1, 1, 1)):
        l = bpy.data.lights.new(name, 'AREA')
        l.energy, l.size, l.color = energy, size, color
        o = bpy.data.objects.new(name, l)
        bpy.context.collection.objects.link(o)
        o.location = loc
        d = Vector(target) - Vector(loc)
        o.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        return o
    area('Key', (2.2, -3.0, 2.8), 420, 2.2)
    area('Fill', (-2.8, -2.2, 1.6), 170, 3.0, (0.85, 0.9, 1.0))
    area('Rim', (0.0, 3.2, 2.6), 380, 2.0, (0.8, 0.9, 1.0))
    # 床（接地確認用）
    bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, 0))
    floor = bpy.context.active_object
    m = bpy.data.materials.new('Floor')
    m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (0.11, 0.105, 0.1, 1)
    p.inputs['Roughness'].default_value = 0.55
    floor.data.materials.append(m)


def bbox(objs):
    lo = Vector((1e9,) * 3); hi = Vector((-1e9,) * 3)
    dg = bpy.context.evaluated_depsgraph_get()
    for o in objs:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        for v in me.vertices:
            p = ev.matrix_world @ v.co
            lo = Vector(map(min, lo, p)); hi = Vector(map(max, hi, p))
        ev.to_mesh_clear()
    return lo, hi


def apply_pose(arm, pose):
    """pose: {bone: [x,y,z] 度（ローカル XYZ オイラー）} または {'__root__': {loc, rot}}"""
    for pb in arm.pose.bones:
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)
    for name, v in pose.items():
        if name == '__object__':
            arm.location = v.get('loc', (0, 0, 0))
            arm.rotation_euler = [math.radians(a) for a in v.get('rot', (0, 0, 0))]
            continue
        pb = arm.pose.bones.get(name)
        if pb:
            pb.rotation_euler = [math.radians(a) for a in v]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--blend', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--name', default='char')
    ap.add_argument('--views', default='front,side,back')
    ap.add_argument('--angles', default='', help='name:deg,...（人物の向き。参照画像から測った向きに合わせて描く）')
    ap.add_argument('--no-floor', action='store_true')
    ap.add_argument('--bg', default='', help='背景色 r,g,b（参照画像に近い明るさで比べる）')
    ap.add_argument('--pose')
    ap.add_argument('--size', default='520x900')
    ap.add_argument('--samples', type=int, default=24)
    ap.add_argument('--frame', type=int)
    ap.add_argument('--frames', help='a-b: 連番で描く（カメラは最初のフレームで固定）')
    ap.add_argument('--bbox-frames', default='', help='カメラの枠を決めるのに使うフレーム（カンマ区切り）')
    ap.add_argument('--focus', default='')
    ap.add_argument('--ground', action='store_true', help='最も低い頂点を床に合わせる')
    ap.add_argument('--exposure', type=float, default=-0.6, help='露出（白い道着で肌が白飛びしないように）')
    a = ap.parse_args(sys.argv[sys.argv.index('--') + 1:])
    bpy.ops.wm.open_mainfile(filepath=a.blend)
    w, h = map(int, a.size.split('x'))
    arm = bpy.data.objects.get('Armature')
    if a.pose and arm:
        poses = json.load(open(a.pose))
        apply_pose(arm, poses if isinstance(poses, dict) else poses[0])
    if a.frame is not None:
        bpy.context.scene.frame_set(a.frame)
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.name != 'Plane' and not o.hide_render]
    bpy.context.view_layer.update()
    lo, hi = bbox(meshes)
    if a.bbox_frames:
        for f in map(int, a.bbox_frames.split(',')):
            bpy.context.scene.frame_set(f)
            l2, h2 = bbox(meshes)
            lo = Vector(map(min, lo, l2)); hi = Vector(map(max, hi, h2))
        bpy.context.scene.frame_set(int(a.frames.split('-')[0]) if a.frames else bpy.context.scene.frame_current)
    if a.ground and arm:
        arm.location.z -= lo.z
        bpy.context.view_layer.update()
        lo, hi = bbox(meshes)
    setup_render(w, h, a.samples)
    bpy.context.scene.view_settings.exposure = a.exposure
    center = (lo + hi) / 2
    add_lights(center)
    if a.no_floor:
        for o in list(bpy.data.objects):
            if o.type == 'MESH' and o.name.startswith('Plane'):
                bpy.data.objects.remove(o)
    cam_data = bpy.data.cameras.new('Cam')
    cam = bpy.data.objects.new('Cam', cam_data)
    bpy.context.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    cam_data.lens = 85
    size = hi - lo
    if a.focus == 'head':
        hb = arm.pose.bones['head']
        hc = arm.matrix_world @ hb.head
        center = hc + Vector((0, 0, 0.08))
        extent = 0.42
    else:
        extent = max(size.z, size.x * h / w, size.y * h / w) * 1.08
    dist = extent / (2 * math.tan(cam_data.angle_y / 2)) if hasattr(cam_data, 'angle_y') else extent * 2
    cam_data.sensor_fit = 'VERTICAL'
    dist = extent / (2 * math.tan(cam_data.angle / 2 * (h / max(w, h))))
    if a.angles:
        for item in a.angles.split(','):
            k, deg = item.split(':')
            VIEW_ANGLES[k] = -float(deg)
        a.views = ','.join(item.split(':')[0] for item in a.angles.split(','))
    if a.bg:
        bpy.context.scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (*map(float, a.bg.split(',')), 1)
    for v in a.views.split(','):
        ang = math.radians(VIEW_ANGLES[v])
        d = Vector((math.sin(ang), -math.cos(ang), 0))
        cam.location = center + d * dist + Vector((0, 0, 0.05 * extent))
        cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
        if a.frames:
            f0, f1 = map(int, a.frames.split('-'))
            for f in range(f0, f1 + 1):
                bpy.context.scene.frame_set(f)
                bpy.context.scene.render.filepath = os.path.join(a.out, f'{a.name}_{v}_{f:05d}.png')
                bpy.ops.render.render(write_still=True)
            continue
        bpy.context.scene.render.filepath = os.path.join(a.out, f'{a.name}_{v}.png')
        bpy.ops.render.render(write_still=True)
        print('rendered', bpy.context.scene.render.filepath)


if __name__ == '__main__':
    main()
