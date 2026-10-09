// artifacts-mode route tests. Mock ArtifactsBindingLike in-process; no
// network, no git. Exercises the full artifacts task lifecycle:
//   POST /task -> baseline repo + token
//   POST /task/:id/agents -> per-agent forks + tokens
//   agents "push" by writing files into the mock fork repos
//   POST /task/:id/submit -> read-only merge via readFile + pure merge.ts
//   conflict -> arena -> decide -> resolved, then teardown.

import { describe, it, expect } from "vitest";
import { createApp } from "../src/index";
import { InMemoryState, type StateStore } from "../src/storage";
import { ArtifactsGitBackend, type ArtifactsBindingLike, type ArtifactsRepoHandle } from "../src/artifacts-git";

class FakeRepo implements ArtifactsRepoHandle {
  // ref -> path -> content
  files = new Map<string, Map<string, string>>();
  constructor(
    public name: string,
    private binding: FakeBinding,
  ) {
    this.files.set("main", new Map());
  }
  async info() {
    return { remote: `https://artifacts.test/${this.name}.git`, defaultBranch: "main" };
  }
  async createToken(scope: "read" | "write", _ttl: number) {
    return `git-tok-${this.name}-${scope}`;
  }
  async fork(name: string, _opts?: { defaultBranchOnly?: boolean }) {
    const f = new FakeRepo(name, this.binding);
    f.files.set("main", new Map(this.files.get("main")));
    this.binding.repos.set(name, f);
    return {};
  }
  async log(_opts: { ref: string }) {
    return [];
  }
  async readFile(opts: { ref: string; path: string }) {
    const v = this.files.get(opts.ref)?.get(opts.path);
    if (v === undefined) throw new Error(`no such file ${opts.path}@${opts.ref}`);
    return v;
  }
  // test helper: simulate an agent push
  writeFile(ref: string, path: string, content: string) {
    if (!this.files.has(ref)) this.files.set(ref, new Map());
    this.files.get(ref)!.set(path, content);
  }
}

class FakeBinding implements ArtifactsBindingLike {
  repos = new Map<string, FakeRepo>();
  async create(name: string, _opts?: { description?: string; readOnly?: boolean; setDefaultBranch?: string }) {
    const r = new FakeRepo(name, this);
    this.repos.set(name, r);
    return { name, remote: `https://artifacts.test/${name}.git`, token: `create-tok-${name}`, defaultBranch: "main" };
  }
  async get(name: string) {
    const r = this.repos.get(name);
    if (!r) throw new Error(`repo not found: ${name}`);
    return r;
  }
  async list(_opts?: { limit?: number }) {
    return [...this.repos.keys()];
  }
  async delete(name: string) {
    this.repos.delete(name);
  }
}

function makeApp() {
  const binding = new FakeBinding();
  const git = new ArtifactsGitBackend(binding);
  const deps = { state: new InMemoryState(), git, secret: "test-secret" };
  return { app: createApp(() => deps), binding };
}

const SEED = {
  "src/app.ts": 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
  "README.md": "# Merge Arena\n\nAgent-native merge queue.\n",
};

async function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

async function createTask(app: ReturnType<typeof createApp>) {
  const { status, json } = await post(app, "/task", {
    brief: "add farewell helper",
    base: { files: SEED },
  });
  expect(status).toBe(201);
  expect(json.mode).toBe("artifacts");
  return json as {
    task_id: string;
    baseline: { repo: string; remote: string; token: string };
    seed_files: string[];
  };
}

async function createAgents(app: ReturnType<typeof createApp>, taskId: string, names: string[]) {
  const { status, json } = await post(app, `/task/${taskId}/agents`, { agents: names });
  expect(status).toBe(201);
  return json as {
    task_id: string;
    agents: Array<{
      agent_id: string;
      name: string;
      token: string;
      remote: string;
      git_token: string;
      branch: string;
    }>;
  };
}

describe("artifacts mode: task lifecycle", () => {
  it("POST /task creates only the baseline repo and returns its access", async () => {
    const { app, binding } = makeApp();
    const t = await createTask(app);
    expect(t.baseline.repo).toMatch(/^arena-[a-z0-9-]+-base$/);
    expect(t.baseline.remote).toContain(t.baseline.repo);
    expect(t.baseline.token).toBe(`create-tok-${t.baseline.repo}`);
    expect(binding.repos.has(t.baseline.repo)).toBe(true);
    expect(t.seed_files.sort()).toEqual(Object.keys(SEED).sort());

    // GET /task strips the baseline token and agent tokens
    const res = await app.request(`/task/${t.task_id}`);
    expect(res.status).toBe(200);
    const task = (await res.json()) as Record<string, unknown>;
    expect(task.mode).toBe("artifacts");
    expect(task).not.toHaveProperty("baseline_token");
    expect(task.agents).toEqual([]);
  });

  it("POST /task rejects agents at creation in artifacts mode", async () => {
    const { app } = makeApp();
    const { status, json } = await post(app, "/task", { brief: "x", agents: ["a"] });
    expect(status).toBe(400);
    expect(String(json.error)).toContain("/task/:id/agents");
  });

  it("POST /task/:id/agents creates forks with remotes + git tokens", async () => {
    const { app, binding } = makeApp();
    const t = await createTask(app);
    // orchestrator pushes seed files to the baseline first
    const baseline = binding.repos.get(t.baseline.repo)!;
    for (const [p, c] of Object.entries(SEED)) baseline.writeFile("main", p, c);

    const a = await createAgents(app, t.task_id, ["ada", "grace"]);
    expect(a.agents).toHaveLength(2);
    for (const ag of a.agents) {
      expect(ag.token.length).toBeGreaterThan(10); // HMAC submit token
      expect(ag.git_token).toContain("git-tok-");
      expect(ag.remote).toContain(ag.branch);
      expect(binding.repos.has(ag.branch)).toBe(true);
    }

    // second call is rejected (agents already created)
    const dup = await post(app, `/task/${t.task_id}/agents`, { agents: ["x"] });
    expect(dup.status).toBe(409);

    // GET /task strips both token kinds
    const res = await app.request(`/task/${t.task_id}`);
    const task = (await res.json()) as {
      agents: Array<Record<string, unknown>>;
    };
    for (const ag of task.agents) {
      expect(ag).not.toHaveProperty("token");
      expect(ag).not.toHaveProperty("git_token");
      expect(ag).toHaveProperty("remote");
    }
  });

  it("disjoint submissions auto-merge into merged_files", async () => {
    const { app, binding } = makeApp();
    const t = await createTask(app);
    const baseline = binding.repos.get(t.baseline.repo)!;
    for (const [p, c] of Object.entries(SEED)) baseline.writeFile("main", p, c);
    const a = await createAgents(app, t.task_id, ["ada", "grace"]);
    const [ada, grace] = a.agents;

    // ada appends to README in her fork; grace appends a function in hers
    binding.repos.get(ada.branch)!.writeFile("main", "README.md", SEED["README.md"] + "\nAdded by ada.\n");
    binding.repos
      .get(grace.branch)!
      .writeFile(
        "main",
        "src/app.ts",
        SEED["src/app.ts"] + '\nexport function farewell(n: string): string {\n  return `Bye, ${n}!`;\n}\n',
      );

    const s1 = await post(app, `/task/${t.task_id}/submit`, {
      agent_id: ada.agent_id,
      token: ada.token,
      ref: "main",
      files_touched: ["README.md"],
      rationale: "document the queue",
    });
    expect(s1.status).toBe(200);
    expect(s1.json.status).toBe("awaiting_more");

    const s2 = await post(app, `/task/${t.task_id}/submit`, {
      agent_id: grace.agent_id,
      token: grace.token,
      ref: "main",
      files_touched: ["src/app.ts"],
      rationale: "add farewell helper",
    });
    expect(s2.json.status).toBe("auto_merged");

    const res = await app.request(`/task/${t.task_id}`);
    const task = (await res.json()) as Record<string, unknown>;
    expect(task.status).toBe("merged");
    const merged = task.merged_files as Record<string, string>;
    expect(merged["README.md"]).toContain("Added by ada.");
    expect(merged["src/app.ts"]).toContain("farewell");
    expect(merged["src/app.ts"]).toContain("Hello");
  });

  it("conflicting submissions go to the arena with merged-so-far attribution", async () => {
    const { app, binding } = makeApp();
    const t = await createTask(app);
    const baseline = binding.repos.get(t.baseline.repo)!;
    for (const [p, c] of Object.entries(SEED)) baseline.writeFile("main", p, c);
    const a = await createAgents(app, t.task_id, ["ada", "grace", "hopper"]);
    const [ada, grace, hopper] = a.agents;

    // ada + grace: disjoint, merge cleanly
    binding.repos.get(ada.branch)!.writeFile("main", "README.md", SEED["README.md"] + "\nAdded by ada.\n");
    binding.repos.get(grace.branch)!.writeFile("main", "NOTES.md", "# notes\n");
    // hopper: rewrites the greet line -> conflicts with merged-so-far? no:
    // merged-so-far only touched README/NOTES, so hopper's greet change is
    // clean vs merged-so-far... make ada ALSO touch the greet line instead.
    binding.repos
      .get(ada.branch)!
      .writeFile("main", "src/app.ts", SEED["src/app.ts"].replace("Hello", "Hi"));
    binding.repos
      .get(hopper.branch)!
      .writeFile("main", "src/app.ts", SEED["src/app.ts"].replace("Hello", "Hey"));

    const s1 = await post(app, `/task/${t.task_id}/submit`, {
      agent_id: ada.agent_id, token: ada.token, ref: "main",
      files_touched: ["README.md", "src/app.ts"], rationale: "hi greeting + docs",
    });
    expect(s1.json.status).toBe("awaiting_more");

    const s2 = await post(app, `/task/${t.task_id}/submit`, {
      agent_id: grace.agent_id, token: grace.token, ref: "main",
      files_touched: ["NOTES.md"], rationale: "notes file",
    });
    expect(s2.json.status).toBe("auto_merged");
    expect(s2.json.merged_so_far).toBe(true);

    // hopper conflicts with the merged-so-far (ada's "Hi") on the greet line
    const s3 = await post(app, `/task/${t.task_id}/submit`, {
      agent_id: hopper.agent_id, token: hopper.token, ref: "main",
      files_touched: ["src/app.ts"], rationale: "hey greeting",
    });
    expect(s3.status).toBe(200);
    expect(s3.json.status).toBe("arena");
    expect(s3.json.conflicts).toEqual([{ path: "src/app.ts" }]);

    const arenaRes = await app.request(`/task/${t.task_id}/arena`);
    const arena = (await arenaRes.json()) as {
      status: string;
      conflicts: Array<{ path: string; a_name: string; b_name: string; a_excerpt: string; b_excerpt: string }>;
    };
    expect(arena.status).toBe("arena");
    expect(arena.conflicts[0].a_name).toContain("merged so far (2 candidates)");
    expect(arena.conflicts[0].b_name).toBe("hopper");
    expect(arena.conflicts[0].a_excerpt).toContain("Hi,");
    expect(arena.conflicts[0].b_excerpt).toContain("Hey,");

    // human picks hopper -> resolved
    const d = await post(app, `/task/${t.task_id}/decide`, {
      winner_agent_id: hopper.agent_id, rationale: "friendlier",
    });
    expect(d.json.status).toBe("resolved");
    const done = (await (await app.request(`/task/${t.task_id}`)).json()) as Record<string, unknown>;
    expect(done.status).toBe("resolved");
  });

  it("submit validates token, ref, files_touched and rejects duplicates", async () => {
    const { app, binding } = makeApp();
    const t = await createTask(app);
    const baseline = binding.repos.get(t.baseline.repo)!;
    for (const [p, c] of Object.entries(SEED)) baseline.writeFile("main", p, c);
    const a = await createAgents(app, t.task_id, ["ada", "grace"]);
    const [ada, grace] = a.agents;
    binding.repos.get(ada.branch)!.writeFile("main", "README.md", SEED["README.md"] + "x\n");

    const bad = await post(app, `/task/${t.task_id}/submit`, {
      agent_id: ada.agent_id, token: "bogus", ref: "main",
      files_touched: ["README.md"], rationale: "x",
    });
    expect(bad.status).toBe(401);

    const noRef = await post(app, `/task/${t.task_id}/submit`, {
      agent_id: ada.agent_id, token: ada.token, files_touched: ["README.md"], rationale: "x",
    });
    expect(noRef.status).toBe(400);

    const noFiles = await post(app, `/task/${t.task_id}/submit`, {
      agent_id: ada.agent_id, token: ada.token, ref: "main", files_touched: [], rationale: "x",
    });
    expect(noFiles.status).toBe(400);

    const ok = await post(app, `/task/${t.task_id}/submit`, {
      agent_id: ada.agent_id, token: ada.token, ref: "main",
      files_touched: ["README.md"], rationale: "x",
    });
    expect(ok.json.status).toBe("awaiting_more");

    const dup = await post(app, `/task/${t.task_id}/submit`, {
      agent_id: ada.agent_id, token: ada.token, ref: "main",
      files_touched: ["README.md"], rationale: "x",
    });
    expect(dup.status).toBe(409);

    // grace's token can't be used for ada... and unknown agent rejected
    const wrong = await post(app, `/task/${t.task_id}/submit`, {
      agent_id: "agent-99", token: grace.token, ref: "main",
      files_touched: ["README.md"], rationale: "x",
    });
    expect(wrong.status).toBe(400);
  });

  it("submit retries once when another writer bumps rev mid-flight", async () => {
    // Simulates the cross-isolate race: transact's re-read sees a rev that
    // moved since its first read (another isolate won the race). The op must
    // retry against the fresh record and succeed — never silently drop the
    // other writer's submission.
    const binding = new FakeBinding();
    const inner = new InMemoryState();
    let gets = 0;
    const racy: StateStore = {
      get: async <T>(k: string): Promise<T | null> => {
        gets++;
        const v = await inner.get<T>(k);
        if (k.startsWith("task:") && gets === 2 && v) {
          const t = v as unknown as { rev: number };
          return { ...(v as object), rev: t.rev + 1 } as T;
        }
        return v;
      },
      put: (k: string, v: unknown) => inner.put(k, v),
      delete: (k: string) => inner.delete(k),
      list: (p: string) => inner.list(p),
    };
    const git = new ArtifactsGitBackend(binding);
    const app = createApp(() => ({ state: racy, git, secret: "test-secret" }));

    const t = await createTask(app);
    const baseline = binding.repos.get(t.baseline.repo)!;
    for (const [p, c] of Object.entries(SEED)) baseline.writeFile("main", p, c);
    const a = await createAgents(app, t.task_id, ["ada"]);
    const [ada] = a.agents;
    binding.repos.get(ada.branch)!.writeFile("main", "README.md", SEED["README.md"] + "x\n");

    gets = 0; // only the submit's transact sees the forced race
    const s = await post(app, `/task/${t.task_id}/submit`, {
      agent_id: ada.agent_id,
      token: ada.token,
      ref: "main",
      files_touched: ["README.md"],
      rationale: "docs",
    });
    expect(s.status).toBe(200);
    expect(s.json.status).toBe("awaiting_more");

    const res = await app.request(`/task/${t.task_id}`);
    const task = (await res.json()) as { rev: number; submissions: Array<{ agent_id: string }> };
    expect(task.rev).toBe(3); // 1 (create) + 1 (agents) + 1 (submit, after retry)
    expect(task.submissions).toHaveLength(1);
  });

  it("teardown deletes the task repos and record", async () => {
    const { app, binding } = makeApp();
    const t = await createTask(app);
    const baseline = binding.repos.get(t.baseline.repo)!;
    for (const [p, c] of Object.entries(SEED)) baseline.writeFile("main", p, c);
    const a = await createAgents(app, t.task_id, ["ada"]);
    const forks = a.agents.map((x) => x.branch);

    const td = await post(app, `/task/${t.task_id}/teardown`, {});
    expect(td.json.ok).toBe(true);
    expect(binding.repos.has(t.baseline.repo)).toBe(false);
    for (const f of forks) expect(binding.repos.has(f)).toBe(false);

    const res = await app.request(`/task/${t.task_id}`);
    expect(res.status).toBe(404);
  });

  it("local-mode routes reject artifacts-only endpoints", async () => {
    const { createApp: mk } = await import("../src/index");
    const { InMemoryState: S } = await import("../src/storage");
    const { LocalGitBackend } = await import("../src/git-backend");
    const git = new LocalGitBackend();
    const deps = { state: new S(), git, secret: "s" };
    const localApp = mk(() => deps);
    try {
      // create a real local-mode task first
      const created = await post(localApp, "/task", { brief: "local task", agents: ["solo"] });
      expect(created.status).toBe(201);
      const taskId = (created.json as { task_id: string }).task_id;
      const r = await post(localApp, `/task/${taskId}/agents`, { agents: ["a"] });
      expect(r.status).toBe(400); // agents are created with the task in local mode
      const r2 = await post(localApp, `/task/${taskId}/teardown`, {});
      expect(r2.status).toBe(400); // teardown is artifacts-only
      const r3 = await post(localApp, "/task/nope/teardown", {});
      expect(r3.status).toBe(404); // unknown task
    } finally {
      await git.cleanup();
    }
  });
});
