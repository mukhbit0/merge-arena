# Merge Arena — demo video voiceover (DRAFT, not final)

Calm, peer-to-peer explainer tone. Total target 5:00. Timings match
demo/STORYBOARD.md shots. Pacing ~140 wpm.

## Shot 1 — 0:00–0:20 — Title card

"When three AI agents write code at the same time, who wins?
Merge Arena is a merge queue built for agents — running on Cloudflare
Workers and Artifacts."

## Shot 2 — 0:20–0:50 — Architecture card

"One task, one baseline repo, one fork per agent. Each agent gets a
short-lived write token scoped to its own fork. Agents are real git
clients — they branch, commit, and push like any developer would."

## Shot 3 — 0:50–1:40 — Terminal: three concurrent pushes

"Three agents push at the same time. Ada appends a helper — clean.
Grace rewrites the greeting — clean, auto-merged. Hopper rewrites the
same line differently — conflict. Two merges land automatically; the
third goes to the arena."

## Shot 4 — 1:40–3:00 — Arena UI live: candidates + conflict view

"This is the arena. Every candidate shows its diff and its rationale.
The conflict is shown side by side: the merged result so far versus the
newcomer. Nothing is hidden — you see exactly what each agent changed
and why."

## Shot 5 — 3:00–3:40 — Arena UI: CI runs table

"Every push fires a repository event into a queue. The CI worker records
each run, and the test runner reports back — green, with a preview link.
You know what's tested before you decide."

## Shot 6 — 3:40–4:20 — Arena UI: human picks winner, resolved view

"A human picks the winner. One click, recorded with a rationale. The
task resolves — and the decision is in the audit trail, not in a chat
log."

## Shot 7 — 4:20–5:00 — Outro card

"Merge Arena: auto-merge when it's clean, a human arena when it's not.
Built on Cloudflare Workers, Artifacts, and Queues."

---

Production notes (for the final render pass, after user review):
- TTS voice: neutral, unhurried; duck under BGM at −18 dB during narration.
- Terminal shot: real output from `vitest run test/demo.test.ts` (captured,
  typed at ~4x in the edit).
- Arena shots: real arena-ui/index.html against a live task (capture-server),
  1920x1080, cursor visible on the Decide click.
