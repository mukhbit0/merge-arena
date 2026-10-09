#!/usr/bin/env python3
"""Render demo/shot-terminal.mp4 — the real demo test transcript as a
scrolling terminal capture (1920x1080, 40s). PREP asset, DRAFT watermark.
Usage: python3 scripts/render-terminal.py  (run from repo root)
"""
import subprocess, sys
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
FPS = 30
DUR_SCROLL, DUR_HOLD = 30, 10
BG = (11, 14, 20)
FG = (201, 209, 217)
GREEN = (63, 185, 80)
DIM = (139, 148, 158)
ACCENT = (88, 166, 255)

MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONOB = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
FONT = ImageFont.truetype(MONO, 26)
FONTB = ImageFont.truetype(MONOB, 26)
FONT_TITLE = ImageFont.truetype(MONOB, 30)

LINES = [
    ("$ npx vitest run test/demo.test.ts", FG, FONTB),
    ("", FG, FONT),
    ("## Merge Arena demo transcript", ACCENT, FONTB),
    ("", FG, FONT),
    ("### 1. Task created — brief: 'Greet the user; add a farewell helper'", DIM, FONTB),
    ("task 8a34301b, agents: ada (agent-1), grace (agent-2), hopper (agent-3)", FG, FONT),
    ("", FG, FONT),
    ("### 2. All three agents push CONCURRENTLY (Promise.all)", DIM, FONTB),
    ("- agent-1: HTTP 200 -> status=awaiting_more", FG, FONT),
    ("- agent-2: HTTP 200 -> status=auto_merged", GREEN, FONT),
    ("- agent-3: HTTP 200 -> status=arena", FG, FONT),
    ("task status after concurrent push: arena (3 submissions)", FG, FONT),
    ("", FG, FONT),
    ("### 3. Arena: exactly one conflict — merged-so-far vs the newcomer", DIM, FONTB),
    ("- conflict in src/app.ts", FG, FONT),
    ("- side A: merged so far (2 candidates)", FG, FONT),
    ("- side B: hopper (agent-3)", FG, FONT),
    ('- candidate ada: "adds a farewell helper at the end of the file"', FG, FONT),
    ('- candidate grace: "friendlier greeting: Hi instead of Hello"', FG, FONT),
    ('- candidate hopper: "casual greeting: Hey instead of Hello"', FG, FONT),
    ("", FG, FONT),
    ("### 4. CI: push event -> run recorded -> test runner reports pass", DIM, FONTB),
    ("- CI runs: deadbee:received", FG, FONT),
    ("- after test runner: passed, preview https://preview.example/arena/8a34301b", GREEN, FONT),
    ("", FG, FONT),
    ("### 5. Human pick: the newcomer wins", DIM, FONTB),
    ("- decided: resolved, winner agent-3", FG, FONT),
    ("", FG, FONT),
    ("### Demo complete: 3 concurrent pushes, 1 real conflict, CI green, human resolved it.", ACCENT, FONTB),
    ("", FG, FONT),
    (" ✓ test/demo.test.ts (1 test) 424ms", GREEN, FONTB),
    ("   ✓ demo: 3 agents push concurrently", GREEN, FONT),
    (" Test Files  1 passed (1)", DIM, FONT),
    ("      Tests  1 passed (1)", DIM, FONT),
]

PAD, LH = 60, 40
BAR_H = 64
tall_h = BAR_H + PAD + len(LINES) * LH + PAD
img = Image.new("RGB", (W, tall_h), BG)
d = ImageDraw.Draw(img)
d.rectangle([0, 0, W, BAR_H], fill=(22, 27, 34))
for i, (cx, cy, col) in enumerate([(40, 32, (255, 95, 86)), (68, 32, (255, 189, 46)), (96, 32, (39, 201, 63))]):
    d.ellipse([cx - 11, cy - 11, cx + 11, cy + 11], fill=col)
d.text((140, 16), "demo — 3 agents push concurrently  ·  merge-arena", font=FONT_TITLE, fill=DIM)
for i, (text, color, font) in enumerate(LINES):
    d.text((PAD, BAR_H + PAD + i * LH), text, font=font, fill=color)
# DRAFT watermark on every visible frame region
img.save("/tmp/terminal-tall.png")

scroll = tall_h - H  # px to travel
vf = (
    f"crop=1920:1080:0:'if(lt(t,{DUR_SCROLL}), {scroll}*t/{DUR_SCROLL}, {scroll})',"
    "drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    ":text='DRAFT — not final':fontcolor=0xbb8009:fontsize=28:x=40:y=h-80"
)
subprocess.run([
    "ffmpeg", "-y", "-v", "error", "-loop", "1", "-i", "/tmp/terminal-tall.png",
    "-vf", vf, "-t", str(DUR_SCROLL + DUR_HOLD), "-r", str(FPS), "-pix_fmt", "yuv420p",
    "demo/shot-terminal.mp4",
], check=True)
print("wrote demo/shot-terminal.mp4")
