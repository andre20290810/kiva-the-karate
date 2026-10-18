# character-2d — ALEXANDRE 2D FRAME ANIMATION（パラパラ漫画方式、PREVIEW）

KIVA のセーパイ 412 コマ（5fps）の姿勢に合わせて、ALEXANDRE の直立 360° 回転画像を 2D 変形した 412 枚を作る。
3D モデルは使わない。顔だけの差し替えでもない（全身を変形して描き直す）。順番と時刻は KIVA と同じ。

| 手順 | 内容 |
| --- | --- |
| 参照 | 回転動画の全コマ（361 枚、白背景）を MediaPipe で姿勢・体の向き（yaw）を測る |
| KIVA | 412 コマの姿勢（2D 関節）・体の向き・推定 3D（腕が体の前か後ろか）を測る |
| `puppet_warp.py` | 各コマ: 向きが最も近い参照コマを選び、部位ごとの重み付きメッシュを KIVA の骨格へ変形（骨の長さは ALEXANDRE の比率）。腕は前後で描き分け、2 倍で描いて縮小 |
| `compare_sheet.py` | 代表コマの比較シート（KIVA 元画像 / 使った参照 / 生成 / KIVA の背景に重ねたもの） |
| `package_frames.py` | ゲーム用: `assets/alexandre/frames.json`、`frames/*.webp`（ゲームが読む）、`png/*.png`（透過 PNG 原本）、`reference_angles.md/.csv` |

```bat
python tools\character-2d\puppet_warp.py --ref-dir ref --ref-pose ref_pose.json --kiva-pose kiva_pose.json --out gen
python tools\character-2d\package_frames.py --gen gen --kiva-pose kiva_pose.json --out assets\alexandre --kiva-frames-json assets\seipai\frames.json
```
`--kiva-frames-json` で KIVA の frames.json の時刻をそのまま写す（ゲームは基準と 0.001 秒以上ずれた列を使わない）。

**限界**: 参照は直立・腕を下ろした姿なので、大きな姿勢（横向きの構え、深い構え、蹴り）ではコートや髪が引き伸ばされ、
参照に写っていない面（上げた脚の裏・腕の内側）は作れない。本当に描き直すには、姿勢を条件にした画像生成
（ControlNet OpenPose ＋ 参照画像、または参照画像と姿勢列から動画を作るモデル）が必要で、GPU が要る。
