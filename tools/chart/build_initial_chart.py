"""初期譜面 charts/seipai.json を作る（連続画像を目視して決めた時刻の一覧から）。

  python tools/chart/build_initial_chart.py --manifest assets/seipai/manifest.json --out charts/seipai.json

A（打撃）のエフェクト位置・方向は、そのコマの関節（manifest の joints）から、胴体から最も遠い手首／足首を選んで入れる。
時刻は 0.2 秒間隔の画像で「動作が止まったコマ」を読んだもので、ミリ秒の精度はない（編集モードで合わせる前提）。
"""
import argparse
import json

import numpy as np

# (時刻, ボタン, action, 表示名, 連続コマンド, 長押し秒) — 目視メモは MEMO
NOTES = [
    (5.8, 'Y', 'breathe', '呼吸', 'opening', 2.6),
    (12.2, 'X', 'stance', '構え', 'opening', None),
    (15.4, 'A', 'strike', '打ち上げ', 'opening', None),
    (18.4, 'X', 'stance', '構え直し', 'cross-01', None),
    (20.8, 'B', 'turn', '旋回', 'turn-01', None),
    (21.6, 'X', 'stance', '構え', 'turn-01', None),
    (22.2, 'A', 'strike', '打ち', 'turn-01', None),
    (24.2, 'A', 'kick', '蹴り', 'kick-01', None),
    (27.2, 'B', 'turn', '旋回', 'turn-02', None),
    (27.6, 'X', 'stance', '構え', 'turn-02', None),
    (32.0, 'B', 'turn', '旋回', 'turn-03', None),
    (32.4, 'A', 'strike', '打ち', 'turn-03', None),
    (34.4, 'B', 'turn', '旋回', 'turn-04', None),
    (35.0, 'A', 'strike', '打ち', 'turn-04', None),
    (36.4, 'B', 'turn', '旋回', 'turn-05', None),
    (37.4, 'X', 'stance', '構え', 'turn-05', None),
    (38.8, 'B', 'turn', '旋回', 'turn-06', None),
    (39.0, 'X', 'stance', '構え', 'turn-06', None),
    (41.2, 'A', 'strike', '下段打ち', 'turn-06', None),
    (42.8, 'B', 'turn', '旋回', 'turn-07', None),
    (43.0, 'X', 'stance', '構え', 'turn-07', None),
    (47.2, 'B', 'turn', '旋回', 'turn-08', None),
    (47.6, 'X', 'stance', '構え', 'turn-08', None),
    (49.4, 'A', 'kick', '膝蹴り', 'turn-08', None),
    (50.8, 'B', 'turn', '旋回', 'turn-09', None),
    (51.2, 'X', 'stance', '構え', 'turn-09', None),
    (52.4, 'B', 'turn', '旋回', 'turn-10', None),
    (52.8, 'X', 'stance', '構え', 'turn-10', None),
    (53.8, 'A', 'kick', '膝蹴り', 'turn-10', None),
    (54.2, 'B', 'turn', '旋回', 'turn-11', None),
    (54.6, 'A', 'strike', '打ち', 'turn-11', None),
    (55.4, 'X', 'stance', '構え直し', 'turn-11', None),
    (56.6, 'B', 'turn', '旋回', 'turn-12', None),
    (57.0, 'X', 'stance', '構え', 'turn-12', None),
    (59.2, 'A', 'kick', '蹴り', 'kick-02', None),
    (59.8, 'A', 'strike', '打ち', 'kick-02', None),
    (61.4, 'B', 'turn', '旋回', 'turn-13', None),
    (62.0, 'X', 'stance', '構え', 'turn-13', None),
    (63.8, 'B', 'turn', '旋回', 'turn-14', None),
    (64.2, 'X', 'stance', '構え', 'turn-14', None),
    (66.4, 'A', 'kick', '膝蹴り', 'kick-03', None),
    (66.8, 'X', 'stance', '構え', 'kick-03', None),
    (68.6, 'B', 'turn', '旋回', 'turn-15', None),
    (69.2, 'X', 'stance', '構え', 'turn-15', None),
    (72.0, 'A', 'strike', '双手打ち', 'turn-15', None),
    (73.4, 'Y', 'breathe', '呼吸', 'closing', 1.8),
]
SEQUENCES = {
    'opening': '呼吸・構え・打ち上げ', 'cross-01': '交差の構え', 'turn-01': '旋回から構え・打ち', 'kick-01': '上段蹴り',
    'turn-02': '後ろへ旋回・構え', 'turn-03': '旋回から打ち', 'turn-04': '旋回から打ち', 'turn-05': '旋回・構え',
    'turn-06': '正面へ旋回・構え・下段打ち', 'turn-07': '旋回・構え', 'turn-08': '旋回・構え・膝蹴り',
    'turn-09': '旋回・構え', 'turn-10': '旋回・構え・蹴り', 'turn-11': '旋回・打ち・構え直し', 'turn-12': '旋回・構え',
    'kick-02': '横蹴りから打ち', 'turn-13': '旋回・構え', 'turn-14': '旋回・構え', 'kick-03': '蹴りから構え',
    'turn-15': '正面へ旋回・構え・双手打ち', 'closing': '締めの呼吸',
}
MEMO = [
    '時刻は 0.2 秒間隔の画像で動作が止まったコマを目視で選んだもの。ミリ秒単位の精度はないので、編集モードで遊びながら合わせてください。',
    'A の打撃点と方向は各コマの関節（MediaPipe の推定）から自動で入れ、膝を上げる 49.4・53.8・66.4 秒は膝を打撃点にしました。ずれている場合は編集の「画面で指定」で直してください。',
    '【未解決】希望の冒頭「Y 長押し → X → A → A」のうち 2 回目の A: 14.6〜24.2 秒を 30fps で確認したが、15.4 秒の打ち上げの後に'
    '続く 2 回目の打撃は無い。15.4〜17.6 秒は打ち上げの姿勢の保持、17.8 秒は腕を下ろして正面へ向く移り（打撃ではない）、'
    '18.0〜18.4 秒は踏み出しながら両腕を交差（構え直し＝X）、20.8 秒は旋回（B）、21.6 秒は構え（X）。次の実際の打撃は 22.2 秒'
    '（片腕を顔の高さで前へ出す打ち、現在の A）。映像にない突きを作らないため、冒頭は Y（5.8 秒〜2.6 秒間）→ X（12.2 秒）→ A（15.4 秒）の'
    '3 つのまま。2 回目の A を冒頭に入れる場合は、22.2 秒の A を冒頭の連続コマンドに含めるか（間に X・B・X が入る）、'
    '別の演武映像を使うかの判断が必要です。',
    'Y の呼吸は、礼の後の静止（5.8〜8.4 秒）と、最後に両手を交差させて胸元へ上げる動作（73.4〜75.2 秒）の 2 か所。その他の静止区間には置いていません。',
    '技名は映像から推定した仮の名前です（打ち上げ・打ち・下段打ち・双手打ち・蹴り）。正確な名称は確認していません。',
    '44.4〜46.8 秒は後ろ向きで足を運ぶ区間ですが、決めの瞬間が読み取れないためノーツを置いていません。',
    '12.4〜14.2 秒、28.0〜31.6 秒、77〜82 秒（礼）は静止・礼のためノーツなし。',
    '動画はカメラの寄り引きがあり、人物の大きさは manifest の体格補正で揃えています。',
]


# 膝を上げる動作（足首より膝が打撃点）。目視で判断
KNEE = {49.4, 53.8, 66.4}


def effect_for(frame, action, t=None):
    J = frame.get('joints')
    W, H = 576, 1024
    if not J:
        return {'preset': 'strike', 'intensity': 1}
    c = np.array(frame['anchor'])
    if action == 'kick' and t in KNEE:
        knee = min(['left_knee', 'right_knee'], key=lambda k: J[k][1])
        hip = knee.replace('knee', 'hip')
        p = np.array(J[knee][:2])
        d = p - np.array(J[hip][:2])
        d = d / (np.linalg.norm(d) + 1e-9) + np.array([0, -1.0])  # 上へ突き上げる向き
        d = d / (np.linalg.norm(d) + 1e-9)
        return {'preset': 'strike', 'anchor': {'x': round(float(p[0] / W), 3), 'y': round(float(p[1] / H), 3)},
                'direction': {'x': round(float(d[0]), 3), 'y': round(float(d[1]), 3)}, 'intensity': 1}
    if action == 'kick':
        # 蹴り足 = 高い方の足首（支持脚は床にある）
        best = min(['left_ankle', 'right_ankle'], key=lambda k: J[k][1])
    else:
        # 打撃の手 = 胴体の中心から最も遠い手首
        best = max(['left_wrist', 'right_wrist'], key=lambda k: np.linalg.norm(np.array(J[k][:2]) - c) * (0.5 + J[k][2]))
    p = np.array(J[best][:2])
    elbow = {'left_wrist': 'left_elbow', 'right_wrist': 'right_elbow', 'left_ankle': 'left_knee', 'right_ankle': 'right_knee'}[best]
    d = p - np.array(J[elbow][:2])
    if np.linalg.norm(d) < 1:
        d = p - c
    d = d / (np.linalg.norm(d) + 1e-9)
    return {'preset': 'strike', 'anchor': {'x': round(float(p[0] / W), 3), 'y': round(float(p[1] / H), 3)},
            'direction': {'x': round(float(d[0]), 3), 'y': round(float(d[1]), 3)}, 'intensity': 1}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    M = json.load(open(a.manifest))
    F = M['frames']
    notes = []
    for k, (t, b, act, label, seq, dur) in enumerate(NOTES):
        n = {'id': f'n{k + 1:03d}', 'time': t, 'button': b, 'action': act, 'input': 'hold' if b == 'Y' else 'tap'}
        if dur:
            n['duration'] = dur
        n['label'] = label
        n['sequenceId'] = seq
        fi = min(len(F) - 1, int(round(t / M['frameIntervalSeconds'])))
        preset = {'Y': 'breath', 'X': 'stance', 'A': 'strike', 'B': 'turn'}[b]
        n['effect'] = effect_for(F[fi], act, t) if b == 'A' else {'preset': preset, 'intensity': 1}
        notes.append(n)
    chart = {
        'schemaVersion': 1, 'title': 'セーパイ',
        'source': {'frameManifest': 'assets/seipai/manifest.json', 'frameCount': M['frameCount'],
                   'frameIntervalSeconds': M['frameIntervalSeconds'], 'durationSeconds': M['durationSeconds']},
        'audio': {'src': 'assets/seipai/audio.m4a', 'startAtTimelineSeconds': 0},
        'settings': {'inputOffsetMs': 0, 'perfectWindowMs': 60, 'goodWindowMs': 120, 'missWindowMs': 180,
                     'holdReleaseWindowMs': 150, 'leadInSeconds': 2, 'laneLeadSeconds': 2.4},
        'display': {'subjectAnchor': {'x': 0.5, 'y': 0.5}, 'referenceHeightRatio': 0.55, 'frameOverrides': {}},
        'sequences': [{'id': k, 'label': v} for k, v in SEQUENCES.items()],
        'notes': notes,
        'memo': MEMO,
    }
    json.dump(chart, open(a.out, 'w'), ensure_ascii=False, indent=2)
    open(a.out, 'a').write('\n')
    print(len(notes), 'notes ->', a.out)


if __name__ == '__main__':
    main()
