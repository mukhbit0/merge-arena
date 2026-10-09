// Merge Arena — agent-native merge queue (worker-core phase).
//
// Routes are built by createApp(resolveDeps) so tests can inject in-memory
// state + fixture git backend via app.request, no server needed. In the
// Workers runtime the default export resolves deps per request from env:
// STATE_KV (deploy phase) swaps the state store, and the artifacts phase will
// swap LocalGitBackend for an Artifacts-backed git backend — routes stay the
// same because they only talk to the Deps interfaces.

import { Hono, type Context } from "hono";
import { getState } from "./storage";
import { LocalGitBackend, defaultFixtureFiles, type GitBackend } from "./git-backend";
import { ArtifactsGitBackend, type ArtifactsBindingLike } from "./artifacts-git";
import { issueToken, verifyToken, getSecret } from "./tokens";
import { filesTouchedBy, diffStat, excerpt } from "./diffutil";
import type { Deps, Env, TaskRecord, AgentBrief, Submission, StoredConflict } from "./types";

const taskKey = (id: string) => `task:${id}`;
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_AGENTS = 8;

type AppContext = Context<{ Bindings: Env; Variables: { deps: Deps } }>;

const taskLocks = new Map<string, Promise<void>>();
function withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const prev = taskLocks.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const cur = new Promise<void>((res) => {
    release = res;
  });
  taskLocks.set(taskId, prev.then(() => cur));
  return prev.then(fn).finally(() => release());
}

let gitSingleton: GitBackend | null = null;
function defaultGit(): GitBackend {
  if (!gitSingleton) gitSingleton = new LocalGitBackend();
  return gitSingleton;
}

export function getDeps(env: Env): Deps {
  return { state: getState(env), git: defaultGit(), secret: getSecret(env) };
}

/**
 * Artifacts git backend, when the ARTIFACTS binding is configured (deploy
 * phase). Kept separate from Deps because the artifacts merge path differs:
 * agents push to fork remotes with minted git tokens (see artifacts-git.ts).
 * Not wired into routes yet — the deploy phase verifies the binding live.
 */
export function getArtifactsGit(env: Env): ArtifactsGitBackend | null {
  const binding = (env as { ARTIFACTS?: ArtifactsBindingLike }).ARTIFACTS;
  return binding ? new ArtifactsGitBackend(binding) : null;
}

function defaultSeedFiles(): Record<string, string> {
  return defaultFixtureFiles();
}

function stripTokens(task: TaskRecord) {
  return {
    ...task,
    agents: task.agents.map(({ token: _t, ...a }) => a),
  };
}

export function createApp(resolve: (env: Env) => Deps = getDeps) {
  const app = new Hono<{ Bindings: Env; Variables: { deps: Deps } }>();

  app.use("*", async (c, next) => {
    c.set("deps", resolve(c.env));
    await next();
  });

  app.get("/", (c) =>
    c.json({
      service: "merge-arena",
      status: "ok",
      version: "0.1.0",
      endpoints: [
        "GET /health",
        "POST /task",
        "GET /task/:id",
        "POST /task/:id/submit",
        "GET /task/:id/arena",
        "POST /task/:id/decide",
        "GET /task/:id/ci",
        "POST /task/:id/ci/:sha",
      ],
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  // --- Task lifecycle -------------------------------------------------------

  app.post("/task", async (c) => {
    const deps = c.get("deps");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const brief = typeof body.brief === "string" ? body.brief.trim() : "";
    const names = Array.isArray(body.agents)
      ? body.agents.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
      : [];
    if (!brief) return c.json({ error: "brief is required" }, 400);
    if (names.length === 0) return c.json({ error: "agents must be a non-empty array of names" }, 400);
    if (names.length > MAX_AGENTS) return c.json({ error: `max ${MAX_AGENTS} agents per task` }, 400);

    const taskId = crypto.randomUUID().slice(0, 8);
    const base = body.base as { files?: Record<string, string> } | undefined;
    const seedFiles =
      base?.files && typeof base.files === "object" ? base.files : defaultSeedFiles();
    const { repoDir, baseRef } = await deps.git.seedFixture(taskId, seedFiles);
    // Running merged-result branch: every clean submission is adopted into
    // it, so N agents merge incrementally instead of only the first two.
    const { branch: mergeBranch } = deps.git.createWorktree(taskId, "merged");

    const agents: AgentBrief[] = [];
    for (let i = 0; i < names.length; i++) {
      const agentId = `agent-${i + 1}`;
      const { branch } = deps.git.createWorktree(taskId, agentId);
      const token = await issueToken(deps.secret, {
        taskId,
        agentId,
        scopes: ["submit"],
        exp: Date.now() + TOKEN_TTL_MS,
      });
      agents.push({ agent_id: agentId, name: names[i].trim(), token, branch, brief });
    }

    const task: TaskRecord = {
      id: taskId,
      brief,
      status: "collecting",
      created_at: new Date().toISOString(),
      repo_dir: repoDir,
      base_ref: baseRef,
      merge_branch: mergeBranch,
      agents,
      submissions: [],
    };
    await deps.state.put(taskKey(taskId), task);
    return c.json({ task_id: taskId, status: task.status, agents }, 201);
  });

  app.get("/task/:id", async (c) => {
    const deps = c.get("deps");
    const task = await deps.state.get<TaskRecord>(taskKey(c.req.param("id")));
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json(stripTokens(task));
  });

  // --- Submissions ----------------------------------------------------------

  app.post("/task/:id/submit", async (c) => {
    const id = c.req.param("id");
    return withTaskLock(id, () => submitInner(c, id));
  });

  async function submitInner(c: AppContext, id: string) {
    const deps = c.get("deps");
    const task = await deps.state.get<TaskRecord>(taskKey(id));
    if (!task) return c.json({ error: "task not found" }, 404);
    if (task.status !== "collecting") {
      return c.json({ error: `task is ${task.status}, not accepting submissions` }, 409);
    }

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const agentId = body.agent_id;
    const token = body.token;
    const diff = body.diff;
    const rationale = body.rationale;
    if (typeof diff !== "string" || !diff.trim()) {
      return c.json({ error: "diff (unified diff string) is required" }, 400);
    }
    if (typeof rationale !== "string" || !rationale.trim()) {
      return c.json({ error: "rationale is required" }, 400);
    }
    const agent = task.agents.find((a) => a.agent_id === agentId);
    if (!agent) return c.json({ error: "unknown agent_id" }, 400);
    const payload = typeof token === "string" ? await verifyToken(deps.secret, token) : null;
    if (
      !payload ||
      payload.taskId !== id ||
      payload.agentId !== agentId ||
      !payload.scopes.includes("submit")
    ) {
      return c.json({ error: "invalid or unauthorized token" }, 401);
    }
    if (task.submissions.some((s) => s.agent_id === agentId)) {
      return c.json({ error: "agent already submitted" }, 409);
    }

    try {
      await deps.git.applyDiff(agent.branch, diff);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }

    const submission: Submission = {
      agent_id: agentId,
      branch: agent.branch,
      diff,
      rationale: rationale.trim(),
      files_touched: filesTouchedBy(diff),
      diff_stat: diffStat(diff),
      submitted_at: new Date().toISOString(),
    };
    task.submissions.push(submission);

    // Adopt the new candidate into the running merged result. Clean ->
    // keep collecting (or finish "merged" when every agent submitted);
    // conflict -> arena path with the merged-so-far side vs the newcomer.
    const res = await deps.git.adoptMerge(task.base_ref, agent.branch, task.merge_branch);
    if (res.clean) {
      task.merged_diff = res.mergedDiff ?? "";
      if (task.submissions.length < 2) {
        await deps.state.put(taskKey(id), task);
        return c.json({ status: "awaiting_more", task_id: id, submitted: task.submissions.length });
      }
      const remaining = task.agents.length - task.submissions.length;
      await deps.state.put(taskKey(id), task);
      if (remaining <= 0) {
        task.status = "merged";
        await deps.state.put(taskKey(id), task);
        return c.json({ status: "auto_merged", task_id: id, merged_diff: task.merged_diff });
      }
      return c.json({
        status: "auto_merged",
        task_id: id,
        merged_so_far: true,
        awaiting: remaining,
        merged_diff: task.merged_diff,
      });
    }

    const mergedCount = task.submissions.length - 1;
    const conflicts: StoredConflict[] = res.conflicts.map((k) => ({
      path: k.path,
      first_agent_id: "merged",
      first_label: `merged so far (${mergedCount} candidate${mergedCount === 1 ? "" : "s"})`,
      first_text: k.ours, // mergeBranch side: the running merged result
      second_agent_id: agentId,
      second_text: k.theirs, // candidate side: the newcomer
    }));
    task.status = "arena";
    task.conflicts = conflicts;
    await deps.state.put(taskKey(id), task);
    return c.json({
      status: "arena",
      task_id: id,
      conflicts: conflicts.map((k) => ({ path: k.path })),
    });
  }

  // --- Arena view + human decision --------------------------------------------

  app.get("/task/:id/arena", async (c) => {
    const deps = c.get("deps");
    const task = await deps.state.get<TaskRecord>(taskKey(c.req.param("id")));
    if (!task) return c.json({ error: "task not found" }, 404);
    const nameOf = (agentId: string) =>
      task.agents.find((a) => a.agent_id === agentId)?.name ?? agentId;
    return c.json({
      task_id: task.id,
      status: task.status,
      candidates: task.submissions.map((s) => ({
        agent_id: s.agent_id,
        name: nameOf(s.agent_id),
        rationale: s.rationale,
        files_touched: s.files_touched,
        diff_stat: s.diff_stat,
      })),
      conflicts: (task.conflicts ?? []).map((k) => ({
        path: k.path,
        a_agent_id: k.first_agent_id,
        a_name: k.first_label ?? nameOf(k.first_agent_id),
        a_excerpt: excerpt(k.first_text),
        b_agent_id: k.second_agent_id,
        b_name: nameOf(k.second_agent_id),
        b_excerpt: excerpt(k.second_text),
      })),
    });
  });

  app.post("/task/:id/decide", async (c) => {
    const id = c.req.param("id");
    return withTaskLock(id, () => decideInner(c, id));
  });

  async function decideInner(c: AppContext, id: string) {
    const deps = c.get("deps");
    const task = await deps.state.get<TaskRecord>(taskKey(id));
    if (!task) return c.json({ error: "task not found" }, 404);
    if (task.status !== "arena") {
      return c.json({ error: `task is ${task.status}, nothing to decide` }, 409);
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const winnerId = body.winner_agent_id;
    const winning = task.submissions.find((s) => s.agent_id === winnerId);
    if (!winning) return c.json({ error: "winner_agent_id must be a submitted candidate" }, 400);
    task.status = "resolved";
    task.result = {
      winner_agent_id: winning.agent_id,
      winning_diff: winning.diff,
      decided_by: typeof body.decided_by === "string" ? body.decided_by : "human",
      rationale: typeof body.rationale === "string" ? body.rationale : undefined,
      decided_at: new Date().toISOString(),
    };
    await deps.state.put(taskKey(id), task);
    return c.json({ status: "resolved", task_id: id, winner_agent_id: winning.agent_id });
  }

  // --- CI runs (written by the merge-arena-ci queue consumer) ----------------

  app.get("/task/:id/ci", async (c) => {
    const deps = c.get("deps");
    const id = c.req.param("id");
    const task = await deps.state.get<TaskRecord>(taskKey(id));
    if (!task) return c.json({ error: "task not found" }, 404);
    const runs: Array<Record<string, unknown>> = [];
    for (const k of await deps.state.list(`ci:${id}:`)) {
      if (k.endsWith(":latest")) continue;
      const r = await deps.state.get<Record<string, unknown>>(k);
      if (r) runs.push(r);
    }
    runs.sort((a, b) => String(b.received_at ?? "").localeCompare(String(a.received_at ?? "")));
    return c.json({ task_id: id, runs });
  });

  // CI runner reports back on a run recorded from a push event.
  app.post("/task/:id/ci/:sha", async (c) => {
    const deps = c.get("deps");
    const id = c.req.param("id");
    const sha = c.req.param("sha");
    const key = `ci:${id}:${sha}`;
    const rec = await deps.state.get<Record<string, unknown>>(key);
    if (!rec) return c.json({ error: "ci run not found" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!["running", "passed", "failed"].includes(String(body.status))) {
      return c.json({ error: "status must be one of running|passed|failed" }, 400);
    }
    rec.status = body.status;
    if (typeof body.preview_url === "string") rec.preview_url = body.preview_url;
    await deps.state.put(key, rec);
    return c.json({ ok: true, task_id: id, sha, status: rec.status });
  });

  return app;
}

const app = createApp();
export default app;
