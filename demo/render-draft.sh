#!/bin/bash
# Draft-only render for the Merge Arena demo video. NOT final — the user must
# review the storyboard + demo before anything is finalized.
set -euo pipefail
cd "$(dirname "$0")"
OUT="draft.mp4"
FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
BG=0x0b0e14

card() { # $1 text $2 sub $3 seconds $4 outfile
  ffmpeg -y -v error -f lavfi -i "color=c=$BG:s=1920x1080:d=$3:r=30" \
    -vf "drawtext=fontfile=$FONT:text='$1':fontcolor=white:fontsize=72:x=(w-text_w)/2:y=(h-text_h)/2-40, \
         drawtext=fontfile=$FONT:text='$2':fontcolor=0x8b949e:fontsize=36:x=(w-text_w)/2:y=(h-text_h)/2+60, \
         drawtext=fontfile=$FONT:text='DRAFT — not final':fontcolor=0xbb8009:fontsize=28:x=40:y=h-80" \
    -pix_fmt yuv420p "$4"
}

card "Merge Arena" "the agent-native merge queue" 4 card1.mp4
card "3 agents push at once" "clean merges auto-merge, conflicts go to the arena" 4 card2.mp4
card "Workers + Artifacts + Queues" "auto-merge when clean, human arena when not" 4 card3.mp4

ffmpeg -y -v error -f concat -safe 0 -i <(printf "file '%s'\n" "$PWD/card1.mp4" "$PWD/card2.mp4" "$PWD/card3.mp4") \
  -c copy "$OUT"
rm -f card1.mp4 card2.mp4 card3.mp4
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT"
