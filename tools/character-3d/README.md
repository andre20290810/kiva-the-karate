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

## v4（2026-10-18 後半）: ALEXANDRE の参照に基づく造形と、セーパイ実動画での比較

入力: `CLAUDE_KIVA_ALEXANDRE_INPUTS_20261018.zip`（非公開。リポジトリ・公開サイトに置かない）
- `alexandre_parts.py` … 立ち襟・ラペル・前開き・背中スリット付きの裾・赤い裏地・腰の革紐・袖口のカフ・ベスト・
  白いシャツ・ベルト・膝下ブーツ（胴）と靴（断面の積み重ねで作った閉じた形）・手袋・長い銀髪（後ろへ流した頭の土台、
  耳の後ろから腰まで一続きの髪の量感＋毛筋、顔の両脇の毛束、ハーフアップの結び目）
- `silhouette_compare.py` … 白背景の回転動画と、同じ向きのモデル描画の輪郭を身長でそろえて重ねる
- ALEXANDRE の顔は提供静止画（正面）と回転動画 0.5 s に合わせ、2.0 s・斜めの肖像・全身画は評価だけに使う
- デモ動作の GLB は `*_demo.glb`（`demo_motion.py` は `*_seipai.glb` への書き出しを拒否する）

```bat
rem ALEXANDRE（顔の合わせ込み用の土台 → 顔 → 本体）
set KEEP_FEET=1
blender -b -P tools\character-3d\build_character.py -- --mh %MH% --out base --variant alexandre --fit alex_fit.json
set KEEP_FEET=
blender -b -P tools\character-3d\face_fit.py -- --blend base\alexandre_body.blend --ref face_fit_ref.json --model face_landmarker.task --mh %MH% --out alex_face_offsets.npy --iters 4
blender -b -P tools\character-3d\build_character.py -- --mh %MH% --out source\character-3d --variant alexandre --fit alex_fit.json --face-offsets alex_face_offsets.npy
rem セーパイ同時刻比較（正面＝カメラ一致、横＝奥行き確認）
node tests\capture-3d.mjs --variant kiva-3d --from 28.2 --to 33.6 --fps 30 --size 576x1024 --no-fx --keep-frames --out cmp\front.mp4
node tests\capture-3d.mjs --variant kiva-3d --from 28.2 --to 33.6 --fps 30 --size 576x1024 --no-fx --yaw 90 --keep-frames --out cmp\side.mp4
python tools\character-3d\motion_compare.py --lm seipai_lm.json --rest rest_joints.json --video source\seipai.mp4 --from 28.2 --to 33.6 --render-dir cmp\front.mp4.frames cmp\side.mp4.frames --render-labels "3D front" "3D side" --out cmp\frames
```

## v3（2026-10-18）: 参照画像の測定に基づく造形と、動きの検証道具

| 道具 | 内容 |
| --- | --- |
| `face_landmarks.py` / `face_metrics.py` | 参照画像の顔 478 点（MediaPipe Face Landmarker）を頭の向きを除いた正準空間で測り、輪郭・目・鼻・口・顎の比率を出す |
| `face_fit.py` | モデルの顔を同じ検出器で測り、差をガウス RBF で頭部メッシュに反映（左右対称・反復・減衰）。出力は頂点ごとの変位 |
| `body_metrics.py` | 全身の 2D 比率（肩幅・腰幅・胴・大腿・下腿・頭）。`--fit` の計測ターゲットの重みを決めるのに使う |
| `build_character.py --face-offsets --fit` | 上の 2 つを反映して組み立てる |
| `motion_qc.py` | 左右ラベルの取り違え・手足の奥行き反転・胴体の前後取り違えの修正、跳びの検出、2D 再投影誤差と原因の目安 |
| `motion_compare.py` | 元映像（動画の区間 or 静止画）と 3D を同じ時刻で並べ、誤差を metrics.json に出す |
| `extract_reference_frames.py` | 参照動画から正面・斜め・側面・全身の高画質フレームを選んで書き出す（動画 ID・時刻を記録） |
| `mesh_compare.py` | 画像→3D の AI ツールの出力などを、同じ物差しで採否判定（`IMAGE_TO_3D.md`） |

KIVA v3 の組み立て:
```bat
python tools\character-3d\face_landmarks.py --model face_landmarker.task --images （正面フレーム）... --pose-json tsuki_lm.json --out face_ref.json
blender -b -P tools\character-3d\build_character.py -- --mh %MH% --out base --variant kiva --fit kiva_fit.json
blender -b -P tools\character-3d\face_fit.py -- --blend base\kiva_body.blend --ref face_ref.json --model face_landmarker.task --mh %MH% --out kiva_face_offsets.npy --iters 5
blender -b -P tools\character-3d\build_character.py -- --mh %MH% --out source\character-3d --variant kiva --face-offsets kiva_face_offsets.npy --fit kiva_fit.json
```

セーパイの同一時刻比較（28.2〜33.6 秒）:
```bat
python tools\character-3d\landmarks_mp.py --model pose_landmarker_heavy.task --video source\seipai.mp4 --out seipai_lm.json
blender -b -P tools\character-3d\retarget.py -- --blend source\character-3d\kiva_body.blend --lm seipai_lm.json --out source\character-3d\kiva --fps 30 --glb assets\3d\kiva_seipai.glb
rem motion_qc.json（修正した取り違え・反転、跳び）と rest_joints.json が出る
npm start
node tests\capture-3d.mjs --variant kiva-3d --from 28.2 --to 33.6 --fps 30 --size 576x1024 --keep-frames --out source\cmp\3d.mp4
python tools\character-3d\motion_compare.py --lm seipai_lm.json --rest source\character-3d\kiva\rest_joints.json --video source\seipai.mp4 --from 28.2 --to 33.6 --render-dir source\cmp\3d.mp4.frames --out source\cmp\side_by_side
ffmpeg -framerate 30 -i source\cmp\side_by_side\%05d.png -c:v libx264 -pix_fmt yuv420p source\cmp\seipai_28-33_compare.mp4
```

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
