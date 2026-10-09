# merge-arena-ci (CI worker)

Consumes Artifacts push events and records CI runs for the merge queue.

## How it works

1. An **event subscription** on the `artifacts.repo` source (event
   `cf.artifacts.repo.pushed`) delivers push events for the `merge-arena`
   namespace into the `merge-arena-events` queue:
   `wrangler queues subscription create merge-arena-events --source artifacts.repo --events pushed`
   (per-repo subscriptions are created per baseline/fork in the deploy phase).
2. This worker's `queue()` handler parses each event (`src/events.ts` —
   shape verified against the official events-schemas docs), maps the repo
   name `arena-<taskId>-<suffix>` back to its task, and writes a CI run
   record to shared state:
   - `ci:<taskId>:<sha>` = `{task_id, repo, ref, sha, commit_count,
     commit_messages, status: "received", received_at}`
   - `ci:<taskId>:latest` = `<sha>`
3. The merge-arena worker exposes the runs at `GET /task/:id/ci` and lets a
   test runner report back via `POST /task/:id/ci/:sha`
   (`{status: running|passed|failed, preview_url?}`). The arena UI renders
   them next to the candidates.

## Deploy previews

Per-candidate deploy previews are produced by enabling **Workers Builds**
on the fork repos (pushes to non-`main` branches yield preview URLs); the
test runner passes the preview URL back through the CI hook above. Full
Workers Builds wiring lands in the deploy/demo phases.

## Dev

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```
