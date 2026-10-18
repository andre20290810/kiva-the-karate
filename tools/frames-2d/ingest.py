"""提供 ZIP（seipai_transparent_412frames.zip）を取り込み、ゲーム用素材を作り直して確認用の画像を出す。

  python tools/frames-2d/ingest.py --zip source/seipai_transparent_412frames.zip --model pose_landmarker_heavy.task
  python tools/frames-2d/ingest.py --download 1Mt_DYiGNyEWi5bpO2JASFXAEe5r0LSWZ --model ...   （drive.google.com に接続できる環境のみ）

手順:
 1. ZIP を source/seipai_transparent_zip/ に展開（元の ZIP は変更しない）
 2. 検査: frame_0000〜0411.png が 412 枚、576×1024、アルファあり、timestamps.csv の時刻（0.2 秒間隔・0.0〜82.2 秒）
 3. prepare_frames.py で assets/seipai/（manifest.json・cut/*.webp）を作り直す（代用素材の値は使わない）
 4. 確認用の出力（--report、既定 source/ingest_report/）:
    - centered.jpg   … 412 枚を胴体の中心・補正済みの倍率で並べた一覧（中央からの流れ・脈打ちの確認）
    - scale.csv      … コマごとの倍率と隣のコマとの差
    - anchors.jpg    … 譜面の A ノーツの打撃点（現在の値）と、新しい関節から求めた位置の比較
    - anchors.csv    … 同上の数値（ずれが大きいものは要修正）
    - report.md      … 検査結果のまとめ
 譜面（charts/seipai.json）は自動では書き換えない。--rebuild-chart を付けたときだけ初期譜面を作り直す。
"""
import argparse
import csv
import json
import os
import subprocess
import sys
import zipfile

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))


def download(file_id, dest):
    """Google ドライブの共有ファイル（リンクを知っている全員）を取得。大きなファイルの確認画面にも対応。"""
    import re
    import urllib.request
    url = f'https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=120) as r:
        head = r.read(2048)
        if head.lstrip().startswith(b'<'):
            m = re.search(rb'name="uuid" value="([^"]+)"', head + r.read())
            if not m:
                raise SystemExit('ドライブがファイルではなく HTML を返しました（共有設定・接続制限を確認）')
            url += '&uuid=' + m.group(1).decode()
            r2 = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=120)
            head, r = r2.read(2048), r2
        with open(dest, 'wb') as f:
            f.write(head)
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
    return dest


def check_frames(src, count=412, interval=0.2):
    """欠落・重複（同じ画素の画像）・寸法・アルファ・timestamps.csv の時刻を検査する。"""
    import hashlib
    files = sorted(f for f in os.listdir(src) if f.startswith('frame_') and f.endswith('.png'))
    problems = []
    want = [f'frame_{k:04d}.png' for k in range(count)]
    missing = sorted(set(want) - set(files))
    extra = sorted(set(files) - set(want))
    if missing:
        problems.append(f'欠落 {len(missing)} 枚: {missing[:5]}')
    if extra:
        problems.append(f'想定外のファイル {len(extra)} 個: {extra[:5]}')
    bad, seen, dups = [], {}, []
    for f in files:
        im = cv2.imread(os.path.join(src, f), cv2.IMREAD_UNCHANGED)
        if im is None or im.shape[:2] != (1024, 576) or im.ndim != 3 or im.shape[2] != 4:
            bad.append(f)
            continue
        h = hashlib.sha1(im.tobytes()).hexdigest()
        if h in seen:
            dups.append(f'{seen[h]} = {f}')
        seen[h] = f
    if bad:
        problems.append(f'576×1024 RGBA でない画像 {len(bad)} 枚: {bad[:5]}')
    if dups:
        problems.append(f'同じ画素の画像（重複）{len(dups)} 組: {dups[:5]}')
    ts = os.path.join(src, 'timestamps.csv')
    times = {}
    if not os.path.exists(ts):
        problems.append('timestamps.csv がありません')
    else:
        sys.path.insert(0, HERE)
        from prepare_frames import read_timestamps
        times = read_timestamps(src)
        if sorted(times) != want:
            problems.append(f'timestamps.csv のファイル名が画像と一致しません（{len(times)} 行）')
        else:
            t = [times[f] for f in want]
            off = [f'{f}={times[f]}' for k, f in enumerate(want) if abs(times[f] - k * interval) > 0.011]
            if any(b <= a for a, b in zip(t, t[1:])):
                problems.append('timestamps.csv の時刻が増加していません（重複・逆順）')
            if off:
                problems.append(f'0.2 秒間隔から 0.01 秒以上ずれた時刻 {len(off)} 個: {off[:5]}（時刻は timestamps.csv を優先して使う）')
    return files, problems, times


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--zip')
    g.add_argument('--download', metavar='DRIVE_FILE_ID')
    ap.add_argument('--model', help='pose_landmarker_heavy.task（関節の測定。打撃点の比較に必要）')
    ap.add_argument('--out', default=os.path.join(ROOT, 'assets', 'seipai'))
    ap.add_argument('--report', default=os.path.join(ROOT, 'source', 'ingest_report'))
    ap.add_argument('--rebuild-chart', action='store_true')
    a = ap.parse_args()
    os.makedirs(os.path.join(ROOT, 'source'), exist_ok=True)
    zp = a.zip or download(a.download, os.path.join(ROOT, 'source', 'seipai_transparent_412frames.zip'))
    dest = os.path.join(ROOT, 'source', 'seipai_transparent_zip')
    with zipfile.ZipFile(zp) as z:
        bad = z.testzip()
        if bad:
            raise SystemExit(f'ZIP が壊れています: {bad}')
        z.extractall(dest)
    src = next((os.path.join(d, '') for d, _, fs in os.walk(dest) if 'frame_0000.png' in fs), None)
    if not src:
        raise SystemExit('ZIP の中に frame_0000.png が見つかりません')
    files, problems, _ = check_frames(src)
    print('検査:', '問題なし' if not problems else '\n  '.join(problems))
    # 時刻のずれは警告（timestamps.csv の値で動く）。それ以外は止める
    if [p for p in problems if '0.2 秒間隔から' not in p]:
        raise SystemExit(1)
    os.makedirs(a.report, exist_ok=True)
    before = os.path.join(a.out, 'manifest.json')
    if os.path.exists(before):
        import shutil
        shutil.copyfile(before, os.path.join(a.report, 'manifest_before.json'))
    cmd = [sys.executable, os.path.join(HERE, 'prepare_frames.py'), '--src', src, '--out', a.out]
    if a.model:
        cmd += ['--model', a.model]
    subprocess.run(cmd, check=True)
    M = json.load(open(os.path.join(a.out, 'manifest.json')))
    os.makedirs(a.report, exist_ok=True)
    F = M['frames']
    # 時刻
    t = np.array([f['t'] for f in F])
    dt = np.diff(t)
    # 倍率
    k = np.array([f['k'] for f in F])
    jump = np.abs(np.diff(k) / k[:-1])
    with open(os.path.join(a.report, 'scale.csv'), 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['frame', 't', 'k', 'change_from_prev', 'anchor_from', 'debris_removed'])
        for i, f in enumerate(F):
            w.writerow([i, f['t'], f['k'], round(float(jump[i - 1]), 4) if i else 0, f['anchorFrom'], f['debris']])
    # 中央配置の一覧
    TW, TH = 120, 210
    tiles = []
    for f in F[::2]:
        im = cv2.imread(os.path.join(a.out, f['file']), cv2.IMREAD_UNCHANGED)
        x, y, w_, h_ = f['crop']
        s = 0.5 * TH * f['k']
        Mx = np.array([[s, 0, TW / 2 - (f['anchor'][0] - x) * s], [0, s, TH / 2 - (f['anchor'][1] - y) * s]], np.float32)
        o = cv2.warpAffine(im, Mx, (TW, TH), flags=cv2.INTER_AREA, borderValue=(0, 0, 0, 0))
        al = o[..., 3:4] / 255
        tile = (o[..., :3] * al + np.array([70, 50, 40]) * (1 - al)).astype(np.uint8)
        cv2.line(tile, (TW // 2, 0), (TW // 2, TH), (90, 90, 90), 1)
        cv2.line(tile, (0, TH // 2), (TW, TH // 2), (90, 90, 90), 1)
        cv2.putText(tile, str(f['i']), (3, 12), 0, 0.35, (0, 255, 255), 1)
        tiles.append(tile)
    while len(tiles) % 16:
        tiles.append(np.zeros_like(tiles[0]))
    cv2.imwrite(os.path.join(a.report, 'centered.jpg'), np.vstack([np.hstack(tiles[i:i + 16]) for i in range(0, len(tiles), 16)]), [cv2.IMWRITE_JPEG_QUALITY, 85])
    # 譜面の A の打撃点と新しい関節の比較
    chart = json.load(open(os.path.join(ROOT, 'charts', 'seipai.json')))
    sys.path.insert(0, os.path.join(ROOT, 'tools', 'chart'))
    import build_initial_chart as bic
    rows, cells = [], []
    for n in chart['notes']:
        if n['button'] != 'A' or not n.get('effect', {}).get('anchor'):
            continue
        fi = min(len(F) - 1, int(round(n['time'] / M['frameIntervalSeconds'])))
        new = bic.effect_for(F[fi], n['action'], n['time'])
        cur = n['effect']['anchor']
        d = None
        if new.get('anchor'):
            d = float(np.hypot((cur['x'] - new['anchor']['x']) * M['width'], (cur['y'] - new['anchor']['y']) * M['height']))
        rows.append([n['id'], n['time'], n['action'], cur['x'], cur['y'], new.get('anchor', {}).get('x'), new.get('anchor', {}).get('y'), None if d is None else round(d, 1)])
        im = cv2.imread(os.path.join(src, f'frame_{fi:04d}.png'), cv2.IMREAD_UNCHANGED)
        al = im[..., 3:4] / 255
        g2 = (im[..., :3] * al + 90 * (1 - al)).astype(np.uint8)
        cx, cy = int(cur['x'] * M['width']), int(cur['y'] * M['height'])
        cv2.circle(g2, (cx, cy), 12, (0, 0, 255), 3)  # 赤 = 譜面の現在値
        if new.get('anchor'):
            nx, ny = int(new['anchor']['x'] * M['width']), int(new['anchor']['y'] * M['height'])
            cv2.circle(g2, (nx, ny), 8, (0, 255, 0), 3)  # 緑 = 新しい関節から
        bx, by, bw, bh = F[fi]['bbox']
        c = g2[max(0, by - 40):by + bh + 20, max(0, bx - 60):bx + bw + 60]
        c = cv2.resize(c, (int(c.shape[1] * 300 / c.shape[0]), 300))
        cv2.putText(c, f"{n['id']} {n['time']}s {'' if d is None else f'{d:.0f}px'}", (4, 16), 0, 0.45, (255, 255, 0), 1)
        cells.append(c)
    with open(os.path.join(a.report, 'anchors.csv'), 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['note', 'time', 'action', 'chart_x', 'chart_y', 'joints_x', 'joints_y', 'diff_px'])
        w.writerows(rows)
    if cells:
        W = max(c.shape[1] for c in cells)
        cells = [np.pad(c, ((0, 0), (0, W - c.shape[1]), (0, 0))) for c in cells]
        while len(cells) % 6:
            cells.append(np.zeros_like(cells[0]))
        cv2.imwrite(os.path.join(a.report, 'anchors.jpg'), np.vstack([np.hstack(cells[i:i + 6]) for i in range(0, len(cells), 6)]))
    far = [r for r in rows if r[-1] is not None and r[-1] > 25]
    # 作り直し前の manifest（代用素材など）との差: 人物の中心（直立身長比）と倍率
    diff_lines = []
    mb = os.path.join(a.report, 'manifest_before.json')
    if os.path.exists(mb):
        B = json.load(open(mb))
        if len(B['frames']) == len(F):
            with open(os.path.join(a.report, 'manifest_diff.csv'), 'w', newline='') as fh:
                w = csv.writer(fh)
                w.writerow(['frame', 'anchor_shift_standing_heights', 'scale_ratio_new_over_old'])
                sh, sr = [], []
                for f0, f1 in zip(B['frames'], F):
                    d_ = float(np.hypot(f1['anchor'][0] - f0['anchor'][0], f1['anchor'][1] - f0['anchor'][1]) * f1['k'])
                    r_ = f1['k'] / f0['k']
                    sh.append(d_); sr.append(r_)
                    w.writerow([f1['i'], round(d_, 4), round(r_, 4)])
            diff_lines.append(f'- 作り直し前（{B.get("source", "?")}）との差: 人物の中心のずれ 中央値 {np.median(sh):.3f}・最大 {max(sh):.3f}（直立身長比）、'
                              f'倍率の比 {min(sr):.3f}〜{max(sr):.3f}（manifest_diff.csv）')
    # 譜面は書き換えず、打撃点を新しい関節で置き換えた案を別ファイルに出す
    prop = json.loads(json.dumps(chart))
    for n in prop['notes']:
        if n['button'] == 'A':
            fi = min(len(F) - 1, int(round(n['time'] / M['frameIntervalSeconds'])))
            e = bic.effect_for(F[fi], n['action'], n['time'])
            if e.get('anchor'):
                n['effect'] = {**n.get('effect', {}), 'anchor': e['anchor'], 'direction': e['direction']}
    json.dump(prop, open(os.path.join(a.report, 'proposed_chart.json'), 'w'), ensure_ascii=False, indent=2)
    ov = chart.get('display', {}).get('frameOverrides', {})
    if ov:
        diff_lines.append(f'- 譜面にコマ単位の補正が {len(ov)} コマあります（{", ".join(list(ov)[:10])}）。素材が変わったので、編集モードで見直してください（自動では変更しません）')
    lines = ['# 提供 ZIP の取り込み結果', '',
             f'- 画像: {len(files)} 枚、時刻 {t[0]:.3f}〜{t[-1]:.3f} 秒、間隔 {dt.min():.3f}〜{dt.max():.3f} 秒（{M["timesFrom"]}）',
             f'- 人物の中心: 関節から {sum(f["anchorFrom"] == "joints" for f in F)} 枚 / アルファから {sum(f["anchorFrom"] == "alpha" for f in F)} 枚',
             f'- 離れた塊（ゴミ・文字・反射）を除いたコマ: {sum(f["debris"] > 0 for f in F)} 枚',
             f'- 倍率の隣のコマとの差: 最大 {jump.max() * 100:.1f}%（5% 未満が目安）',
             f'- 収める範囲（直立身長比）: {M["fitExtents"]}',
             f'- A の打撃点: {len(rows)} 個中、新しい関節と 25px 以上ずれているもの {len(far)} 個 → {", ".join(r[0] for r in far) or "なし"}',
             *diff_lines,
             '- 譜面（charts/seipai.json）とブラウザに自動保存された編集内容は変更していません。打撃点を新しい関節で置き換えた案: proposed_chart.json'
             '（編集モードの「JSON を読み込む」で確認・採用できます）',
             '', '確認画像: centered.jpg（中央配置と大きさ）、anchors.jpg（赤 = 譜面の現在値、緑 = 新しい関節）']
    open(os.path.join(a.report, 'report.md'), 'w').write('\n'.join(lines) + '\n')
    print('\n'.join(lines))
    if a.rebuild_chart:
        subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'chart', 'build_initial_chart.py'), '--manifest',
                        os.path.join(a.out, 'manifest.json'), '--out', os.path.join(ROOT, 'charts', 'seipai.json')], check=True)


if __name__ == '__main__':
    main()
