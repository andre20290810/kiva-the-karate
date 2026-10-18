"""頭部メッシュを参照画像の顔の形に合わせる（属性ラベルではなく、画像で測った 478 点の配置を基準にする）。

  python face_fit.py -- --blend kiva_body.blend --ref face_ref.json --model face_landmarker.task --mh <makehuman data>
                        --out kiva_face_offsets.npy [--iters 3] [--depth 0.3] [--report dir]

手順（反復）:
  1. モデルの顔を正面から正射影で描画し、参照と同じ検出器で 478 点を取る（画素 → X,Z は正確、Y は最前面の頂点）
  2. 参照（複数フレームの平均、正準空間）を、目尻・鼻根などの安定点で相似変換してモデルに重ねる
  3. 差（m）を制御点の変位として、ガウス RBF で頭部の頂点を動かす（後頭部・首はアンカーで固定）
出力は MakeHuman ベースメッシュの頂点番号ごとの変位（build_character.py --face-offsets で使う）。

参照の顔は 1 フレームあたり幅 22〜30 px しかなく、検出器の平均顔へ寄る傾向がある。合うのは輪郭・目鼻口の配置の比率までで、
細部（まぶた・唇の形・肌の質感）は再現していない。奥行き方向は推定が不安定なので弱く（--depth）使う。
"""
import argparse
import json
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import face_landmarks as fl  # noqa: E402
import face_metrics  # noqa: E402
import mh_body  # noqa: E402

# 位置合わせに使う安定点（目頭・目尻・鼻根・鼻下）
ALIGN = [33, 133, 362, 263, 168, 6, 2]
# 制御点（輪郭・眉・目尻目頭・鼻・口角）。まぶた・唇の細かい輪郭は小さい顔では雑音なので使わない
CTRL = sorted({10, 297, 284, 389, 454, 361, 397, 378, 152, 149, 172, 132, 234, 162, 54, 67,
               70, 105, 107, 336, 334, 300,
               33, 133, 362, 263,
               168, 6, 195, 4, 1, 2, 129, 358,
               61, 0, 291, 17})


def ortho_camera(center, scale, size):
    sc = bpy.context.scene
    cam = bpy.data.objects.get('FitCam')
    if cam is None:
        cam = bpy.data.objects.new('FitCam', bpy.data.cameras.new('FitCam'))
        sc.collection.objects.link(cam)
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = scale
    cam.location = (center.x, center.y - 1.0, center.z)
    cam.rotation_euler = (np.pi / 2, 0, 0)
    sc.camera = cam
    sc.render.resolution_x = sc.render.resolution_y = size
    return cam


def setup_scene(size):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 12
    sc.view_settings.view_transform = 'Standard'
    if not sc.world:
        sc.world = bpy.data.worlds.new('W')
    sc.world.use_nodes = True
    sc.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.35, 0.35, 0.36, 1)
    for name, loc, e in (('FitKey', (0.4, -1.2, 1.9), 60), ('FitFill', (-0.5, -1.0, 1.6), 35)):
        if name not in bpy.data.objects:
            l = bpy.data.lights.new(name, 'AREA'); l.energy = e; l.size = 1.0
            o = bpy.data.objects.new(name, l); sc.collection.objects.link(o)
            o.location = loc
            o.rotation_euler = (Vector((0, 0, 1.6)) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()


def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    from PIL import Image
    return np.asarray(Image.open(path).convert('RGB'))


def rbf_field(C, D, sigma, lam=1e-4):
    K = np.exp(-np.sum((C[:, None] - C[None]) ** 2, -1) / (2 * sigma ** 2))
    W = np.linalg.solve(K + lam * np.eye(len(C)), D)
    return lambda X: np.exp(-np.sum((X[:, None] - C[None]) ** 2, -1) / (2 * sigma ** 2)) @ W


def similarity(src, dst):
    """src を dst に重ねる相似変換（Umeyama）"""
    ms, md = src.mean(0), dst.mean(0)
    A, B = src - ms, dst - md
    U, S, Vt = np.linalg.svd(B.T @ A)
    d = np.sign(np.linalg.det(U @ Vt))
    D = np.diag([1, 1, d])
    R = U @ D @ Vt
    s = np.trace(np.diag(S) @ D) / (A ** 2).sum()
    return lambda X: s * (X - ms) @ R.T + md


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--blend', required=True)
    ap.add_argument('--ref', required=True)
    ap.add_argument('--model', required=True)
    ap.add_argument('--mh', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--iters', type=int, default=3)
    ap.add_argument('--depth', type=float, default=0.3)
    ap.add_argument('--sigma', type=float, default=0.03)
    ap.add_argument('--damp', type=float, default=0.6)
    ap.add_argument('--report', default='')
    a = ap.parse_args(sys.argv[sys.argv.index('--') + 1:])
    bpy.ops.wm.open_mainfile(filepath=a.blend)
    report = a.report or os.path.dirname(os.path.abspath(a.out))
    os.makedirs(report, exist_ok=True)
    body = bpy.data.objects['Body']
    eyes = bpy.data.objects['Eyes']
    arm = bpy.data.objects['Armature']
    for o in bpy.data.objects:
        if o.type == 'MESH' and o.name not in ('Body', 'Eyes'):
            o.hide_render = True          # 髪・衣装は隠す（顔の点の検出を安定させる）
    _, groups, _, _ = mh_body.load_obj(os.path.join(a.mh, '3dobjs', 'base.obj'))
    used_body = sorted({i for f in groups['body'] for i in f})
    used_eyes = sorted({i for g in ('helper-l-eye', 'helper-r-eye') for f in groups.get(g, []) for i in f})
    V0 = np.array([v.co[:] for v in body.data.vertices])
    E0 = np.array([v.co[:] for v in eyes.data.vertices])
    head_vg = body.vertex_groups.get('head')
    hw = np.zeros(len(V0))
    if head_vg:
        for v in body.data.vertices:
            for g in v.groups:
                if g.group == head_vg.index:
                    hw[v.index] = g.weight
    hb = arm.data.bones['head']
    hc = Vector(hb.head_local) + Vector((0, 0, 0.09))
    size, oscale = 640, 0.30
    setup_scene(size)
    ortho_camera(hc, oscale, size)
    det = fl.landmarker(a.model)
    ref = [f for f in json.load(open(a.ref))['frames'] if not f.get('missing')]
    ref_can = np.mean([np.array(f['canonical_cm']) for f in ref], axis=0)
    face = (hw > 0.5) & (V0[:, 1] < hc.y + 0.01)            # 顔の前半分
    anchor_idx = np.nonzero((hw > 0.5) & (V0[:, 1] > hc.y + 0.03))[0][::25]
    neck_idx = np.nonzero((hw < 0.2) & (V0[:, 2] > hc.z - 0.20) & (V0[:, 2] < hc.z - 0.09))[0][::15]
    V = V0.copy()
    Ecur = E0.copy()
    log = []
    for it in range(a.iters + 1):
        for i, v in enumerate(body.data.vertices):
            v.co = V[i]
        body.data.update()
        img = render(os.path.join(report, f'fit_iter{it}.png'))
        res = fl.detect(det, img)
        if res is None:
            raise RuntimeError('model face not detected')
        mcan = np.array(res['canonical_cm'])
        if it == 0:
            # 左右対応（正準空間で x を反転して最も近い点）。参照と変位を左右対称にして雑音を抑える
            mir = np.array([np.argmin(np.sum((mcan - mcan[i] * [-1, 1, 1]) ** 2, 1)) for i in range(len(mcan))])
            ref_sym = (ref_can + ref_can[mir] * [-1, 1, 1]) / 2
        m = face_metrics.metrics(mcan)
        log.append({'iter': it, **m})
        print('iter', it, ' '.join(f'{k}={v:.3f}' for k, v in m.items()))
        if it == a.iters:
            break
        px = np.array(res['image_px'])
        # 画素 → X,Z（正射影）
        X = hc.x + (px[:, 0] / size - 0.5) * oscale
        Z = hc.z - (px[:, 1] / size - 0.5) * oscale
        # Y: その X,Z に最も近い前面の頂点
        P3 = np.zeros((len(px), 3))
        fv = np.nonzero(face)[0]
        for j in range(len(px)):
            d2 = (V[fv, 0] - X[j]) ** 2 + (V[fv, 2] - Z[j]) ** 2
            near = fv[np.argsort(d2)[:6]]
            P3[j] = (X[j], V[near, 1].min(), Z[j])
        # 参照の正準座標をモデルの正準座標へ重ね、差を m に
        T = similarity(ref_sym[ALIGN], mcan[ALIGN])
        diff_cm = T(ref_sym) - mcan
        diff_cm = (diff_cm + diff_cm[mir] * [-1, 1, 1]) / 2
        cheek_m = abs(X[454] - X[234])
        s = cheek_m / np.linalg.norm(mcan[454, :2] - mcan[234, :2])
        D = np.stack([diff_cm[:, 0] * s, -diff_cm[:, 2] * s * a.depth, diff_cm[:, 1] * s], 1)
        D = np.clip(D * a.damp, -0.004, 0.004)        # 1 回の変位は弱め・4 mm まで
        C = np.concatenate([P3[CTRL], V[anchor_idx], V[neck_idx]])
        DD = np.concatenate([D[CTRL], np.zeros((len(anchor_idx) + len(neck_idx), 3))])
        field = rbf_field(C, DD, a.sigma, lam=0.05)
        sel = np.nonzero(hw > 0.05)[0]
        V[sel] += field(V[sel]) * np.clip(hw[sel], 0, 1)[:, None]
        # 眼球も同じ場で動かす（まぶたと眼球がずれないように）
        for side in (1, -1):
            idx = np.nonzero((Ecur[:, 0] > 0) == (side > 0))[0]
            Ecur[idx] += field(Ecur[idx].mean(0)[None])[0]
        for i, v in enumerate(eyes.data.vertices):
            v.co = Ecur[i]
        eyes.data.update()
    off_body = V - V0
    E = Ecur
    total = np.zeros((max(max(used_body), max(used_eyes)) + 1, 3))
    total[used_body] = off_body
    total[used_eyes] = E - E0
    np.save(a.out, total)
    json.dump({'reference_mean': {k: v[0] for k, v in face_metrics.summarize(a.ref)[0].items()}, 'iterations': log},
              open(os.path.join(report, 'face_fit_log.json'), 'w'), indent=1)
    print('saved', a.out, 'max offset mm %.1f' % (np.linalg.norm(off_body, axis=1).max() * 1000))


if __name__ == '__main__':
    main()
