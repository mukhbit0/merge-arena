# Merge Arena

An agent-native merge queue for the agentic era — built on Cloudflare Workers + Artifacts.

When multiple AI agents work on the same codebase at once, their changes collide.
Merge Arena forks a per-agent worktree for each agent, auto-merges non-conflicting
branches, and sends overlapping hunks to a live **arena** view where a human picks
the winner from each agent's diff + rationale. Merged candidates get CI tests and
a deploy preview automatically.

## Architecture

```
                    ┌──────────────┐
  POST /task        │  merge-arena  │  Hono worker
  (task brief) ───▶ │   (this repo) │
                    └──────┬───────┘
                           │ forks per-agent worktrees
              ┌────────────┼────────────┐
              ▼            ▼            ▼
          Agent A      Agent B      Agent C
          worktree     worktree     worktree
              │            │            │
              └────────────┼────────────┘ push
                           ▼
              ┌────────────────────────┐
              │  overlap detection      │
              │  non-overlapping → auto │
              │  overlapping → ARENA    │
              └────────────┬───────────┘
                           ▼
              ┌────────────────────────┐
              │  arena-ui               │  human picks winner
              │  (diff + rationale)     │
              └────────────┬───────────┘
                           ▼
              ┌────────────────────────┐
              │  ci-worker              │  tests + deploy preview
              └────────────────────────┘
```

- **worker/** — Hono worker: `POST /task` accepts a task brief, forks per-agent
  worktrees from the Artifacts-backed repo, issues scoped Git tokens; computes
  file/line overlap on push.
- **arena-ui/** — live conflict-resolution view: each agent's diff + rationale,
  pick-the-winner control.
- **ci-worker/** — subscribes to merge events; runs tests and builds a deploy
  preview per merged candidate.

## Run instructions (local dev)

```bash
cd worker
npm install
npm run dev        # wrangler dev on http://localhost:8787
curl localhost:8787/                 # health check
curl -X POST localhost:8787/task     # 501 until worker-core phase lands
```

## Competition entry

- Competition: Cloudflare "build the next Git platform" — entries close 2026-10-14.
- Entry requirements: 5–10 min demo video, OSS source (MIT — see LICENSE),
  run/try instructions.
- Demo scenario: three agents push concurrently on one brief → arena resolves a
  real conflict → tests pass → preview deployed.

## Project boundaries (hard rules)

- New resources only: `merge-arena` worker, `merge-arena-state` KV namespace.
- Never touch existing Cloudflare workers (esp. `mangaread-api`), KV namespaces,
  or D1 databases.
- Source lives only in this repo. Deployment of new resources goes through the
  gated `cf.py` flow with the user's explicit approval.
