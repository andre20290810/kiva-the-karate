# ALEXANDRE スプライトの画像生成（ControlNet OpenPose ＋ IP-Adapter）— 実行手順

**状態（2026-10-18）: 実画像はまだ 1 枚も生成していない。** 開発用クラウド環境は huggingface.co への接続がネットワーク設定で拒否され、
モデルの重みを取得できないため。道具は乱数の極小モデル（`--dry-run`）で、切り出し → 生成 → 透過 → 元の位置へ戻す流れだけ確認済み。

## 流れ
| 段階 | 道具 | 内容 |
|---|---|---|
| 1 姿勢 | `kiva_pose.py` | セーパイ元動画の MediaPipe 結果から、412 コマ（各時刻）の KIVA の関節と元画像。想像の姿勢は使わない |
| 2 制御画像 | `make_controls.py` | OpenPose 形式の骨格画像。代表 10 コマ = 0, 120, 121, 180, 285, 296, 300, 308, 330, 337 |
| 3 外見 | `make_refs.py` | 顔の主基準 D01/D02、向き別の全身 9 枚（10_front_return は使わない）、画風（alexandre_sprites の 1 体） |
| 4 生成 | `gen_sprites.py` | 全コマで同じ文章・seed・参考画像。KIVA の人物の周りを切り出して生成し、576×1024 の同じ位置・倍率に戻す。緑背景を抜いて透過 PNG |
| 5 姿勢検査 | `pose_qc.py` | 生成画像の関節を測り、KIVA と比較（位置・左右・曲がり・向き・足元）。比較シート qc_sheet.jpg |
| 6 目視 | qc_sheet.jpg / プレビュー | 顔・髪・衣装の同一性、指・脚の本数を目で確認して qc.json の manual に記入 |
| 7 412 枚 | `gen_sprites.py --frames 0-411 --skip-existing` | 10 枚が合格してから |
| 8 ちらつき | `flicker_qc.py` | 隣のコマとの顔・髪・衣装の色の割合の急変を挙げる |
| 9 プレビュー | `make_preview.py` | ゲームとは別のローカル HTML（並べて再生） |
| 10 ゲーム | `package_frames.py` | `assets/alexandre/`（frames.json の時刻は KIVA の frames.json から写す） |

## 実行（huggingface.co に接続でき、Python 3.10 以降がある環境）
```bash
python -m venv .venv-gen && . .venv-gen/bin/activate          # Windows: .venv-gen\Scripts\activate
pip install torch diffusers transformers accelerate safetensors huggingface_hub opencv-python-headless pillow numpy mediapipe
python tools/character-2d/fetch_models.py --out models --profile sd15
python tools/character-2d/make_refs.py --pack source/character-reference-video --style source/alexandre_sprites_style.webp --out work/refs
python tools/character-2d/make_controls.py --kiva-pose work/kiva_pose.json --kiva-dir work/kiva --out work/controls10 --frames 0,120,121,180,285,296,300,308,330,337
cd tools/character-2d
python gen_sprites.py --models ../../models --profile sd15 --kiva-pose ../../work/kiva_pose.json --refs ../../work/refs/refs.json \
  --frames 0,120,121,180,285,296,300,308,330,337 --out ../../work/gen10            # GPU なら --device cuda
python pose_qc.py --model pose_landmarker_heavy.task --kiva-pose ../../work/kiva_pose.json --kiva-dir ../../work/kiva \
  --controls ../../work/controls10 --gen ../../work/gen10 --frames 0,120,121,180,285,296,300,308,330,337 --label "sd15 seed1234" --out ../../work/qc10
python make_preview.py --gen ../../work/gen10 --kiva-dir ../../work/kiva --controls ../../work/controls10 --qc ../../work/qc10/qc.json \
  --frames 0,120,121,180,285,296,300,308,330,337 --out ../../work/preview10
```

## 所要時間の目安（未計測。生成していないため推定）
| 環境 | sd15（512×768、28 段） | sdxl（832×1216） |
|---|---|---|
| CPU 4 コア（開発用クラウド） | 1 枚 1〜3 分 → 10 枚 15〜30 分、412 枚 7〜20 時間 | 1 枚 10 分以上（非推奨） |
| GPU（VRAM 8〜12 GB） | 1 枚 5〜10 秒 | 1 枚 15〜30 秒 |
Intel UHD（内蔵 GPU）では CUDA が使えないため CPU と同じ扱い。

## 10 枚が不合格だったときの見直し順
1. 姿勢: `--cn-scale` を 1.0 → 1.3。左右の取り違えは制御画像の左右の色で決まるので、KIVA の関節の左右（kiva_pose.json）を先に確認
2. 同一人物: `--ip-scale` 0.7 → 0.85、参考画像の組（make_refs の --style-pick、顔の主基準のみ）を変えて比較
3. それでも顔・衣装が揺れる場合: 参考画像（全身 9 枚＋顔 8 枚＋画風 10 体）で LoRA を学習（GPU で 20〜40 分）し、`gen_sprites.py` に読み込む
4. 画風を alexandre_sprites に寄せる: `--profile sdxl`（GPU）
