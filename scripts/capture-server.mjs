// Video-phase capture server (PREP tooling, not shipped).
//
// Replays the 3-agent demo flow against the REAL Hono app (InMemoryState +
// LocalGitBackend, real git) and serves the REAL arena-ui on the same origin,
// so screenshots in the demo video show the actual product, not a mockup.
//
// Usage:  node scripts/capture-server.mjs [port]
// Prints the arena URL (?task=...) to stdout. Ctrl-C to stop (cleans temp git dirs).
//
// Flow replays: task create -> 3 concurrent submits (ada/grace/hopper) ->
// arena conflict -> CI push event -> CI pass. The human "decide" step is left
// to the capture script (Playwright clicks the real button) so the resolved
// view is captured from the live UI too.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const { createApp } = await import(join(root, "worker/src/index.ts").replace(/\.ts$/, ".js").catch(() => null) ? "" : "");
