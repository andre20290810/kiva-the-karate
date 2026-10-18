# character-3d — KIVA / ALEXANDRE の人体モデルとモーション

すべて無料・ローカル（Blender、MakeHuman の CC0 データ、MediaPipe）。動画・画像・生成物はどこにも送信しない。
生成物（`.blend` `.glb` 推定関節 JSON・参照画像）は `assets/` `source/` `prototypes/` に置く（いずれも Git 管理外）。

## 何ができているか（TECH PREVIEW）

| 項目 | 状態 |
| --- | --- |
| 人体メッシュ | MakeHuman CC0 ベースメッシュ（約 13,000 頂点）に体型ターゲットを適用。棒人間ではない連続した人体 |
| 骨格・スキン | MakeHuman の骨格から 76 本（背骨 5・首 3・腕はねじれ分割・指 3 関節）。ウェイトは MakeHuman 由来、1 頂点 4 影響に制限 |
| 衣装（KIVA） | 白い道着（上衣・下衣）・黒帯（結び目と垂れ）・髪（束ねた後ろ髪）。体表から作り、ウェイトを転写 |
| 衣装（ALEXANDRE） | 黒いロングコート（腰から下は一枚の裾、前が開き赤い裏地が見える）・暗色のズボン・銀髪・手袋・ブーツ（材質のみ） |
| 変形確認 | 肘 90°、肩の挙上、騎馬立ち・前屈立ち・膝上げ・180° 向き変え（`pose_tests.py` `deform_anim.py`） |
| モーション | `landmarks_mp.py`（MediaPipe 推定）→ `retarget.py`（骨長固定・時間平滑化・足の接地固定・腰の高さ）→ GLB |

**推定であって測定ではない**: 単眼映像の奥行き・体の回転は推定値。顔の細部・見えない部分は作っていない／推定で補っている。

## PC での手順（Windows、Blender 4.2 以降）

```bat
cd C:\Users\admin\Desktop\PRVT\GAME\kiva-the-karate
rem 1) MakeHuman のデータ（CC0）: https://github.com/makehumancommunity/makehuman の makehuman\data
set MH=C:\path\to\makehuman\makehuman\data
rem 2) 人体モデル
blender -b -P tools\character-3d\build_character.py -- --mh %MH% --out source\character-3d --variant kiva
blender -b -P tools\character-3d\build_character.py -- --mh %MH% --out source\character-3d --variant alexandre
rem 3) セーパイの推定関節（Python 3.11 以降 + pip install mediapipe opencv-python numpy pillow）
rem    モデル: https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task
python tools\character-3d\landmarks_mp.py --model pose_landmarker_heavy.task --video source\seipai.mp4 --out source\character-3d\seipai_lm.json
rem 4) 骨格へ転写して GLB（GLB の 0 秒 = 動画の 0 秒）
blender -b -P tools\character-3d\retarget.py -- --blend source\character-3d\kiva_body.blend --lm source\character-3d\seipai_lm.json --out source\character-3d\kiva --fps 30 --glb assets\3d\kiva_seipai.glb
blender -b -P tools\character-3d\retarget.py -- --blend source\character-3d\alexandre_body.blend --lm source\character-3d\seipai_lm.json --out source\character-3d\alexandre --fps 30 --glb assets\3d\alexandre_seipai.glb
rem 5) 確認（28.2〜33.6 秒を重点的に）: npm start → node tests\capture-3d.mjs --variant kiva-3d --from 28.2 --to 33.6 --out source\check_28-33.mp4
rem 6) node tools\build-dist.mjs で dist\assets\3d\ に入る
```

`--start/--end` を付けると区間だけ推定できる（短い区間で先に確認する場合）。ALEXANDRE は KIVA と同じ骨格名なので、同じ推定関節をそのまま転写できる（体格差は骨長固定で吸収）。

## 確認用（このリポジトリの開発環境で実行したもの）

- `pose_tests.py` … 確認姿勢の .blend を作る → `render_views.py` で描画
- `deform_anim.py` … 肩・肘・膝・腰の変形確認アニメーション
- `demo_motion.py` … 補助動画（突きの型）の 12 枚から推定した姿勢と確認姿勢をつないだデモ（**セーパイではない**）。
  セーパイの GLB を作るまでの間、ゲームの 3D 表示・エフェクトの確認に使う
- `test_motion_filter.py` … 骨長固定・接地・足滑り抑制の検査（Blender 不要）
