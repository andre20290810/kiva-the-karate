"""ゲームとは別に、生成したスプライトを確認するプレビュー（ローカルで開く HTML、公開サイトには置かない）。

  python make_preview.py --gen gen10 --kiva-dir kiva --controls controls10 --qc qc10/qc.json --frames 0,120,... --out preview10
  python make_preview.py --gen gen --kiva-dir kiva --frames 0-411 --out preview_all      （パラパラ再生、5fps）

出力: <out>/index.html と画像（WebP）。index.html をブラウザで開くだけで見られる（通信なし）。
- 一覧: 各コマの KIVA 元動画・姿勢制御・生成（市松模様＝透過の確認）・自動検査の結果
- 再生: KIVA と生成を左右に並べて、KIVA と同じ時刻・同じ 5fps で再生（コマ送り・速度変更あり）
"""
import argparse
import html
import json
import os

import cv2
import numpy as np


def save_webp(img, path, h=512):
    img = cv2.resize(img, (int(img.shape[1] * h / img.shape[0]), h), interpolation=cv2.INTER_AREA)
    cv2.imwrite(path, img, [cv2.IMWRITE_WEBP_QUALITY, 88])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--gen', required=True)
    ap.add_argument('--kiva-dir', required=True)
    ap.add_argument('--controls')
    ap.add_argument('--qc')
    ap.add_argument('--frames', required=True)
    ap.add_argument('--fps', type=float, default=5)
    ap.add_argument('--title', default='ALEXANDRE sprites preview')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    if '-' in a.frames:
        s, e = map(int, a.frames.split('-'))
        frames = list(range(s, e + 1))
    else:
        frames = [int(x) for x in a.frames.split(',')]
    img_dir = os.path.join(a.out, 'img')
    os.makedirs(img_dir, exist_ok=True)
    qc = {r['frame']: r for r in json.load(open(a.qc))['frames']} if a.qc else {}
    items = []
    for i in frames:
        g = os.path.join(a.gen, f'alexandre_frame_{i:04d}.png')
        if not os.path.exists(g):
            continue
        rgba = cv2.imread(g, cv2.IMREAD_UNCHANGED)
        rgba = cv2.resize(rgba, (288, 512), interpolation=cv2.INTER_AREA)
        cv2.imwrite(os.path.join(img_dir, f'gen_{i:04d}.webp'), rgba, [cv2.IMWRITE_WEBP_QUALITY, 90])
        save_webp(cv2.imread(os.path.join(a.kiva_dir, f'kiva_{i:04d}.png')), os.path.join(img_dir, f'kiva_{i:04d}.webp'))
        it = {'i': i, 'gen': f'img/gen_{i:04d}.webp', 'kiva': f'img/kiva_{i:04d}.webp'}
        if a.controls and os.path.exists(os.path.join(a.controls, f'pose_{i:04d}.png')):
            save_webp(cv2.imread(os.path.join(a.controls, f'pose_{i:04d}.png')), os.path.join(img_dir, f'pose_{i:04d}.webp'))
            it['pose'] = f'img/pose_{i:04d}.webp'
        if i in qc:
            it['qc'] = qc[i]['result']
            it['why'] = '; '.join(qc[i].get('reasons', []))
        items.append(it)
    page = TEMPLATE.replace('__TITLE__', html.escape(a.title)).replace('__FPS__', str(a.fps)) \
        .replace('__ITEMS__', json.dumps(items, ensure_ascii=False))
    open(os.path.join(a.out, 'index.html'), 'w').write(page)
    print(len(items), 'frames ->', os.path.join(a.out, 'index.html'))


TEMPLATE = r'''<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root{--bg:#16171b;--fg:#e8e8ec;--mut:#9a9aa6;--ok:#4cc38a;--ng:#ff6b6b;--card:#202127}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;padding:16px}
h1{font-size:18px;margin:0 0 4px}p{color:var(--mut);margin:0 0 16px}
.player{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:20px}
.player img{height:min(60vh,512px);border-radius:6px}
.chk{background:repeating-conic-gradient(#555 0 25%,#777 0 50%) 0 0/16px 16px}
.ctl{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0 20px}
button,select{background:var(--card);color:var(--fg);border:1px solid #444;border-radius:6px;padding:6px 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr));gap:12px}
.card{background:var(--card);border-radius:8px;padding:8px;border:2px solid transparent}
.card.OK{border-color:var(--ok)}.card.NG{border-color:var(--ng)}
.row{display:flex;gap:4px}.row img{width:33%;min-width:0;object-fit:contain;border-radius:4px}
.cap{font-size:12px;color:var(--mut)}.cap b{color:var(--fg)}
</style></head><body>
<h1>__TITLE__</h1>
<p>ゲームとは別の確認用ページ（ローカル）。左: KIVA 元動画、右: 生成した ALEXANDRE（市松模様は透過部分）。</p>
<div class="player"><img id="pk" alt="KIVA"><img id="pg" class="chk" alt="ALEXANDRE"></div>
<div class="ctl"><button id="play">再生</button><button id="prev">◀</button><button id="next">▶</button>
<select id="speed"><option value="1">1×</option><option value="0.5">0.5×</option><option value="0.25">0.25×</option></select>
<span id="info"></span></div>
<div class="grid" id="grid"></div>
<script>
const items=__ITEMS__, fps=__FPS__;
let k=0,timer=null;
const $=id=>document.getElementById(id);
function show(n){k=(n+items.length)%items.length;const it=items[k];$('pk').src=it.kiva;$('pg').src=it.gen;
 $('info').textContent=`コマ ${it.i}（${(it.i/fps).toFixed(1)} 秒）${it.qc?' 自動検査 '+it.qc:''}`;}
function stop(){clearInterval(timer);timer=null;$('play').textContent='再生';}
$('play').onclick=()=>{if(timer){stop();return;}$('play').textContent='停止';
 timer=setInterval(()=>show(k+1),1000/fps/parseFloat($('speed').value));};
$('prev').onclick=()=>{stop();show(k-1)};$('next').onclick=()=>{stop();show(k+1)};
$('speed').onchange=()=>{if(timer){stop();$('play').click();}};
for(const it of items){const d=document.createElement('div');d.className='card '+(it.qc||'');
 d.innerHTML=`<div class="row"><img src="${it.kiva}" alt="">${it.pose?`<img src="${it.pose}" alt="">`:''}<img class="chk" src="${it.gen}" alt=""></div>
 <div class="cap"><b>#${it.i}</b> ${(it.i/fps).toFixed(1)} 秒 ${it.qc?`<b>${it.qc}</b> ${it.why||''}`:''}</div>`;
 d.onclick=()=>{stop();show(items.indexOf(it));window.scrollTo({top:0,behavior:'smooth'});};$('grid').append(d);}
for(const it of items){new Image().src=it.gen;new Image().src=it.kiva;}
show(0);
</script></body></html>
'''

if __name__ == '__main__':
    main()
