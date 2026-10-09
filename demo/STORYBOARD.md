# Merge Arena — demo video storyboard (DRAFT, needs user review before finalizing)

Target: 5–10 min (competition entry requirement). Format: 1920x1080, screen
captures of the real arena UI + terminal transcript, calm voiceover.

## Shot list

| # | Time | Visual | Narration |
|---|------|--------|-----------|
| 1 | 0:00–0:20 | Title card: "Merge Arena — the agent-native merge queue" + Cloudflare Workers + Artifacts logos (text) | "When three AI agents write code at the same time, who wins? Merge Arena is a merge queue built for agents, running on Cloudflare Workers and Artifacts." |
| 2 | 0:20–0:50 | Architecture diagram (static card): task -> per-agent forks -> scoped tokens | "One task, one baseline repo, one fork per agent. Each agent gets a short-lived write token scoped to its own fork. Agents are real git clients." |
| 3 | 0:50–1:40 | Terminal: demo transcript section 1–2 (task created, 3 concurrent pushes) | "Three agents push at the same time. Ada appends a helper — clean. Grace rewrites the greeting — clean, auto-merged. Hopper rewrites the same line differently — conflict." |
| 4 | 1:40–3:00 | **Arena UI live**: candidates with rationales, side-by-side conflict view | "This is the arena. Every candidate shows its diff and its rationale. The conflict is shown side by side: the merged result so far versus the newcomer." |
| 5 | 3:00–3:40 | Arena UI: CI runs table (received -> passed, preview link) | "Pushes fire repository events into a queue. The CI worker records each run and the test runner reports back — green, with a preview link." |
| 6 | 3:40–4:20 | Arena UI: click "Decide winner", resolved view | "A human picks the winner. One click, recorded with a rationale. The task resolves." |
| 7 | 4:20–5:00 | Title card: repo + "built with Workers, Artifacts, Queues" | "Merge Arena: auto-merge when it's clean, a human arena when it's not. Built on Cloudflare Workers, Artifacts, and Queues." |

## Assets needed (video phase continues)
- Screen capture of arena-ui against a live demo task (needs deploy OR local server recording).
- Terminal capture of the demo test run.
- Voiceover (TTS) + background music.
- Render: ffmpeg concat of cards + captures.

## Status
- [x] Transcript (demo/TRANSCRIPT.md)
- [ ] Screen captures
- [ ] Voiceover
- [ ] Final render — **BLOCKED on user review of this storyboard + the demo itself**
