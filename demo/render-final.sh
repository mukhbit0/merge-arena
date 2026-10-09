#!/bin/bash
# Final render for the Merge Arena demo video.
# 5:00 total, 1920x1080 30fps H.264 + AAC 48kHz.
# Assembles: ffmpeg title cards + real captures + TTS narration
# (demo/audio/shot-N.mp3, calm neutral voice) + NEFFEX royalty-free music bed.
# All assets are local/reproducible; no secrets, no network.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p work

FONT_B=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
FONT_R=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
BG=0x0b0e14
MUSIC=~/workspace/work/yt_automation/assets/audio/neffex_grateful.mp3

# --- card text files (UTF-8, no trailing newline) ---
printf 'Merge Arena — the agent-native merge queue' > work/c1_title.txt
printf 'Cloudflare Workers + Artifacts'              > work/c1_sub.txt
printf 'How it works'                                > work/c2_title.txt
printf '•  One task, one baseline repo\n•  One fork per agent\n•  Short-lived write token, scoped to its own fork\n•  Agents are real git clients — branch, commit, push' > work/c2_body.txt
printf 'Merge Arena'                                 > work/c7_title.txt
printf 'github.com/mukhbit0/merge-arena'             > work/c7_sub.txt
printf 'Workers • Artifacts • Queues'                > work/c7_sub2.txt

card() { # $1 seconds $2 outfile; reads work/c*_*.txt named by the caller via vars
  local dur="$1" out="$2"
  ffmpeg -y -v error -f lavfi -i "color=c=$BG:s=1920x1080:d=$dur:r=30" \
    -vf "$CARDVF" -c:v libx264 -pix_fmt yuv420p -r 30 "$out"
}

# Shot 1 — title card (20s); fontsize 60 keeps the full one-line title on screen
CARDVF="drawtext=fontfile=$FONT_B:textfile=work/c1_title.txt:fontcolor=white:fontsize=60:x=(w-text_w)/2:y=(h-text_h)/2-100,drawtext=fontfile=$FONT_R:textfile=work/c1_sub.txt:fontcolor=0x9aa4b2:fontsize=44:x=(w-text_w)/2:y=(h-text_h)/2+40"
card 20 work/seg1.mp4

# Shot 2 — architecture card (30s)
CARDVF="drawtext=fontfile=$FONT_B:textfile=work/c2_title.txt:fontcolor=white:fontsize=84:x=(w-text_w)/2:y=260,drawtext=fontfile=$FONT_R:textfile=work/c2_body.txt:fontcolor=0xd6dbe2:fontsize=44:line_spacing=18:x=(w-text_w)/2:y=460"
card 30 work/seg2.mp4

# Shot 3 — terminal capture (40s real) + hold last frame to reach 50s
ffmpeg -y -v error -i shot-terminal.mp4 \
  -vf "tpad=stop_mode=clone:stop_duration=10,format=yuv420p" \
  -c:v libx264 -r 30 -t 50 work/seg3.mp4

# Ken-burns helper: $1 input png $2 output $3 seconds $4 crop-filter ("" for none)
kb() {
  local frames
  frames=$(python3 -c "print(int($3*30))")
  ffmpeg -y -v error -loop 1 -i "$1" \
    -vf "${4:+$4,}scale=3840:2160,zoompan=z='1+0.06*on/$frames':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=$frames:s=1920x1080:fps=30,format=yuv420p" \
    -c:v libx264 -frames:v "$frames" -r 30 "$2"
}

# Shot 4 — arena conflict view (80s; source is 1920x1332, center-crop to 16:9)
kb shot-arena.png work/seg4.mp4 80 "crop=1920:1080:0:126"

# Half-shot helper for crossfades: $1 in $2 out $3 seconds $4 crop
kbhalf() {
  local frames
  frames=$(python3 -c "print(int($3*30))")
  ffmpeg -y -v error -loop 1 -i "$1" \
    -vf "${4:+$4,}scale=3840:2160,zoompan=z='1+0.03*on/$frames':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=$frames:s=1920x1080:fps=30,format=yuv420p" \
    -c:v libx264 -frames:v "$frames" -r 30 "$2"
}

# Shot 5 — CI received -> passed (20.5s + 20.5s, 1s crossfade = 40s)
kbhalf shot-ci-received.png work/ci_a.mp4 20.5 ""
kbhalf shot-ci-passed.png   work/ci_b.mp4 20.5 ""
ffmpeg -y -v error -i work/ci_a.mp4 -i work/ci_b.mp4 \
  -filter_complex "xfade=transition=fade:duration=1:offset=20,format=yuv420p" \
  -c:v libx264 -r 30 -t 40 work/seg5.mp4

# Shot 6 — decide-before -> resolved (source 2 is 1920x1365, center-crop)
kbhalf shot-decide-before.png work/dec_a.mp4 20.5 ""
kbhalf shot-resolved.png      work/dec_b.mp4 20.5 "crop=1920:1080:0:142"
ffmpeg -y -v error -i work/dec_a.mp4 -i work/dec_b.mp4 \
  -filter_complex "xfade=transition=fade:duration=1:offset=20,format=yuv420p" \
  -c:v libx264 -r 30 -t 40 work/seg6.mp4

# Shot 7 — outro card (40s)
CARDVF="drawtext=fontfile=$FONT_B:textfile=work/c7_title.txt:fontcolor=white:fontsize=96:x=(w-text_w)/2:y=(h-text_h)/2-140,drawtext=fontfile=$FONT_R:textfile=work/c7_sub.txt:fontcolor=0xd6dbe2:fontsize=44:x=(w-text_w)/2:y=(h-text_h)/2+20,drawtext=fontfile=$FONT_R:textfile=work/c7_sub2.txt:fontcolor=0x9aa4b2:fontsize=36:x=(w-text_w)/2:y=(h-text_h)/2+110"
card 40 work/seg7.mp4

# Concat video (all segments: 1920x1080 30fps yuv420p) -> 300s
printf "file '%s'\n" "$PWD/work/seg1.mp4" "$PWD/work/seg2.mp4" "$PWD/work/seg3.mp4" \
  "$PWD/work/seg4.mp4" "$PWD/work/seg5.mp4" "$PWD/work/seg6.mp4" "$PWD/work/seg7.mp4" > work/concat.txt
ffmpeg -y -v error -f concat -safe 0 -i work/concat.txt -c copy work/video.mp4

# --- audio: narration centered in each shot + music bed ducked under speech ---
# narration offsets (ms) = shot_start + 500ms lead-in (narration starts WITH each shot)
# shot starts: 0, 20, 50, 130, 210, 250, 260 (20/30/50/80/40/40/40 = 300s)
#
# Two-step build (deliberate): a single filtergraph that feeds one stream into
# both sidechaincompress and amix silently drops the narration (ffmpeg quirk),
# so the narration bed is rendered to work/narr.wav first, then mixed with the
# ducked music bed in a second pass.
ffmpeg -y -v error \
  -i audio/shot-1.mp3 -i audio/shot-2.mp3 -i audio/shot-3.mp3 -i audio/shot-4.mp3 \
  -i audio/shot-5.mp3 -i audio/shot-6.mp3 -i audio/shot-7.mp3 \
  -filter_complex "\
[0:a]adelay=500|500[a1];\
[1:a]adelay=20500|20500[a2];\
[2:a]adelay=50500|50500[a3];\
[3:a]adelay=130500|130500[a4];\
[4:a]adelay=210500|210500[a5];\
[5:a]adelay=250500|250500[a6];\
[6:a]adelay=260500|260500[a7];\
[a1][a2][a3][a4][a5][a6][a7]amix=inputs=7:normalize=0,apad=whole_dur=300,aformat=channel_layouts=stereo[narr]" \
  -map "[narr]" -c:a pcm_s16le -ar 48000 -t 300 work/narr.wav

# Duck the music bed under each narration window (0.5s padding each side)
# instead of sidechaincompress — deterministic, no shared-stream quirks.
DUCK="'if(between(t,4.3,15.7)+between(t,27.3,42.7)+between(t,66.6,83.4)+between(t,161.5,178.5)+between(t,223.4,236.6)+between(t,264.9,275.1)+between(t,275.0,285.0),0.02,0.05)'"
ffmpeg -y -v error -i work/narr.wav -stream_loop 1 -i "$MUSIC" \
  -filter_complex "\
[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:300,afade=t=in:st=0:d=3,afade=t=out:st=297:d=3,volume=$DUCK:eval=frame[music];\
[0:a][music]amix=inputs=2:normalize=0,aresample=48000,aformat=channel_layouts=stereo[mix]" \
  -map "[mix]" -c:a aac -b:a 160k -t 300 work/audio.m4a

# Mux
ffmpeg -y -v error -i work/video.mp4 -i work/audio.m4a \
  -c:v copy -c:a copy -shortest final.mp4

echo "== final.mp4 =="
du -h final.mp4
ffprobe -v error -show_entries format=duration,size -of default=nw=1 final.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate,codec_name,pix_fmt -of default=nw=1 final.mp4
ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels -of default=nw=1 final.mp4
