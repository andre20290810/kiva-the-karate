"""正準顔空間の 478 点から形の比率を測る（参照とモデルの比較用）。

  python face_metrics.py face_ref.json [face_model.json ...]
"""
import json
import sys

import numpy as np

# MediaPipe Face Mesh の代表点
IDX = {'top': 10, 'chin': 152, 'cheekL': 454, 'cheekR': 234, 'jawL': 397, 'jawR': 172, 'eyeOutL': 263, 'eyeOutR': 33,
       'eyeInL': 362, 'eyeInR': 133, 'noseTip': 1, 'noseBase': 2, 'noseBridge': 168, 'mouthL': 291, 'mouthR': 61,
       'lipTop': 13, 'lipBot': 14, 'browL': 334, 'browR': 105, 'alarL': 358, 'alarR': 129}


def metrics(c):
    c = np.asarray(c)
    P = {k: c[i] for k, i in IDX.items()}
    d = lambda a, b: float(np.linalg.norm(P[a][:2] - P[b][:2]))
    cheek = d('cheekL', 'cheekR')
    height = d('top', 'chin')
    return {
        'height/cheek': height / cheek,
        'jaw/cheek': d('jawL', 'jawR') / cheek,
        'eye_outer/cheek': d('eyeOutL', 'eyeOutR') / cheek,
        'eye_inner/cheek': d('eyeInL', 'eyeInR') / cheek,
        'nose_len/height': d('noseBridge', 'noseBase') / height,
        'nose_width/cheek': d('alarL', 'alarR') / cheek,
        'mouth/cheek': d('mouthL', 'mouthR') / cheek,
        'lower(noseBase-chin)/height': d('noseBase', 'chin') / height,
        'brow_to_eye/height': (abs(P['browL'][1] - P['eyeOutL'][1]) + abs(P['browR'][1] - P['eyeOutR'][1])) / 2 / height,
        'nose_depth/cheek': float(P['noseTip'][2] - (P['cheekL'][2] + P['cheekR'][2]) / 2) / cheek,
    }


def summarize(path):
    fr = [f for f in json.load(open(path))['frames'] if not f.get('missing')]
    M = [metrics(f['canonical_cm']) for f in fr]
    keys = list(M[0])
    return {k: (float(np.mean([m[k] for m in M])), float(np.std([m[k] for m in M]))) for k in keys}, len(fr)


if __name__ == '__main__':
    res = [(p, *summarize(p)) for p in sys.argv[1:]]
    keys = list(res[0][1])
    print('%-28s' % 'metric' + ''.join('%22s' % (r[0].split('/')[-1][:20] + f'(n={r[2]})') for r in res))
    for k in keys:
        print('%-28s' % k + ''.join('%15.3f ±%5.3f' % r[1][k] for r in res))
