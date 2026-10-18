"""motion_filter の検査（Blender 不要）:  python test_motion_filter.py"""
import numpy as np

import motion_filter as mf

REST = {
    'hip.L': [0.09, 0, 0.9], 'hip.R': [-0.09, 0, 0.9], 'knee.L': [0.09, 0, 0.5], 'knee.R': [-0.09, 0, 0.5],
    'ankle.L': [0.09, 0, 0.08], 'ankle.R': [-0.09, 0, 0.08], 'toe.L': [0.09, -0.13, 0.02], 'toe.R': [-0.09, -0.13, 0.02],
    'shoulder.L': [0.18, 0, 1.38], 'shoulder.R': [-0.18, 0, 1.38], 'elbow.L': [0.2, 0, 1.1], 'elbow.R': [-0.2, 0, 1.1],
    'wrist.L': [0.21, 0, 0.86], 'wrist.R': [-0.21, 0, 0.86], 'chest': [0, 0, 1.4], 'neck': [0, 0, 1.4], 'head_top': [0, 0, 1.62],
}
REST = {k: np.array(v, float) for k, v in REST.items()}


def mp_frame(rng, jitter=0.0, shift=0.0):
    """モデル座標の静止姿勢を MediaPipe world 形式（x, y下, z奥）に戻した 33 点"""
    w = np.zeros((33, 4)); w[:, 3] = 0.9
    def put(i, p):
        p = p + rng.normal(0, jitter, 3) + np.array([shift, 0, 0])
        w[i, :3] = [p[0], -p[2] + 0.9, p[1]]
    for name, idx in mf.MP.items():
        base = name.replace('heel', 'ankle').replace('ear', 'shoulder')
        p = REST[base].copy() if base in REST else REST['chest'].copy()
        if name.startswith('ear'):
            p = p + np.array([0, 0, 0.22]) - np.array([p[0] * 0.6, 0, 0])
        if name.startswith('heel'):
            p = p + np.array([0, 0.05, -0.06])
        put(idx, p)
    return {'world': w.tolist()}


def test_lengths_and_ground():
    rng = np.random.default_rng(1)
    Js, _ = mf.process([mp_frame(rng, 0.01)], REST, smooth=False, foot_lock=False)
    J = Js[0]
    L = mf.lengths(REST)
    for s in 'LR':
        assert abs(np.linalg.norm(J[f'knee.{s}'] - J[f'hip.{s}']) - L[f'thigh.{s}']) < 1e-6
        assert abs(np.linalg.norm(J[f'wrist.{s}'] - J[f'elbow.{s}']) - L[f'fore.{s}']) < 1e-6
    assert abs(min(J['ankle.L'][2], J['ankle.R'][2]) - REST['ankle.L'][2]) < 1e-6


def test_foot_lock_reduces_sliding():
    rng = np.random.default_rng(2)
    frames = [mp_frame(rng, 0.012) for _ in range(60)]
    raw, _ = mf.process(frames, REST, smooth=False, foot_lock=False)
    fixed, contact = mf.process(frames, REST, smooth=True, foot_lock=True)
    slide = lambda Js: sum(np.linalg.norm((Js[t]['ankle.L'] - Js[t - 1]['ankle.L'])[:2]) for t in range(1, len(Js)))
    assert contact['L'][1:].mean() > 0.8, contact['L'].mean()
    assert slide(fixed) < slide(raw) * 0.3, (slide(fixed), slide(raw))


def _with_image(f, rng):
    w = np.asarray(f['world'])
    im = np.zeros((33, 4)); im[:, 3] = 0.9
    im[:, 0] = 0.5 + w[:, 0] * 0.4 * 1024 / 576; im[:, 1] = 0.5 + w[:, 1] * 0.4   # 画素で等方になるように
    f['image'] = im.tolist(); f['size'] = [576, 1024]
    return f


def test_qc_fixes_lr_swap_and_depth_flip():
    import motion_qc
    rng = np.random.default_rng(3)
    frames = [_with_image(mp_frame(rng, 0.004), rng) for _ in range(20)]
    # 10 フレーム目: 左右ラベルの取り違え。14 フレーム目: 右前腕の奥行きだけが反転（前に出した腕が後ろに見える）
    for f in frames:
        ww = np.asarray(f['world']); ww[16, 2] = ww[14, 2] - 0.2; ww[16, 1] = ww[14, 1] - 0.05; f['world'] = ww.tolist()
    for k in ('image', 'world'):
        frames[10][k] = np.asarray(frames[10][k])[motion_qc.SWAP].tolist()
    w = np.asarray(frames[14]['world']); w[16, 2] = w[14, 2] + 0.2; frames[14]['world'] = w.tolist()
    qc = {}
    mf.process(frames, REST, smooth=False, foot_lock=False, qc=qc)
    assert 10 in qc['lr_swaps_fixed'], qc
    assert (14, 'limb-depth 14-16') in qc['depth_flips_fixed'], qc['depth_flips_fixed']


def test_reprojection_small_for_consistent_pose():
    import motion_qc
    rng = np.random.default_rng(4)
    f = _with_image(mp_frame(rng, 0.0), rng)
    Js, _ = mf.process([f], REST, smooth=False, foot_lock=False)
    rep = motion_qc.reprojection(Js[0], f)
    assert rep['mean'] < 0.12, rep['mean']


if __name__ == '__main__':
    n = 0
    for name, fn in list(globals().items()):
        if name.startswith('test_'):
            fn(); n += 1; print('ok', name)
    print(n, 'passed')
