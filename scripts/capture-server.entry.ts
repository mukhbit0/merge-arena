// Video-phase capture server (PREP tooling, not shipped).
// Replays the 3-agent demo flow against the REAL Hono app (InMemoryState +
// LocalGitBackend, real git) and serves the REAL arena-ui on the same origin,
// so screenshots in the demo video show the actual product, not a mockup.
// Bundled:  node_modules/.bin/esbuild scripts/capture-server.entry.ts \
//             --bundle --platform=node --format=esm --outfile=scripts/dist/capture-server.mjs
// Run:      node scripts/dist/capture-server.mjs [port]

import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../worker/src/index";
import { getState } from "../worker/src/storage";
import { LocalGitBackend } from "../worker/src/git-backend";
import { handleBatch } from "../ci-worker/src/index";

const ROOT = join(process.cwd());
const PORT = Number(process.argv[2] ?? 8931);

const diff = (ls: string[]) => ls.join("\n") + "\n";
const FAREWELL_DIFF = diff([
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,7 @@",
  " export function greet(name: string): string {",
  "   return `Hello, ${name}!`;",
  " }",
  "+",
  "+export function farewell(name: string): string {",
  "+  return `Goodbye, ${name}!`;",
  "+}",
]);
const HI_DIFF = diff([
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@",
  " export function greet(name: string): string {",
  "-  return `Hello, ${name}!`;",
  "+  return `Hi, ${name}!`;",
  " }",
]);
const HEY_DIFF = diff([
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@",
  " export function greet(name: string): string {",
  "-  return `Hello, ${name}!`;",
  "+  return `Hey, ${name}!`;",
  " }",
]);

async function main() {
  const git = new LocalGitBackend();
  const state = getState({});
  const app = createApp(() => ({ state, git, secret: "capture" }));
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  // 1. task
  const created = (await (
    await post("/task", {
      brief: "Greet the user; add a farewell helper",
      agents: ["ada", "grace", "hopper"],
    })
  ).json()) as { task_id: string; agents: Array<{ agent_id: string; name: string; token: string }> };
  const taskId = created.task_id;
  const byName = Object.fromEntries(created.agents.map((a) => [a.name, a]));

  // 2. 3 concurrent submits (the real demo race)
  const submit = (agent: { agent_id: string; token: string }, d: string, rationale: string) =>
    post(`/task/${taskId}/submit`, { agent_id: agent.agent_id, token: agent.token, diff: d, rationale });
  const results = await Promise.all([
    submit(byName.ada, FAREWELL_DIFF, "adds a farewell helper at the end of the file"),
    submit(byName.grace, HI_DIFF, "friendlier greeting: Hi instead of Hello"),
    submit(byName.hopper, HEY_DIFF, "casual greeting: Hey instead of Hello"),
  ]);
  if (!results.every((r) => r.status === 200)) {
    throw new Error(`submit failed: ${JSON.stringify(await Promise.all(results.map((r) => r.text())))}`);
  }

  // 3. CI push event through the REAL ci-worker queue handler -> "received"
  const sha = "deadbee";
  await handleBatch(
    {
      messages: [
        {
          body: {
            type: "cf.artifacts.repo.pushed",
            source: { type: "artifacts.repo", namespace: "merge-arena", repoName: `arena-${taskId}-agent-3` },
            payload: { ref: "refs/heads/main", before: "abc", after: sha, commits: [{ id: sha, message: "candidate" }], totalCommitsCount: 1 },
          },
          ack: () => {},
          retry: () => {},
        },
      ],
    },
    { CI_NAMESPACE: "merge-arena" },
  );
  // NOTE: the test-runner "passed" flip happens later (via API during capture)
  // so the CI table can be screenshotted in both received and passed states.

  const arena = (await (await app.request(`/task/${taskId}/arena`)).json()) as { status: string };
  if (arena.status !== "arena") throw new Error(`expected arena status, got ${arena.status}`);

  const uiHtml = readFileSync(join(ROOT, "arena-ui/index.html"), "utf8");
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(uiHtml);
        return;
      }
      if (url.pathname === "/__taskid") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ task_id: taskId, sha }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const r = new Request(url.toString(), {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      const out = await app.fetch(r, {});
      res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
      res.end(Buffer.from(await out.arrayBuffer()));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  server.listen(PORT, "127.0.0.1", () => {
    writeFileSync(join(ROOT, "scripts/dist/task-id.txt"), taskId);
    console.log(`capture server on http://127.0.0.1:${PORT}/?task=${taskId}  (task ${taskId}, sha ${sha})`);
  });

  const shutdown = async () => {
    server.close();
    await git.cleanup();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("capture-server failed:", e);
  process.exit(1);
});
