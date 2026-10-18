# 素材の準備（2D 版）

README「素材の配置」を参照してください。要点:

1. `seipai_transparent_412frames.zip` を `source/` に展開（`source/seipai_transparent/frame_0000.png` … `frame_0411.png`、`timestamps.csv`）
2. `python tools/frames-2d/prepare_frames.py --src source/seipai_transparent --out assets/seipai --model pose_landmarker_heavy.task`
3. 背景 `IMG_7441.JPG`（横）・`IMG_7439.JPG`（縦）を `assets/stage/` に置く
4. （任意）`sh tools/extract_audio.sh source/seipai.mp4 assets/seipai` で音声
5. `npm start` → http://localhost:8177/

素材はすべて Git 管理外です。公開リポジトリ・公開サイトに元の ZIP や元動画を置かないでください（`dist/` には加工済みの
`assets/seipai/cut/*.webp` と背景・音声だけが入ります）。
