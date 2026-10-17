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
# iOS Safari でもデコードできる AAC(m4a) で出力
ffmpeg -v error -y -i "$src" -map 0:a:0 -vn -c:a aac -b:a 160k "$out/audio.m4a"
# AAC 非対応のブラウザ（コーデック無しの Chromium 等）向けに Opus も用意
ffmpeg -v error -y -i "$src" -map 0:a:0 -vn -c:a libopus -b:a 128k "$out/audio.ogg"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$out/audio.m4a" | sed 's/^/音声の長さ(秒): /'
echo "→ $out/audio.m4a, $out/audio.ogg"
