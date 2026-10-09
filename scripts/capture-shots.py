#!/usr/bin/env python3
"""Capture real arena-UI screenshots for the demo video (DRAFT assets).
Drives arena-ui/index.html (served by scripts/capture-server.mjs) in headless
Chromium at 1920x1080: conflict view, CI table (received), CI table (passed),
human decide -> resolved view.
Usage: python3 scripts/capture-shots.py   (capture server must be running)
"""
import sys, time
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8931"

with open("scripts/dist/task-id.txt") as f:
    task_id = f.read().strip()

with sync_playwright() as p:
    browser = p.chromium.launch()
    pg = browser.new_page(viewport={"width": 1920, "height": 1080})
    pg.goto(f"{BASE}/?task={task_id}", wait_until="networkidle")
    pg.wait_for_selector("text=merged so far", timeout=15000)

    # Shot 4: the arena — candidates + side-by-side conflict
    time.sleep(1)
    pg.screenshot(path="demo/shot-arena.png", full_page=True)
    print("shot-arena.png")

    # Shot 5a: CI table in 'received' state
    ci = pg.locator("text=CI runs").first
    ci.scroll_into_view_if_needed()
    time.sleep(0.5)
    pg.screenshot(path="demo/shot-ci-received.png")
    print("shot-ci-received.png")

    # Flip the CI run to passed via the real API, then re-capture
    pg.evaluate(
        """async ([task, sha]) => {
             const r = await fetch(`/task/${task}/ci/${sha}`, {
               method: 'POST', headers: {'Content-Type': 'application/json'},
               body: JSON.stringify({status: 'passed',
                 preview_url: `https://preview.example/arena/${task}`})});
             if (!r.ok) throw new Error('ci flip failed: ' + r.status);
           }""",
        [task_id, "deadbee"],
    )
    time.sleep(4)  # let the 3s auto-refresh pick it up
    ci.scroll_into_view_if_needed()
    time.sleep(0.5)
    pg.screenshot(path="demo/shot-ci-passed.png")
    print("shot-ci-passed.png")

    # Shot 6: human picks the winner through the REAL decide control
    pg.evaluate("window.scrollTo(0, 0)")
    pg.wait_for_selector('input[name="winner"]', timeout=10000)
    pg.check('input[name="winner"][value="agent-3"]')
    pg.fill("#decideNote", "casual tone fits the product")
    pg.screenshot(path="demo/shot-decide-before.png")
    print("shot-decide-before.png")
    pg.click("#decideBtn")
    pg.wait_for_selector("text=resolved", timeout=15000)
    time.sleep(1)
    pg.screenshot(path="demo/shot-resolved.png", full_page=True)
    print("shot-resolved.png")
    browser.close()

print("done")
