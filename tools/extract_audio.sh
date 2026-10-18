#!/bin/sh
# 元動画から音声トラックを抽出する（曲は差し替えない）。
#   sh tools/extract_audio.sh <元動画> assets/seipai
set -eu
src="$1"; out="${2:-assets/seipai}"
mkdir -p "$out"
echo "== 音声トラックの確認 =="
ffprobe -v error -show_entries stream=index,codec_type,codec_name,sample_rate,channels,duration -of compact "$src"
if ! ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$src" | grep -q .; then
  echo "エラー: 元動画に音声トラックがありません" >&2; exit 1
fi
# iOS Safari・Chrome 用の AAC(m4a)。元が AAC なら再エンコードせずそのまま取り出す（時刻のずれ・劣化なし）
if [ "$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$src")" = aac ]; then
  ffmpeg -v error -y -i "$src" -map 0:a:0 -vn -c:a copy "$out/audio.m4a"
else
  ffmpeg -v error -y -i "$src" -map 0:a:0 -vn -c:a aac -b:a 160k "$out/audio.m4a"
fi
# AAC をデコードできないブラウザ（コーデック無しの Chromium 等）向けの予備（譜面の audio.src で 2 番目に試す）
ffmpeg -v error -y -i "$src" -map 0:a:0 -vn -c:a libopus -b:a 128k -f mp4 "$out/audio_opus.m4a"  # .m4a 既定の ipod 形式は Opus を格納できない
for f in "$out/audio.m4a" "$out/audio_opus.m4a"; do
  echo "$f: $(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,profile,sample_rate,channels -of csv=p=0 "$f")" \
    "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f") 秒"
done
