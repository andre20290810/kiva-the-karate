"""分割して受け取った ZIP（split_zip.ps1 の .part001… や 7-Zip の .001…）を元に戻し、SHA-256 と ZIP の整合を確かめる。

  python tools/frames-2d/join_parts.py --list 受け取り先/seipai_transparent_412frames.zip.sha256.txt --out source/seipai_transparent_412frames.zip
  python tools/frames-2d/join_parts.py --parts a.zip.001 a.zip.002 ... --sha256 <元の ZIP の SHA-256> --out ...

部分が欠けている・順番が違う・中身が壊れている場合は止まる（ZIP は作らない）。成功したら ingest.py --zip で取り込む。
"""
import argparse
import hashlib
import os
import sys
import zipfile


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--list', help='split_zip.ps1 が作った .sha256.txt（部分は同じフォルダから探す）')
    ap.add_argument('--parts', nargs='*')
    ap.add_argument('--sha256', help='元の ZIP の SHA-256（--parts のとき）')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    parts, whole = [], a.sha256
    if a.list:
        base = os.path.dirname(os.path.abspath(a.list))
        for line in open(a.list, encoding='ascii'):
            kind, digest, name, size = line.split()
            if kind == 'whole':
                whole = digest
            else:
                p = os.path.join(base, name)
                if not os.path.exists(p):
                    sys.exit(f'部分が見つかりません: {name}')
                if os.path.getsize(p) != int(size) or sha(p) != digest:
                    sys.exit(f'部分の中身が一致しません（壊れているか別のファイル）: {name}')
                parts.append(p)
    else:
        parts = sorted(a.parts or [])
    if not parts:
        sys.exit('部分がありません')
    tmp = a.out + '.joining'
    with open(tmp, 'wb') as out:
        for p in parts:
            with open(p, 'rb') as f:
                for b in iter(lambda: f.read(1 << 20), b''):
                    out.write(b)
    if whole and sha(tmp) != whole:
        os.remove(tmp)
        sys.exit('結合した ZIP の SHA-256 が元と一致しません（部分の不足・順番違い）')
    try:
        with zipfile.ZipFile(tmp) as z:
            bad = z.testzip()
    except zipfile.BadZipFile as e:
        os.remove(tmp)
        sys.exit(f'ZIP として読めません: {e}')
    if bad:
        os.remove(tmp)
        sys.exit(f'ZIP 内のファイルが壊れています: {bad}')
    os.replace(tmp, a.out)
    print(f'OK: {len(parts)} 個の部分 → {a.out}（{os.path.getsize(a.out) / 1e6:.1f} MB、SHA-256 {"一致" if whole else "未確認"}）')


if __name__ == '__main__':
    main()
