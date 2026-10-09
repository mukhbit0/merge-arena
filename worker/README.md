# merge-arena worker (worker-core)

Hono + TypeScript Cloudflare Worker implementing the agent-native merge queue core.

## What it does

1. `POST /task` — creates a task from a brief: seeds a fixture repo, forks one
   branch per agent, and issues each agent a scoped HMAC token.
2. `POST /task/:id/submit` — an agent submits a unified diff + rationale. The
   token is verified (401 on bad), the diff is applied with `git apply`, and
   once ≥2 candidates exist a real `git` 3-way merge runs between the first two:
   - clean merge → `auto_merged` (merged diff returned)
   - conflicts → `arena` (conflicted paths returned)
3. `GET /task/:id/arena` — candidates with rationales + conflict excerpts,
   for the human-pick view.
4. `POST /task/:id/decide` — human picks a winner; task becomes `resolved`
   with the winning diff stored as the result.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/` | service info |
| GET | `/health` | `{ok:true}` |
| POST | `/task` | `{brief, agents: string[], base?: {files}}` → 201 `{task_id, agents:[{agent_id,name,token,branch,brief}], status}` |
| GET | `/task/:id` | task record (tokens stripped) |
| POST | `/task/:id/submit` | `{agent_id, token, diff, rationale}` → `awaiting_more` / `auto_merged` / `arena` |
| GET | `/task/:id/arena` | `{candidates, conflicts:[{path, a_excerpt, b_excerpt, ...}]}` |
| POST | `/task/:id/decide` | `{winner_agent_id, decided_by, rationale?}` → `resolved` (409 unless `arena`) |

## Layout

- `src/index.ts` — Hono app. `createApp(resolveDeps)` builds routes; the default
  export resolves deps per request via `getDeps(env)` (KV binding + secret from
  env). Tests inject in-memory deps through the same factory.
- `src/types.ts` — task/agent/submission/conflict record types.
- `src/storage.ts` — `StateStore {get,put,delete,list(prefix)}`;
  `InMemoryState` (default) and `KVState` (lazy wrapper around the `STATE_KV`
  binding, used only when present).
- `src/git-backend.ts` — `GitBackend` interface + `LocalGitBackend` (real git
  via `spawnSync` against temp fixture repos; dev/test only). The artifacts
  phase swaps in an Artifacts-backed backend behind this interface.
- `src/tokens.ts` — HMAC-SHA256 scoped tokens via `crypto.subtle`
  (Workers + Node compatible). `getSecret(env)` reads `MERGE_ARENA_SECRET` or
  generates a per-process dev secret.
- `src/merge.ts` — git-independent line-based 3-way merge (in-file LCS diff);
  `analyzeOverlap(files)` → per-file `{overlap, conflict, merged?}`.
- `src/diffutil.ts` — unified-diff helpers (`filesTouchedBy`, `diffStat`).
- `test/core.test.ts` — vitest suite, all in-process via `app.request`.

## Local dev

```bash
cd worker
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run dev         # wrangler dev (local; nothing is deployed)
```

`wrangler dev` runs against the in-memory store + temp fixture repos; no
Cloudflare resources are touched. Deploy (new worker + new KV only, via the
gated `cf.py` flow) is a later phase — never `wrangler deploy` from here
without going through that gate.

## Notes / limitations

- `LocalGitBackend` uses `node:child_process` — it works under `wrangler dev`
  (nodejs_compat) and in tests, but the production path will be an
  Artifacts-backed repo backend (artifacts phase).
- Merge arbitration currently runs between the first two submitted candidates;
  3+ candidate tournaments are future work.
- Dev secrets (`getSecret` fallback) are per-process; tokens don't survive restarts.
