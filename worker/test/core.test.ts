// worker-core tests. All in-process via app.request — no server, no network.
// Each test gets a fresh app with its own InMemoryState + fixture git backend;
// fixture temp dirs are removed in afterAll.

import { describe, it, expect, afterAll } from "vitest";
import { createApp } from "../src/index";
import { InMemoryState } from "../src/storage";
import { LocalGitBackend } from "../src/git-backend";
import { issueToken, verifyToken } from "../src/tokens";
import { analyzeOverlap } from "../src/merge";
import { ArtifactsGitBackend } from "../src/artifacts-git";

const backends: LocalGitBackend[] = [];
afterAll(async () => {
  for (const g of backends) await g.cleanup();
});

function makeApp() {
  const git = new LocalGitBackend();
  backends.push(git);
  // One deps object shared across requests (per-request resolver must
  // return the SAME state store, like getDeps does via its singletons).
  const deps = { state: new InMemoryState(), git, secret: "test-secret" };
  const app = createApp(() => deps);
  return app;
}

const diff = (lines: string[]) => lines.join("\n") + "\n";

// Non-conflicting: agent-1 touches README.md, agent-2 touches src/app.ts.
const README_DIFF = diff([
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,3 +1,5 @@",
  " # Merge Arena",
  " ",
  " Agent-native merge queue.",
  "+",
  "+Added by agent one.",
]);
const APP_APPEND_DIFF = diff([
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
// Conflicting: both agents rewrite the same return line differently.
const CONFLICT_A = diff([
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@",
  " export function greet(name: string): string {",
  "-  return `Hello, ${name}!`;",
  "+  return `Hi, ${name}!`;",
  " }",
]);
const CONFLICT_B = diff([
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@",
  " export function greet(name: string): string {",
  "-  return `Hello, ${name}!`;",
  "+  return `Hey, ${name}!`;",
  " }",
]);

async function createTask(app: ReturnType<typeof createApp>, agents = ["alpha", "beta"]) {
  const res = await app.request("/task", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief: "Add a farewell helper and document it", agents }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    task_id: string;
    status: string;
    agents: Array<{ agent_id: string; name: string; token: string; branch: string; brief: string }>;
  };
}

async function submit(
  app: ReturnType<typeof createApp>,
  taskId: string,
  agent: { agent_id: string; token: string },
  d: string,
  rationale: string,
) {
  const res = await app.request(`/task/${taskId}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: agent.agent_id, token: agent.token, diff: d, rationale }),
  });
  return res;
}

describe("POST /task", () => {
  it("(a) creates N agents with tokens, branches and the brief", async () => {
    const app = makeApp();
    const created = await createTask(app, ["alpha", "beta", "gamma"]);
    expect(created.task_id).toMatch(/^[0-9a-f-]{8}$/);
    expect(created.status).toBe("collecting");
    expect(created.agents).toHaveLength(3);
    const ids = new Set<string>();
    for (const a of created.agents) {
      expect(a.agent_id).toMatch(/^agent-\d+$/);
      expect(a.name).toBeTruthy();
      expect(a.token.split(".")).toHaveLength(2);
      expect(a.branch).toContain(created.task_id);
      expect(a.brief).toContain("farewell");
      ids.add(a.branch);
    }
    expect(ids.size).toBe(3); // distinct branches

    const got = await (await app.request(`/task/${created.task_id}`)).json();
    expect(got.status).toBe("collecting");
    expect(got.agents[0].token).toBeUndefined(); // tokens never leak on GET
  });

  it("rejects missing brief / empty agents", async () => {
    const app = makeApp();
    const r1 = await app.request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agents: ["a"] }),
    });
    expect(r1.status).toBe(400);
    const r2 = await app.request("/task", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief: "x", agents: [] }),
    });
    expect(r2.status).toBe(400);
  });
});

describe("tokens", () => {
  it("(b) verify rejects a tampered token", async () => {
    const payload = { taskId: "t1", agentId: "agent-1", scopes: ["submit"], exp: Date.now() + 60000 };
    const token = await issueToken("test-secret", payload);
    expect(await verifyToken("test-secret", token)).toMatchObject({ taskId: "t1" });
    // Tamper a middle signature char (full data bits — the last base64 char
    // carries 2 ignored padding bits, so flipping it may not change anything).
    const [body, sig] = token.split(".");
    const mid = Math.floor(sig.length / 2);
    const tamperedSig = sig.slice(0, mid) + (sig[mid] === "A" ? "B" : "A") + sig.slice(mid + 1);
    expect(await verifyToken("test-secret", `${body}.${tamperedSig}`)).toBeNull();
    expect(await verifyToken("wrong-secret", token)).toBeNull();
    expect(
      await verifyToken(
        "test-secret",
        await issueToken("test-secret", { ...payload, exp: Date.now() - 1000 }),
      ),
    ).toBeNull();
  });

  it("submit with a bad token -> 401", async () => {
    const app = makeApp();
    const created = await createTask(app);
    const res = await submit(app, created.task_id, { agent_id: "agent-1", token: "bogus" }, README_DIFF, "r");
    expect(res.status).toBe(401);
  });

  it("submit validates diff + rationale -> 400", async () => {
    const app = makeApp();
    const created = await createTask(app);
    const a = created.agents[0];
    const r1 = await submit(app, created.task_id, a, "   ", "has rationale");
    expect(r1.status).toBe(400);
    const r2 = await submit(app, created.task_id, a, README_DIFF, "   ");
    expect(r2.status).toBe(400);
  });
});

describe("submit -> merge paths", () => {
  it("(c) two non-conflicting diffs -> auto_merged with both changes", async () => {
    const app = makeApp();
    const created = await createTask(app);
    const [a, b] = created.agents;

    const r1 = await submit(app, created.task_id, a, README_DIFF, "docs update");
    expect(r1.status).toBe(200);
    expect((await r1.json()).status).toBe("awaiting_more");

    const r2 = await submit(app, created.task_id, b, APP_APPEND_DIFF, "add farewell");
    expect(r2.status).toBe(200);
    const body = await r2.json();
    expect(body.status).toBe("auto_merged");
    expect(body.merged_diff).toContain("Added by agent one.");
    expect(body.merged_diff).toContain("farewell");

    const task = await (await app.request(`/task/${created.task_id}`)).json();
    expect(task.status).toBe("merged");
  });

  it("(d) two conflicting diffs on the same lines -> arena with conflicts listed", async () => {
    const app = makeApp();
    const created = await createTask(app);
    const [a, b] = created.agents;

    await submit(app, created.task_id, a, CONFLICT_A, "friendlier greeting");
    const r2 = await submit(app, created.task_id, b, CONFLICT_B, "casual greeting");
    expect(r2.status).toBe(200);
    const body = await r2.json();
    expect(body.status).toBe("arena");
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0].path).toBe("src/app.ts");

    const task = await (await app.request(`/task/${created.task_id}`)).json();
    expect(task.status).toBe("arena");
  });
});

describe("arena + decide", () => {
  async function arenaTask() {
    const app = makeApp();
    const created = await createTask(app);
    const [a, b] = created.agents;
    await submit(app, created.task_id, a, CONFLICT_A, "rationale-alpha: friendlier greeting");
    await submit(app, created.task_id, b, CONFLICT_B, "rationale-beta: casual greeting");
    return { app, taskId: created.task_id };
  }

  it("(e) GET /task/:id/arena shows candidates with rationales + excerpts", async () => {
    const { app, taskId } = await arenaTask();
    const res = await app.request(`/task/${taskId}/arena`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("arena");
    expect(body.candidates).toHaveLength(2);
    const rationales = body.candidates.map((c: { rationale: string }) => c.rationale);
    expect(rationales).toContain("rationale-alpha: friendlier greeting");
    expect(rationales).toContain("rationale-beta: casual greeting");
    expect(body.conflicts[0].a_excerpt).toContain("Hi,");
    expect(body.conflicts[0].b_excerpt).toContain("Hey,");
  });

  it("(f) decide picks a winner -> resolved; 409 when not in arena", async () => {
    const { app, taskId } = await arenaTask();
    const bad = await app.request(`/task/${taskId}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ winner_agent_id: "agent-9", decided_by: "tester" }),
    });
    expect(bad.status).toBe(400);

    const res = await app.request(`/task/${taskId}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        winner_agent_id: "agent-1",
        decided_by: "tester",
        rationale: "friendlier wins",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("resolved");
    expect(body.winner_agent_id).toBe("agent-1");

    const task = await (await app.request(`/task/${taskId}`)).json();
    expect(task.status).toBe("resolved");
    expect(task.result.winner_agent_id).toBe("agent-1");
    expect(task.result.winning_diff).toContain("Hi,");

    const again = await app.request(`/task/${taskId}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ winner_agent_id: "agent-2", decided_by: "tester" }),
    });
    expect(again.status).toBe(409);
  });

  it("(f2) arena UI contract: every field the UI renders is present", async () => {
    // arena-ui/index.html consumes exactly these shapes; keep them in sync.
    const { app, taskId } = await arenaTask();

    const arena = await (await app.request(`/task/${taskId}/arena`)).json();
    expect(typeof arena.task_id).toBe("string");
    expect(typeof arena.status).toBe("string");
    for (const c of arena.candidates) {
      for (const k of ["agent_id", "name", "rationale", "files_touched", "diff_stat"]) {
        expect(c).toHaveProperty(k);
      }
      expect(typeof c.diff_stat.additions).toBe("number");
      expect(typeof c.diff_stat.deletions).toBe("number");
    }
    expect(arena.conflicts.length).toBeGreaterThan(0);
    for (const k of arena.conflicts) {
      for (const f of ["path", "a_agent_id", "a_name", "a_excerpt", "b_agent_id", "b_name", "b_excerpt"]) {
        expect(k).toHaveProperty(f);
        expect(typeof k[f]).toBe("string");
      }
    }

    const task = await (await app.request(`/task/${taskId}`)).json();
    for (const f of ["id", "brief", "status", "submissions"]) expect(task).toHaveProperty(f);
    for (const s of task.submissions) {
      expect(s).toHaveProperty("agent_id");
      expect(s).toHaveProperty("diff");
    }

    // decide round-trip: POST {winner_agent_id, decided_by, rationale}
    const res = await app.request(`/task/${taskId}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ winner_agent_id: "agent-2", decided_by: "arena-ui", rationale: "casual" }),
    });
    expect(res.status).toBe(200);
    const decided = await (await app.request(`/task/${taskId}`)).json();
    expect(decided.status).toBe("resolved");
    expect(decided.result.winner_agent_id).toBe("agent-2");
    expect(decided.result.winning_diff).toContain("Hey,");
  });
});

describe("merge.ts analyzeOverlap (git-independent)", () => {
  const base = "a\nb\nc\nd\n";
  it("merges disjoint changes", () => {
    const r = analyzeOverlap(
      new Map([["f", { base, a: "A\nb\nc\nd\n", b: "a\nb\nc\nD\n" }]]),
    ).get("f")!;
    expect(r.conflict).toBe(false);
    expect(r.overlap).toBe(false);
    expect(r.merged).toBe("A\nb\nc\nD\n");
  });
  it("flags overlapping-different changes as conflict", () => {
    const r = analyzeOverlap(
      new Map([["f", { base, a: "a\nB1\nc\nd\n", b: "a\nB2\nc\nd\n" }]]),
    ).get("f")!;
    expect(r.conflict).toBe(true);
    expect(r.overlap).toBe(true);
    expect(r.merged).toBeUndefined();
  });
  it("takes one copy of identical overlapping changes", () => {
    const r = analyzeOverlap(
      new Map([["f", { base, a: "a\nB\nc\nd\n", b: "a\nB\nc\nd\n" }]]),
    ).get("f")!;
    expect(r.conflict).toBe(false);
    expect(r.overlap).toBe(true);
    expect(r.merged).toBe("a\nB\nc\nd\n");
  });
});

describe("incremental N-agent merge", () => {
  // Third agent adds a brand-new file: can never conflict with the others.
  const NEW_FILE_DIFF = diff([
    "diff --git a/src/extra.ts b/src/extra.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/extra.ts",
    "@@ -0,0 +1,3 @@",
    "+export function extra(): string {",
    "+  return \"extra\";",
    "+}",
  ]);

  it("(g) three non-conflicting agents merge incrementally", async () => {
    const app = makeApp();
    const created = await createTask(app, ["alpha", "beta", "gamma"]);
    const [a, b, c] = created.agents;

    const r1 = await submit(app, created.task_id, a, README_DIFF, "docs update");
    expect((await r1.json()).status).toBe("awaiting_more");

    const r2 = await submit(app, created.task_id, b, APP_APPEND_DIFF, "add farewell");
    const b2 = await r2.json();
    expect(b2.status).toBe("auto_merged");
    expect(b2.merged_so_far).toBe(true);
    expect(b2.awaiting).toBe(1);
    expect(b2.merged_diff).toContain("Added by agent one.");
    expect(b2.merged_diff).toContain("farewell");

    const r3 = await submit(app, created.task_id, c, NEW_FILE_DIFF, "add extra helper");
    const b3 = await r3.json();
    expect(b3.status).toBe("auto_merged");
    expect(b3.merged_diff).toContain("Added by agent one.");
    expect(b3.merged_diff).toContain("farewell");
    expect(b3.merged_diff).toContain("src/extra.ts");

    const task = await (await app.request(`/task/${created.task_id}`)).json();
    expect(task.status).toBe("merged");
    expect(task.submissions).toHaveLength(3);
  });

  it("(h) third agent conflicts with the merged result -> arena names both sides", async () => {
    const app = makeApp();
    const created = await createTask(app, ["alpha", "beta", "gamma"]);
    const [a, b, c] = created.agents;

    await submit(app, created.task_id, a, README_DIFF, "docs update");
    await submit(app, created.task_id, b, CONFLICT_A, "friendlier greeting");
    const r3 = await submit(app, created.task_id, c, CONFLICT_B, "casual greeting");
    const body = await r3.json();
    expect(body.status).toBe("arena");
    expect(body.conflicts).toHaveLength(1);
    expect(body.conflicts[0].path).toBe("src/app.ts");

    const arena = await (await app.request(`/task/${created.task_id}/arena`)).json();
    expect(arena.status).toBe("arena");
    expect(arena.candidates).toHaveLength(3);
    expect(arena.conflicts[0].a_name).toContain("merged so far");
    expect(arena.conflicts[0].b_name).toBe("gamma");
    expect(arena.conflicts[0].a_excerpt).toContain("Hi,");
    expect(arena.conflicts[0].b_excerpt).toContain("Hey,");

    // Human can still pick any candidate as the winner.
    const res = await app.request(`/task/${created.task_id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ winner_agent_id: "agent-3", decided_by: "tester" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).winner_agent_id).toBe("agent-3");
  });
});

describe("artifacts-git (fake binding)", () => {
  function fakeBinding() {
    const calls: string[] = [];
    const repos = new Map<string, { remote: string }>();
    return {
      calls,
      async create(name: string, opts?: { setDefaultBranch?: string }) {
        calls.push(`create:${name}:${opts?.setDefaultBranch}`);
        repos.set(name, { remote: `https://acct.artifacts.cloudflare.net/git/merge-arena/${name}.git` });
        return { name, remote: repos.get(name)!.remote, token: `tok-${name}`, defaultBranch: "main" };
      },
      async get(name: string) {
        calls.push(`get:${name}`);
        if (!repos.has(name)) throw new Error("not found");
        return {
          info: async () => ({ remote: repos.get(name)!.remote }),
          createToken: async (scope: string, ttl: number) => {
            calls.push(`createToken:${name}:${scope}:${ttl}`);
            return `git-tok-${name}`;
          },
          fork: async (forkName: string, opts?: { defaultBranchOnly?: boolean }) => {
            calls.push(`fork:${forkName}:${opts?.defaultBranchOnly}`);
            repos.set(forkName, { remote: `https://acct.artifacts.cloudflare.net/git/merge-arena/${forkName}.git` });
          },
          log: async () => [{ sha: "abc123" }],
          readFile: async ({ path }: { ref: string; path: string }) => `content:${path}`,
        };
      },
      async list() {
        return { repos: [...repos.keys()] };
      },
      async delete(name: string) {
        calls.push(`delete:${name}`);
        repos.delete(name);
      },
    };
  }

  it("seeds a baseline repo and forks per agent with write tokens", async () => {
    const binding = fakeBinding();
    const backend = new ArtifactsGitBackend(binding);
    const { repoDir, baseRef } = await backend.seedFixture("abcd1234");
    expect(repoDir).toBe("arena-abcd1234-base");
    expect(baseRef).toBe("main");
    expect(backend.baselineAccess("abcd1234").remote).toContain("arena-abcd1234-base.git");

    const { branch } = await backend.createWorktree("abcd1234", "agent-1");
    expect(branch).toBe("arena-abcd1234-agent-1");
    const access = backend.agentAccess("abcd1234", "agent-1");
    expect(access.token).toBe("git-tok-arena-abcd1234-agent-1");
    expect(access.remote).toContain("arena-abcd1234-agent-1.git");
    expect(binding.calls).toContain("create:arena-abcd1234-base:main");
    expect(binding.calls).toContain("fork:arena-abcd1234-agent-1:true");
    expect(binding.calls).toContain("createToken:arena-abcd1234-agent-1:write:3600");

    expect(await backend.readFile("arena-abcd1234-base", "main", "README.md")).toBe("content:README.md");
    await backend.cleanupTask("abcd1234");
    expect(binding.calls).toContain("delete:arena-abcd1234-base");
  });

  it("merge methods fail loudly until the deploy phase wires a merge path", async () => {
    const backend = new ArtifactsGitBackend(fakeBinding());
    await expect(backend.applyDiff("b", "diff")).rejects.toThrow("artifacts mode");
    await expect(backend.threeWay("a", "b", "c")).rejects.toThrow("not wired yet");
    await expect(backend.adoptMerge("a", "b", "c")).rejects.toThrow("not wired yet");
  });

  it("mergePreview merges across three refs with no conflict on disjoint edits", async () => {
    const contents = new Map<string, string>([
      ["main:src/app.ts", "line1\nline2\n"],
      ["refs/heads/agent-a:src/app.ts", "line1\nalpha\nline2\n"],
      ["refs/heads/agent-b:src/app.ts", "line1\nline2\nbeta\n"],
    ]);
    const binding = {
      async get(_name: string) {
        return {
          readFile: async ({ ref, path }: { ref: string; path: string }) => {
            const key = `${ref}:${path}`;
            if (!contents.has(key)) throw new Error("file not found");
            return contents.get(key)!;
          },
        };
      },
    };
    const backend = new ArtifactsGitBackend(binding as never);
    const res = await backend.mergePreview({
      repo: "repo",
      baseRef: "main",
      refA: "refs/heads/agent-a",
      refB: "refs/heads/agent-b",
      paths: ["src/app.ts"],
    });
    expect(res).toHaveLength(1);
    expect(res[0].path).toBe("src/app.ts");
    expect(res[0].overlap).toBe(false);
    expect(res[0].conflict).toBe(false);
    expect(res[0].merged).toBe("line1\nalpha\nline2\nbeta\n");
  });

  it("mergePreview flags a conflict when both sides change the same line", async () => {
    const contents = new Map<string, string>([
      ["main:src/app.ts", "line1\nline2\n"],
      ["refs/heads/agent-a:src/app.ts", "line1\nalpha\n"],
      ["refs/heads/agent-b:src/app.ts", "line1\nbeta\n"],
    ]);
    const binding = {
      async get(_name: string) {
        return {
          readFile: async ({ ref, path }: { ref: string; path: string }) => {
            const key = `${ref}:${path}`;
            if (!contents.has(key)) throw new Error("file not found");
            return contents.get(key)!;
          },
        };
      },
    };
    const backend = new ArtifactsGitBackend(binding as never);
    const res = await backend.mergePreview({
      repo: "repo",
      baseRef: "main",
      refA: "refs/heads/agent-a",
      refB: "refs/heads/agent-b",
      paths: ["src/app.ts"],
    });
    expect(res[0].conflict).toBe(true);
    expect(res[0].overlap).toBe(true);
    expect(res[0].merged).toBeUndefined();
  });
});
