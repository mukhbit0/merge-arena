# Merge Arena — Artifacts research (verified 2026-10-09)

## Verified binding surface (official docs, developers.cloudflare.com/artifacts)
- `env.ARTIFACTS.create(name, opts?)` -> `{name, remote, token, defaultBranch}`
- `env.ARTIFACTS.get(name)` -> repo handle (disposable; use `using`)
- `env.ARTIFACTS.list(opts?)`, `env.ARTIFACTS.delete(name)`
- repo: `info()`, `createToken(scope, ttlSeconds)`, `listTokens()`,
  `validateToken(t)`, `revokeToken(t)`, `fork(name, {defaultBranchOnly?})`,
  `log({ref})`, `readFile({ref, path})`

Agents are REAL git clients: they clone/push the fork remotes with the
short-lived write tokens the Worker mints. The Worker never shells out to git
(no git CLI in workerd) and cannot commit on its own.

## Deliberate limits (by design, not bugs)
- **No file listing in the verified binding surface.** The Worker cannot
  enumerate paths; it reads known paths only (`readFile({ref, path})`). Path
  lists come from task state (submission `files_touched`).
- **No commit/write path from the Worker.** Merged results land in a repo by
  one of: (a) the winning agent pushes the merged result to its fork, or
  (b) an orchestrator (Node, real git) with a minted write token clones,
  merges with git, and pushes. Merge *computation* is pure in
  `src/merge.ts` (tested); `mergePreview()` on the backend computes per-file
  merges from `readFile` at three refs given explicit paths — read-only, no
  write implied.

## Event subscriptions (VERIFIED 2026-10-09, queues event-subscriptions docs)
- Delivery mechanism: Workers Queues. There is NO `[[events]]` wrangler block.
- Sources: `artifacts` (account-level: repo.created, repo.deleted,
  repo.forked, repo.imported) and `artifacts.repo` (repo-level, requires
  `namespace` + `repo_name`: pushed, cloned, fetched, token.created,
  token.revoked).
- Create with: `wrangler queues subscription create <QUEUE> --source
  artifacts.repo --events pushed` (wrangler >= 3.114 supports these source
  types; workers-sdk PR #14721).
- Push event type: `cf.artifacts.repo.pushed`, payload `{ref, before, after,
  commits[]}` — commits carry id, message, author/committer, parents.
- CI phase consumes this queue to kick off test runs when an agent pushes.

## Environment checks (2026-10-09)
- Account a033f537fb6f4e434bd01b69e99b9e70: **Workers Paid plan ACTIVE**
  (`/accounts/{id}/subscriptions`), so the Artifacts open beta binding is
  usable. Jurisdiction: namespace `merge-arena` is dedicated to this project;
  never reuse or touch existing namespaces/workers.
