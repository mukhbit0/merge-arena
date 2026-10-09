// DEMO (demo phase): three agents push concurrently. One conflict goes to
// the arena, a CI push event is recorded, a human picks the winner.
// Run: npx vitest run test/demo.test.ts
// The transcript is printed and saved to demo/TRANSCRIPT.md (video phase raw material).

import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { createApp } from "../src/index";
import { InMemoryState, getState } from "../src/storage";
import { LocalGitBackend } from "../src/git-backend";
import { handleBatch } from "../../ci-worker/src/index";

const backends: LocalGitBackend[] = [];
afterAll(async () => {
  for (const g of backends) await g.cleanup();
});

const lines: string[] = [];
const say = (s: string) => {
  lines.push(s);
  console.log(s);
};

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

describe("demo: 3 agents push concurrently", () => {
  it("conflict -> arena -> CI event -> human pick -> resolved", async () => {
    const git = new LocalGitBackend();
    backends.push(git);
    // Shared in-memory store: the ci-worker handler writes through the same
    // getState({}) singleton local dev uses.
    const state = getState({});
    const app = createApp(() => ({ state, git, secret: "demo-secret" }));

    say("## Merge Arena demo transcript");
    say("");
    say("### 1. Task created — brief: 'Greet the user; add a farewell helper'");
    const created = await (
      await app.request("/task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: "Greet the user; add a farewell helper", agents: ["ada", "grace", "hopper"] }),
      })
    ).json() as { task_id: string; agents: Array<{ agent_id: string; name: string; token: string }> };
    const taskId = created.task_id;
    say(`task ${taskId}, agents: ${created.agents.map((a) => `${a.name} (${a.agent_id})`).join(", ")}`);
    const byName = Object.fromEntries(created.agents.map((a) => [a.name, a]));

    say("");
    say("### 2. All three agents push CONCURRENTLY (Promise.all)");
    const submit = (agent: { agent_id: string; token: string }, d: string, rationale: string) =>
      app
        .request(`/task/${taskId}/submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: agent.agent_id, token: agent.token, diff: d, rationale }),
        })
        .then(async (r) => ({ agent: agent.agent_id, http: r.status, body: (await r.json()) as Record<string, unknown> }));
    const results = await Promise.all([
      submit(byName.ada, FAREWELL_DIFF, "adds a farewell helper at the end of the file"),
      submit(byName.grace, HI_DIFF, "friendlier greeting: Hi instead of Hello"),
      submit(byName.hopper, HEY_DIFF, "casual greeting: Hey instead of Hello"),
    ]);
    for (const r of results) say(`- ${r.agent}: HTTP ${r.http} -> status=${r.body.status}`);
    expect(results.every((r) => r.http === 200)).toBe(true);

    const task = (await (await app.request(`/task/${taskId}`)).json()) as {
      status: string;
      submissions: Array<{ agent_id: string }>;
    };
    say(`task status after concurrent push: ${task.status} (${task.submissions.length} submissions)`);
    expect(task.submissions).toHaveLength(3); // no lost submissions under concurrency
    expect(task.status).toBe("arena");

    say("");
    say("### 3. Arena: exactly one conflict — merged-so-far vs the newcomer");
    const arena = (await (await app.request(`/task/${taskId}/arena`)).json()) as {
      conflicts: Array<{ path: string; a_name: string; b_name: string; b_agent_id: string }>;
      candidates: Array<{ name: string; rationale: string }>;
    };
    expect(arena.conflicts).toHaveLength(1);
    const k = arena.conflicts[0];
    say(`- conflict in ${k.path}`);
    say(`- side A: ${k.a_name}`);
    say(`- side B: ${k.b_name} (${k.b_agent_id})`);
    expect(k.path).toBe("src/app.ts");
    expect(k.a_name).toContain("merged so far (2 candidates)");
    for (const c of arena.candidates) say(`- candidate ${c.name}: "${c.rationale}"`);

    say("");
    say("### 4. CI: push event arrives on the queue, run recorded, test runner reports pass");
    const sha = "deadbee";
    await handleBatch(
      {
        messages: [
          {
            body: {
              type: "cf.artifacts.repo.pushed",
              source: { type: "artifacts.repo", namespace: "merge-arena", repoName: `arena-${taskId}-${k.b_agent_id}` },
              payload: { ref: "refs/heads/main", before: "abc", after: sha, commits: [{ id: sha, message: "candidate" }], totalCommitsCount: 1 },
            },
            ack: () => {},
            retry: () => {},
          },
        ],
      },
      { CI_NAMESPACE: "merge-arena" },
    );
    const ci1 = (await (await app.request(`/task/${taskId}/ci`)).json()) as {
      runs: Array<{ sha: string; status: string }>;
    };
    say(`- CI runs: ${ci1.runs.map((r) => `${r.sha.slice(0, 7)}:${r.status}`).join(", ")}`);
    expect(ci1.runs.some((r) => r.sha === sha && r.status === "received")).toBe(true);
    await app.request(`/task/${taskId}/ci/${sha}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "passed", preview_url: `https://preview.example/arena/${taskId}` }),
    });
    const ci2 = (await (await app.request(`/task/${taskId}/ci`)).json()) as { runs: Array<{ status: string; preview_url: string }> };
    say(`- after test runner: ${ci2.runs[0].status}, preview ${ci2.runs[0].preview_url}`);
    expect(ci2.runs[0].status).toBe("passed");

    say("");
    say("### 5. Human pick: the newcomer wins");
    const decide = await (
      await app.request(`/task/${taskId}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ winner_agent_id: k.b_agent_id, decided_by: "demo-human", rationale: "casual tone fits the product" }),
      })
    ).json() as { status: string; winner_agent_id: string };
    say(`- decided: ${decide.status}, winner ${decide.winner_agent_id}`);
    expect(decide.status).toBe("resolved");
    expect(decide.winner_agent_id).toBe(k.b_agent_id);

    say("");
    say("### Demo complete: 3 concurrent pushes, 1 real conflict, CI green, human resolved it.");

    mkdirSync(new URL("../../demo/", import.meta.url), { recursive: true });
    writeFileSync(new URL("../../demo/TRANSCRIPT.md", import.meta.url), lines.join("\n") + "\n");
  }, 60000);
});
