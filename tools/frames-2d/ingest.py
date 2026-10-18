"""提供 ZIP（背景透過の連続画像 PNG と timestamps.csv）を取り込み、ゲーム用素材を作り直して確認用の画像を出す。

  python tools/frames-2d/ingest.py --zip source/<素材>.zip --video source/<元動画>.mp4 --model pose_landmarker_heavy.task
  python tools/frames-2d/ingest.py --download 1Mt_DYiGNyEWi5bpO2JASFXAEe5r0LSWZ --model ...   （drive.google.com に接続できる環境のみ）

手順:
 1. ZIP を source/seipai_transparent_zip/ に展開（元の ZIP は変更しない）
 2. 検査: timestamps.csv の行と PNG の一致（欠落・重複・連番）、寸法・アルファ、時刻の単調増加と間隔（枚数・間隔は決め打ちしない）
 3. prepare_frames.py で assets/seipai/（manifest.json・cut/*.webp）を作り直す（代用素材の値は使わない）
 4. 確認用の出力（--report、既定 source/ingest_report/）:
    - centered.jpg   … 全コマを胴体の中心・補正済みの倍率で並べた一覧（中央からの流れ・脈打ちの確認）
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


def sha256_file(p):
    import hashlib
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


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


def read_rows(src):
    """timestamps.csv を行ごとに読む（同じファイル名の重複も検出するため辞書にしない）。"""
    import csv as _csv
    with open(os.path.join(src, 'timestamps.csv'), newline='', encoding='utf-8-sig') as f:
        rows = [r for r in _csv.reader(f) if r]
    head = [h.strip().lower() for h in rows[0]]
    fcol = next((i for i, h in enumerate(head) if 'file' in h or 'name' in h), None)
    tcol = next((i for i, h in enumerate(head) if 'time' in h), None)
    scol = next((i for i, h in enumerate(head) if 'source' in h), None)
    if fcol is None or tcol is None:
        raise SystemExit(f'timestamps.csv にファイル名・時刻の列がありません: {rows[0]}')
    return [(os.path.basename(r[fcol].strip()), float(r[tcol]), int(r[scol]) if scol is not None and r[scol].strip() else None) for r in rows[1:]]


def check_frames(src):
    """枚数は決め打ちしない。timestamps.csv の行と PNG を突き合わせ、欠落・重複・連番・寸法・時刻を検査する。
    戻り値の info に、実際の枚数・時刻の範囲・間隔（中央値・最小・最大）を入れる。矛盾は推測で埋めずに problems へ。"""
    import hashlib
    files = sorted(f for f in os.listdir(src) if f.lower().endswith('.png'))
    problems, info = [], {}
    if not os.path.exists(os.path.join(src, 'timestamps.csv')):
        return files, ['timestamps.csv がありません（時刻を推測しないため止めます）'], info
    rows = read_rows(src)
    names = [r[0] for r in rows]
    dupn = sorted({n for n in names if names.count(n) > 1})
    if dupn:
        problems.append(f'timestamps.csv に同じファイル名の行が重複 {len(dupn)} 個: {dupn[:5]}')
    if set(names) != set(files):
        problems.append(f'timestamps.csv（{len(names)} 行）と PNG（{len(files)} 枚）が一致しません: '
                        f'CSV だけ {sorted(set(names) - set(files))[:5]}、PNG だけ {sorted(set(files) - set(names))[:5]}')
    want = [f'frame_{k:04d}.png' for k in range(len(rows))]
    if names != want:
        problems.append(f'ファイル名が frame_0000 からの連番・順番になっていません（例: {[n for n, w in zip(names, want) if n != w][:3]}）')
    t = [r[1] for r in rows]
    if any(b <= a for a, b in zip(t, t[1:])):
        problems.append('timestamps.csv の時刻が単調に増えていません（重複・逆順）')
    sf = [r[2] for r in rows]
    if all(v is not None for v in sf) and any(b <= a for a, b in zip(sf, sf[1:])):
        problems.append('source_frame_index が単調に増えていません')
    d = np.diff(t) if len(t) > 1 else np.array([0.0])
    info = {'count': len(rows), 't_first': t[0], 't_last': t[-1], 'interval_median': float(np.median(d)),
            'interval_min': float(d.min()), 'interval_max': float(d.max()),
            'source_frames': [sf[0], sf[-1]] if sf[0] is not None else None}
    irregular = [f'{names[k + 1]}（{d[k]:.3f} 秒）' for k in range(len(d)) if abs(d[k] - info['interval_median']) > 0.011]
    if irregular:
        problems.append(f'間隔が中央値 {info["interval_median"]:.3f} 秒から外れる箇所 {len(irregular)} 個: {irregular[:5]}（timestamps.csv の値で動きます）')
    bad, seen, dups, digests = [], {}, [], {}
    for f in files:
        raw = open(os.path.join(src, f), 'rb').read()
        digests[f] = hashlib.sha256(raw).hexdigest()
        im = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_UNCHANGED)
        if im is None or im.ndim != 3 or im.shape[2] != 4:
            bad.append(f)
            continue
        info.setdefault('size', [im.shape[1], im.shape[0]])
        if [im.shape[1], im.shape[0]] != info['size']:
            bad.append(f)
        h = hashlib.sha1(im.tobytes()).hexdigest()
        if h in seen:
            dups.append(f'{seen[h]} = {f}')
        seen[h] = f
    if bad:
        problems.append(f'アルファ付きで寸法がそろっていない画像 {len(bad)} 枚: {bad[:5]}')
    if dups:
        problems.append(f'同じ画素の画像（重複）{len(dups)} 組: {dups[:5]}')
    info['sha256'] = digests
    return files, problems, info


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--zip')
    g.add_argument('--download', metavar='DRIVE_FILE_ID')
    ap.add_argument('--model', help='pose_landmarker_heavy.task（関節の測定。打撃点の比較に必要）')
    ap.add_argument('--out', default=os.path.join(ROOT, 'assets', 'seipai'))
    ap.add_argument('--report', default=os.path.join(ROOT, 'source', 'ingest_report'))
    ap.add_argument('--video', help='素材の元動画（全体の長さを測る。素材と同じ動画であること）')
    ap.add_argument('--duration', type=float, help='全体の長さ（秒）。--video が無いときに必須')
    ap.add_argument('--rebuild-chart', action='store_true')
    a = ap.parse_args()
    os.makedirs(os.path.join(ROOT, 'source'), exist_ok=True)
    zp = a.zip or download(a.download, os.path.join(ROOT, 'source', 'seipai_transparent_412frames.zip'))
    # ZIP ごとに新しいフォルダへ展開する（前回の展開物を拾わない）
    zsha = sha256_file(zp)
    dest = os.path.join(ROOT, 'source', 'ingest_extract_' + zsha[:12])
    if os.path.exists(dest):
        import shutil
        shutil.rmtree(dest)
    with zipfile.ZipFile(zp) as z:
        bad = z.testzip()
        if bad:
            raise SystemExit(f'ZIP が壊れています: {bad}')
        z.extractall(dest)
    cands = [d for d, _, fs in os.walk(dest) if 'frame_0000.png' in fs]
    if len(cands) != 1:
        raise SystemExit(f'ZIP の中の連続画像のフォルダが {len(cands)} 個あります（1 個のはず）: {cands[:3]}')
    src = os.path.join(cands[0], '')
    print('展開先:', src)
    files, problems, info = check_frames(src)
    print(f'素材: PNG {len(files)} 枚、timestamps.csv {info.get("count")} 行、時刻 {info.get("t_first")}〜{info.get("t_last")} 秒、'
          f'間隔 中央値 {info.get("interval_median", 0):.3f}（{info.get("interval_min", 0):.3f}〜{info.get("interval_max", 0):.3f}）、寸法 {info.get("size")}')
    print('検査:', '問題なし' if not problems else '\n  '.join(problems))
    # 間隔のばらつきは警告（timestamps.csv の値で動く）。それ以外の矛盾は推測で埋めずに止める
    if [p for p in problems if '間隔が中央値' not in p]:
        raise SystemExit(1)
    if not (a.video or a.duration):
        raise SystemExit('全体の長さを決めるため --video（元動画）か --duration を指定してください（推測しません）')
    os.makedirs(a.report, exist_ok=True)
    # 素材の識別情報（別の環境で同じ公開用ビルドを再現するため）
    json.dump({'zip': os.path.basename(zp), 'zip_sha256': sha256_file(zp), 'frames': info['count'],
               'time_range': [info['t_first'], info['t_last']], 'interval_median': info['interval_median'],
               'png_sha256': info['sha256'], 'video': a.video and os.path.basename(a.video),
               'video_sha256': a.video and sha256_file(a.video)},
              open(os.path.join(a.report, 'material.json'), 'w'), ensure_ascii=False, indent=1)
    os.makedirs(a.report, exist_ok=True)
    before = os.path.join(a.out, 'manifest.json')
    if os.path.exists(before):
        import shutil
        shutil.copyfile(before, os.path.join(a.report, 'manifest_before.json'))
    cmd = [sys.executable, os.path.join(HERE, 'prepare_frames.py'), '--src', src, '--out', a.out]
    cmd += ['--video', a.video] if a.video else ['--duration', str(a.duration)]
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
