"""初期譜面を作る（連続画像を目視して決めた時刻の一覧から）。バージョンごとに別の表（撮影が別なので時刻も別）。

  python tools/chart/build_initial_chart.py --version v1 --manifest assets/seipai/manifest.json --out charts/seipai.json
  python tools/chart/build_initial_chart.py --version v2 --manifest assets/seipai_v2/manifest.json --out charts/seipai_v2.json

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
    (15.4, 'A', 'strike', '打撃', 'opening', None),
    (18.4, 'X', 'stance', '構え直し', 'opening', None),
    (20.8, 'B', 'turn', '旋回', 'opening', None),
    (21.6, 'X', 'stance', '構え', 'opening', None),
    (22.2, 'A', 'strike', '打撃', 'opening', None),
    (24.2, 'A', 'kick', '蹴り', 'kick-01', None),
    (27.2, 'B', 'turn', '旋回', 'turn-02', None),
    (27.6, 'X', 'stance', '構え', 'turn-02', None),
    (32.0, 'B', 'turn', '旋回', 'turn-03', None),
    (32.4, 'A', 'strike', '打撃', 'turn-03', None),
    (34.4, 'B', 'turn', '旋回', 'turn-04', None),
    (35.0, 'A', 'strike', '打撃', 'turn-04', None),
    (36.4, 'B', 'turn', '旋回', 'turn-05', None),
    (37.4, 'X', 'stance', '構え', 'turn-05', None),
    (38.8, 'B', 'turn', '旋回', 'turn-06', None),
    (39.0, 'X', 'stance', '構え', 'turn-06', None),
    (41.2, 'A', 'strike', '打撃', 'turn-06', None),
    (42.8, 'B', 'turn', '旋回', 'turn-07', None),
    (43.0, 'X', 'stance', '構え', 'turn-07', None),
    (47.2, 'B', 'turn', '旋回', 'turn-08', None),
    (47.6, 'X', 'stance', '構え', 'turn-08', None),
    (49.4, 'A', 'kick', '打撃', 'turn-08', None),
    (50.8, 'B', 'turn', '旋回', 'turn-09', None),
    (51.2, 'X', 'stance', '構え', 'turn-09', None),
    (52.4, 'B', 'turn', '旋回', 'turn-10', None),
    (52.8, 'X', 'stance', '構え', 'turn-10', None),
    (53.8, 'A', 'kick', '打撃', 'turn-10', None),
    (54.2, 'B', 'turn', '旋回', 'turn-11', None),
    (54.6, 'A', 'strike', '打撃', 'turn-11', None),
    (55.4, 'X', 'stance', '構え直し', 'turn-11', None),
    (56.6, 'B', 'turn', '旋回', 'turn-12', None),
    (57.0, 'X', 'stance', '構え', 'turn-12', None),
    (59.2, 'A', 'kick', '蹴り', 'kick-02', None),
    (59.8, 'A', 'strike', '打撃', 'kick-02', None),
    (61.4, 'B', 'turn', '旋回', 'turn-13', None),
    (62.0, 'X', 'stance', '構え', 'turn-13', None),
    (63.8, 'B', 'turn', '旋回', 'turn-14', None),
    (64.2, 'X', 'stance', '構え', 'turn-14', None),
    (66.4, 'A', 'kick', '打撃', 'kick-03', None),
    (66.8, 'X', 'stance', '構え', 'kick-03', None),
    (68.6, 'B', 'turn', '旋回', 'turn-15', None),
    (69.2, 'X', 'stance', '構え', 'turn-15', None),
    (72.0, 'A', 'strike', '打撃', 'turn-15', None),
    (73.4, 'Y', 'breathe', '呼吸', 'closing', 1.8),
]
SEQUENCES = {
    'opening': '冒頭（呼吸から旋回・打撃）', 'kick-01': '上段蹴り',
    'turn-02': '後ろへ旋回・構え', 'turn-03': '旋回から打撃', 'turn-04': '旋回から打撃', 'turn-05': '旋回・構え',
    'turn-06': '正面へ旋回・構え・打撃', 'turn-07': '旋回・構え', 'turn-08': '旋回・構え・膝を上げる打撃',
    'turn-09': '旋回・構え', 'turn-10': '旋回・構え・膝を上げる打撃', 'turn-11': '旋回・打撃・構え直し', 'turn-12': '旋回・構え',
    'kick-02': '横蹴りから打撃', 'turn-13': '旋回・構え', 'turn-14': '旋回・構え', 'kick-03': '膝を上げる打撃から構え',
    'turn-15': '正面へ旋回・構え・打撃', 'closing': '締めの呼吸',
}
MEMO = [
    '時刻は 0.2 秒間隔の画像で動作が止まったコマを目視で選んだもの。ミリ秒単位の精度はないので、編集モードで遊びながら合わせてください。',
    'A の打撃点と方向は各コマの関節（MediaPipe の推定）から自動で入れています。ずれている場合は編集の「画面で指定」で直してください。',
    '冒頭は映像の動作に合わせて「Y 呼吸（5.8 秒〜2.6 秒間）→ X 構え（12.2）→ A 打撃（15.4、片腕の突き上げ）→ X 構え直し（18.4、両腕の交差）'
    '→ B 旋回（20.8）→ X 構え（21.6）→ A 打撃（22.2、片腕を顔の高さで前へ）」の 1 つの連続コマンド（opening）。'
    '希望の例「Y → X → A → A」の 2 回目の A は、映像では間に構え直し・旋回・構えが入るため、その動作もコマンドにしています。'
    '15.4〜17.6 秒は打撃の姿勢の保持、17.8 秒は腕を下ろす移り（打撃ではない）なのでノーツなし。',
    '技名を確定できない打撃は「打撃」と表記（編集モードの表示名で変更できます）。はっきり蹴りと分かる 24.2・59.2 秒だけ「蹴り」。'
    '49.4・53.8・66.4 秒は膝を上げる動作で、打撃点は膝にしています。',
    'Y の呼吸は、礼の後の静止（5.8〜8.4 秒）と、最後に両手を交差させて胸元へ上げる動作（73.4〜75.2 秒）の 2 か所。その他の静止区間には置いていません。',
    '44.4〜46.8 秒は後ろ向きで足を運ぶ区間ですが、決めの瞬間が読み取れないためノーツを置いていません。',
    '12.4〜14.2 秒、28.0〜31.6 秒、77〜82 秒（礼）は静止・礼のためノーツなし。',
    '動画はカメラの寄り引きがあり、人物の大きさは manifest の体格補正で揃えています。',
]


# 膝を上げる動作（足首より膝が打撃点）。目視で判断
KNEE = {49.4, 53.8, 66.4}

# ---- ver2（2026-10-20 撮影。別の撮影なので、ver2 の画像で 1 つずつ確認して決めた時刻） ----
# ver1 と同じ型の同じ順番だが、各動作の決まるコマは ver2 の画像で確認した（ver1 から 0〜0.4 秒ずれる所がある）。
NOTES_V2 = [
    (5.8, 'Y', 'breathe', '呼吸', 'opening', 2.6),
    (12.4, 'X', 'stance', '構え', 'opening', None),
    (15.4, 'A', 'strike', '打撃', 'opening', None),
    (18.4, 'X', 'stance', '構え直し', 'opening', None),
    (20.8, 'B', 'turn', '旋回', 'opening', None),
    (21.8, 'X', 'stance', '構え', 'opening', None),
    (22.4, 'A', 'strike', '打撃', 'opening', None),
    (24.2, 'A', 'kick', '蹴り', 'kick-01', None),
    (27.2, 'B', 'turn', '旋回', 'turn-02', None),
    (27.6, 'X', 'stance', '構え', 'turn-02', None),
    (32.2, 'B', 'turn', '旋回', 'turn-03', None),
    (32.6, 'A', 'strike', '打撃', 'turn-03', None),
    (34.4, 'B', 'turn', '旋回', 'turn-04', None),
    (35.0, 'A', 'strike', '打撃', 'turn-04', None),
    (36.4, 'B', 'turn', '旋回', 'turn-05', None),
    (37.4, 'X', 'stance', '構え', 'turn-05', None),
    (38.8, 'B', 'turn', '旋回', 'turn-06', None),
    (39.2, 'X', 'stance', '構え', 'turn-06', None),
    (41.2, 'A', 'strike', '打撃', 'turn-06', None),
    (42.8, 'B', 'turn', '旋回', 'turn-07', None),
    (43.2, 'X', 'stance', '構え', 'turn-07', None),
    (47.2, 'B', 'turn', '旋回', 'turn-08', None),
    (47.6, 'X', 'stance', '構え', 'turn-08', None),
    (49.4, 'A', 'kick', '打撃', 'turn-08', None),
    (50.8, 'B', 'turn', '旋回', 'turn-09', None),
    (51.4, 'X', 'stance', '構え', 'turn-09', None),
    (52.4, 'B', 'turn', '旋回', 'turn-10', None),
    (52.8, 'X', 'stance', '構え', 'turn-10', None),
    (53.8, 'A', 'kick', '打撃', 'turn-10', None),
    (54.2, 'B', 'turn', '旋回', 'turn-11', None),
    (54.6, 'A', 'strike', '打撃', 'turn-11', None),
    (55.6, 'X', 'stance', '構え直し', 'turn-11', None),
    (56.6, 'B', 'turn', '旋回', 'turn-12', None),
    (57.2, 'X', 'stance', '構え', 'turn-12', None),
    (59.4, 'A', 'kick', '打撃', 'kick-02', None),
    (60.0, 'A', 'strike', '打撃', 'kick-02', None),
    (61.4, 'B', 'turn', '旋回', 'turn-13', None),
    (61.8, 'X', 'stance', '構え', 'turn-13', None),
    (63.8, 'B', 'turn', '旋回', 'turn-14', None),
    (64.2, 'X', 'stance', '構え', 'turn-14', None),
    (66.4, 'A', 'kick', '打撃', 'kick-03', None),
    (67.0, 'X', 'stance', '構え', 'kick-03', None),
    (68.6, 'B', 'turn', '旋回', 'turn-15', None),
    (69.4, 'X', 'stance', '構え', 'turn-15', None),
    (72.0, 'A', 'strike', '打撃', 'turn-15', None),
    (73.6, 'Y', 'breathe', '呼吸', 'closing', 1.8),
]
SEQUENCES_V2 = {**SEQUENCES, 'kick-02': '足を上げる打撃から打撃'}
KNEE_V2 = {49.4, 53.8, 66.4}
MEMO_V2 = [
    'ver2（2026-10-20 撮影）用。ver1 とは別の撮影（音声・細部の動きが違う）なので、ver2 の 412 枚で各動作の決まるコマを確認して時刻を決めた。'
    '同じ型を同じ速さで演じているため、多くは ver1 と同じか 0.2〜0.4 秒の違い。ミリ秒の精度はないので編集モードで合わせてください。',
    '冒頭は「Y 呼吸（5.8 秒〜2.6 秒間）→ X 構え（12.4）→ A 打撃（15.4）→ X 構え直し（18.4）→ B 旋回（20.8）→ X 構え（21.8）→ A 打撃（22.4）」。',
    'はっきり蹴りと分かるのは 24.2 秒だけ「蹴り」。49.4・53.8・66.4 秒は膝を上げる動作（打撃点は膝）。59.4 秒は足を前へ上げる動作だが'
    '技を特定できないので「打撃」と表記（ver1 の 59.2 秒のような横蹴りは見られない）。',
    'Y の呼吸は、礼の後の静止（5.8〜8.4 秒）と、両手を交差させて胸元へ上げてから下ろす動作（73.6〜75.4 秒）。その他の静止区間には置いていない。',
    '62.2〜62.6 秒は両腕を引き寄せる移り、44.4〜46.8 秒は後ろ向きで足を運ぶ区間で、決めの瞬間が読み取れないためノーツなし。'
    '12.6〜14.4 秒、28.0〜31.8 秒、76 秒以降（礼）は静止・礼のためノーツなし。',
    'A の打撃点と方向は ver2 の各コマの関節（MediaPipe の推定）から自動で入れています。',
]
VERSIONS = {
    'v1': dict(notes=NOTES, sequences=SEQUENCES, memo=MEMO, knee=KNEE, base='assets/seipai'),
    'v2': dict(notes=NOTES_V2, sequences=SEQUENCES_V2, memo=MEMO_V2, knee=KNEE_V2, base='assets/seipai_v2'),
}


def effect_for(frame, action, t=None, knee=KNEE, size=(576, 1024)):
    J = frame.get('joints')
    W, H = size
    if not J:
        return {'preset': 'strike', 'intensity': 1}
    c = np.array(frame['anchor'])
    if action == 'kick' and t in knee:
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
    ap.add_argument('--version', choices=sorted(VERSIONS), default='v1')
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    V = VERSIONS[a.version]
    M = json.load(open(a.manifest))
    F = M['frames']
    size = (M['width'], M['height'])
    notes = []
    for k, (t, b, act, label, seq, dur) in enumerate(V['notes']):
        n = {'id': f'n{k + 1:03d}', 'time': t, 'button': b, 'action': act, 'input': 'hold' if b == 'Y' else 'tap'}
        if dur:
            n['duration'] = dur
        n['label'] = label
        n['sequenceId'] = seq
        fi = min(len(F) - 1, int(round(t / M['frameIntervalSeconds'])))
        preset = {'Y': 'breath', 'X': 'stance', 'A': 'strike', 'B': 'turn'}[b]
        n['effect'] = effect_for(F[fi], act, t, V['knee'], size) if b == 'A' else {'preset': preset, 'intensity': 1}
        notes.append(n)
    chart = {
        'schemaVersion': 1, **({'gameVersion': a.version} if a.version != 'v1' else {}), 'title': 'セーパイ',
        'source': {'frameManifest': f"{V['base']}/manifest.json", 'frameCount': M['frameCount'],
                   'frameIntervalSeconds': M['frameIntervalSeconds'], 'durationSeconds': M['durationSeconds']},
        'audio': {'src': [f"{V['base']}/audio.m4a", f"{V['base']}/audio_opus.m4a"], 'startAtTimelineSeconds': 0},
        'settings': {'inputOffsetMs': 0, 'perfectWindowMs': 60, 'goodWindowMs': 120, 'missWindowMs': 180,
                     'holdReleaseWindowMs': 150, 'leadInSeconds': 2, 'laneLeadSeconds': 2.4},
        'display': {'subjectAnchor': {'x': 0.5, 'y': 0.5}, 'referenceHeightRatio': 0.55, 'frameOverrides': {}},
        'sequences': [{'id': k, 'label': v} for k, v in V['sequences'].items()],
        'notes': notes,
        'memo': V['memo'],
    }
    json.dump(chart, open(a.out, 'w'), ensure_ascii=False, indent=2)
    open(a.out, 'a').write('\n')
    print(len(notes), 'notes ->', a.out)


if __name__ == '__main__':
    main()
