#!/bin/bash
# Fix: correct narration offsets to actual shot boundaries.
# Shot starts (s): 0, 20, 50, 100, 180, 220, 260  (durations 20/30/50/80/40/40/40 = 300s)
# Previous build used 0.5, 20.5, 50.5, 130.5, 210.5, 250.5, 260.5 -> shots 4-6
# narrated 30s late and shots 6-7 overlapped.
set -euo pipefail
cd "$(dirname "$0")"

ffmpeg -y -v error \
  -i audio/shot-1.mp3 -i audio/shot-2.mp3 -i audio/shot-3.mp3 -i audio/shot-4.mp3 \
  -i audio/shot-5.mp3 -i audio/shot-6.mp3 -i audio/shot-7.mp3 \
  -filter_complex "\
[0:a]adelay=500|500[a1];\
[1:a]adelay=20500|20500[a2];\
[2:a]adelay=50500|50500[a3];\
[3:a]adelay=100500|100500[a4];\
[4:a]adelay=180500|180500[a5];\
[5:a]adelay=220500|220500[a6];\
[6:a]adelay=260500|260500[a7];\
[a1][a2][a3][a4][a5][a6][a7]amix=inputs=7:normalize=0,apad=whole_dur=300,aformat=channel_layouts=stereo[narr]" \
  -map "[narr]" -c:a pcm_s16le -ar 48000 -t 300 work/narr_fixed.wav

# Narration-only audio (no music bed, per his instruction)
ffmpeg -y -v error -i work/narr_fixed.wav -c:a aac -b:a 160k -t 300 work/narr_fixed.m4a

# Mux with existing 300s video concat
ffmpeg -y -v error -i work/video.mp4 -i work/narr_fixed.m4a \
  -c:v copy -c:a copy -shortest final_fixed.mp4

echo "== final_fixed.mp4 =="
ffprobe -v error -show_entries format=duration,size -of default=nw=1 final_fixed.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate,codec_name,pix_fmt -of default=nw=1 final_fixed.mp4
ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels -of default=nw=1 final_fixed.mp4
