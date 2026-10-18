# 画像 → 3D メッシュの AI ツール（ALEXANDRE / KIVA の造形用）— 検討と PC での試験手順

## この開発環境で試せなかった理由（2026-10-18 確認）
- Hugging Face（モデル重みの配布元）・GitHub のファイル取得・download.pytorch.org がネットワーク方針で拒否される（403）
- GPU なし（CPU 4 コア・メモリ 15 GB）
- ALEXANDRE の参照動画（Google Drive）にも届かない
→ 生成テストは PC で行う。ここでは **生成物を公平に採否判定する道具**（`mesh_compare.py`）と手順を用意した。

## 候補（無料・ローカル実行。必要 VRAM は公開情報からの目安で、PC で要確認）
| ツール | ライセンス | 必要 VRAM（目安） | 人物での期待 |
| --- | --- | --- | --- |
| TripoSR | MIT | 約 6 GB（CPU でも遅いが動く） | 形の大枠のみ。顔の細部は崩れやすい |
| Stable Fast 3D (SF3D) | Stability Community License（収益条件あり） | 約 6 GB | 同上、テクスチャ付き |
| Hunyuan3D-2 mini（形状のみ） | Tencent Hunyuan Community License（地域制限あり） | 約 6 GB | 形状の質は高め。人物の顔の似せは保証なし |
| TRELLIS | MIT | 約 16 GB | 高品質だが重い |
| InstantMesh | Apache-2.0 | 約 16 GB 以上 | 多視点生成を経由 |
| 服を着た人物専用（ECON / ICON / PSHuman 等） | SMPL-X（登録制・非商用）に依存するものが多い | 8〜24 GB | 体型は良いが、ライセンス確認が必要 |

**PC の GPU を最初に確認する**（`nvidia-smi`）。8 GB 未満なら TripoSR / SF3D（CPU）だけを試し、16 GB 以上で TRELLIS を追加する。
実行できない方式には時間を使わない。

## 採否の決め方（どのツールの出力にも同じ物差し）
1. `extract_reference_frames.py` で参照動画から正面・斜め・側面・全身の高画質フレームを選ぶ（動画 ID・時刻を記録）
2. AI ツールに正面全身（または顔）画像を入れてメッシュを作る
3. `face_landmarks.py` で参照の顔の 478 点（複数フレーム）を測り `face_ref.json` を作る
4. `blender -b -P mesh_compare.py -- --mesh 生成物.glb --ref-face face_ref.json --face-model face_landmarker.task --pose-model pose_landmarker_heavy.task --ref-body 参照正面.png --out 判定フォルダ`
5. `mesh_compare.json` の verdict が `reject` なら不採用。`candidate` でも、並べた画像（body_front/oblique/side/back、face_front）を目で見て
   明らかに似ていなければ不採用。採用した場合だけ、骨格の組み込み（MakeHuman 骨格へのウェイト転写）に進む

## 現在の KIVA モデル（v3）をこの物差しで測った結果
- 顔: 10 項目すべて参照の許容範囲内（参照は補助動画の正面 5 フレーム、顔の幅 22〜30 px。検出器が平均顔へ寄る傾向があり、似ている保証ではない）
- 全身: 肩幅・腰幅・胴・大腿・頭〜肩は ±5% 以内、下腿 +5.5%（判定は `reject`）。この 2D 計測の再現性は ±3% 程度で、これ以上は詰められない
- 判定は「比率が合っている」だけで、本人そっくりではない。まぶた・唇・肌の質感・髪の毛束は再現していない
