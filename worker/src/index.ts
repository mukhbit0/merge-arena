// Merge Arena — agent-native merge queue (worker-core phase).
//
// Routes are built by createApp(resolveDeps) so tests can inject in-memory
// state + fixture git backend via app.request, no server needed. In the
// Workers runtime the default export resolves deps per request from env:
// STATE_KV (deploy phase) swaps the state store, and the ARTIFACTS binding
// swaps LocalGitBackend for the Artifacts-backed git backend — routes branch
// on `instanceof ArtifactsGitBackend` for the two task modes:
//
//   local     — agents submit unified diffs; the worker applies/merges them
//               with real git (tests / local dev only; workerd has no git).
//   artifacts — one baseline Artifacts repo per task + one fork per agent.
//               Agents are real git clients (clone/push with minted tokens);
//               the worker merges read-only via readFile + pure merge.ts and
//               keeps the running merged result in KV.

import { Hono, type Context } from "hono";
import { getState } from "./storage";
import { LocalGitBackend, defaultFixtureFiles, type GitBackend } from "./git-backend";
import { ArtifactsGitBackend, type ArtifactsBindingLike } from "./artifacts-git";
import { issueToken, verifyToken, getSecret } from "./tokens";
import { filesTouchedBy, diffStat, excerpt } from "./diffutil";
import { mergeFile } from "./merge";
import type { Deps, Env, TaskRecord, AgentBrief, Submission, StoredConflict, TaskMode } from "./types";

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

const MAX_TXN_ATTEMPTS = 6;

/**
 * Optimistic-concurrency transaction over a task record.
 *
 * withTaskLock only serializes within ONE workerd isolate; concurrent
 * requests can land in different isolates and interleave read-modify-write
 * on KV (production bug 2026-10-10: 3 concurrent submits, last-write-wins).
 * fn receives the fresh task (or null) and returns {commit, response}:
 * commit=null means "read-only outcome, nothing to write". When committing,
 * we re-read the record and only put when `rev` is unchanged, else retry
 * the whole op. Exhaustion returns 409 (client retries the request).
 */
async function transact(
  c: AppContext,
  id: string,
  fn: (
    task: TaskRecord | null,
  ) => Promise<{ commit: TaskRecord | null; response: Response }>,
): Promise<Response> {
  const deps = c.get("deps");
  for (let attempt = 0; attempt < MAX_TXN_ATTEMPTS; attempt++) {
    const task = await deps.state.get<TaskRecord>(taskKey(id));
    const { commit, response } = await fn(task);
    if (!commit) return response;
    const rev = task?.rev ?? 0;
    const cur = await deps.state.get<TaskRecord>(taskKey(id));
    if ((cur?.rev ?? 0) !== rev) continue; // lost the race — retry
    commit.rev = rev + 1;
    await deps.state.put(taskKey(id), commit);
    return response;
  }
  return c.json({ error: "concurrent modification, please retry the request" }, 409);
}

let gitSingleton: GitBackend | ArtifactsGitBackend | null = null;

/**
 * Backend selection: the ARTIFACTS binding (deploy phase) means the live
 * Artifacts-backed task mode; without it we fall back to LocalGitBackend
 * (tests / local dev). The binding is per-env, so this is stable per Worker.
 */
function defaultGit(env: Env): GitBackend | ArtifactsGitBackend {
  const artifacts = getArtifactsGit(env);
  if (artifacts) return artifacts;
  if (!gitSingleton || gitSingleton instanceof ArtifactsGitBackend) {
    gitSingleton = new LocalGitBackend();
  }
  return gitSingleton;
}

export function getDeps(env: Env): Deps {
  return { state: getState(env), git: defaultGit(env), secret: getSecret(env) };
}

/**
 * Artifacts git backend, when the ARTIFACTS binding is configured (deploy
 * phase). Routes branch on `instanceof ArtifactsGitBackend` because the
 * artifacts merge path differs: agents push to fork remotes with minted git
 * tokens (see artifacts-git.ts); the Worker merges read-only via readFile +
 * pure merge.ts and keeps the running merged result in the task record.
 */
export function getArtifactsGit(env: Env): ArtifactsGitBackend | null {
  const binding = env.ARTIFACTS as ArtifactsBindingLike | undefined;
  return binding ? new ArtifactsGitBackend(binding) : null;
}

const isArtifacts = (g: Deps["git"]): g is ArtifactsGitBackend => g instanceof ArtifactsGitBackend;

function defaultSeedFiles(): Record<string, string> {
  return defaultFixtureFiles();
}

function stripTokens(task: TaskRecord) {
  const { baseline_token: _bt, ...rest } = task;
  return {
    ...rest,
    agents: task.agents.map(({ token: _t, git_token: _g, ...a }) => a),
  };
}

/** Read a file at a ref, treating "missing" as empty (added/deleted file). */
async function readFileOrEmpty(
  git: ArtifactsGitBackend,
  repoName: string,
  ref: string,
  path: string,
): Promise<string> {
  try {
    return await git.readFile(repoName, ref, path);
  } catch {
    return "";
  }
}

export function createApp(resolve: (env: Env) => Deps = getDeps) {
  const app = new Hono<{ Bindings: Env; Variables: { deps: Deps } }>();

  app.onError((err, c) => {
    // Detailed 500s: this is a demo/competition worker; the message is what
    // lets the orchestrator (and us) diagnose a bad backend shape fast.
    const detail = err instanceof Error ? err.message : String(err);
    return c.json({ error: "internal", detail: detail.slice(0, 300) }, 500);
  });

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
        "POST /task/:id/agents        (artifacts mode: create forks after seeding)",
        "POST /task/:id/submit",
        "POST /task/:id/fold           (drive convergence after concurrent submits)",
        "GET /task/:id/arena",
        "POST /task/:id/decide",
        "POST /task/:id/teardown      (artifacts mode: delete task repos)",
        "GET /task/:id/ci",
        "POST /task/:id/ci/:sha",
      ],
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  // --- Task lifecycle -------------------------------------------------------
  //
  // Local mode: POST /task {brief, agents:[names], base?} creates the fixture
  // repo + per-agent worktrees immediately (agents submit diffs to /submit).
  //
  // Artifacts mode: POST /task {brief, base:{files}} creates ONLY the empty
  // baseline repo and returns it with a full-access token. The orchestrator
  // pushes the seed files to `main`, THEN calls POST /task/:id/agents to
  // create the per-agent forks. Forking must happen after seeding, otherwise
  // agents would clone empty forks.

  app.post("/task", async (c) => {
    const deps = c.get("deps");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const brief = typeof body.brief === "string" ? body.brief.trim() : "";
    const names = Array.isArray(body.agents)
      ? body.agents.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
      : [];
    if (!brief) return c.json({ error: "brief is required" }, 400);

    const taskId = crypto.randomUUID().slice(0, 8);
    const base = body.base as { files?: Record<string, string> } | undefined;
    const seedFiles =
      base?.files && typeof base.files === "object" ? base.files : defaultSeedFiles();

    if (isArtifacts(deps.git)) {
      if (names.length > 0) {
        return c.json(
          {
            error:
              "in artifacts mode create agents via POST /task/:id/agents after pushing seed files",
          },
          400,
        );
      }
      const { repoDir, baseRef, access } = await deps.git.seedFixture(taskId, seedFiles);
      const task: TaskRecord = {
        id: taskId,
        mode: "artifacts",
        brief,
        status: "collecting",
        rev: 1,
        created_at: new Date().toISOString(),
        repo_dir: repoDir,
        base_ref: baseRef,
        seed_files: seedFiles,
        merged_files: {},
        baseline_token: access.token,
        agents: [],
        submissions: [],
        folded: [],
      };
      await deps.state.put(taskKey(taskId), task);
      return c.json(
        {
          task_id: taskId,
          mode: "artifacts",
          status: task.status,
          baseline: { repo: access.name, remote: access.remote, token: access.token },
          seed_hint: `push seed files to the "${baseRef}" branch, then POST /task/:id/agents`,
          seed_files: Object.keys(seedFiles),
        },
        201,
      );
    }

    // --- local mode ---
    if (names.length === 0) return c.json({ error: "agents must be a non-empty array of names" }, 400);
    if (names.length > MAX_AGENTS) return c.json({ error: `max ${MAX_AGENTS} agents per task` }, 400);

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
      mode: "local",
      brief,
      status: "collecting",
      rev: 1,
      created_at: new Date().toISOString(),
      repo_dir: repoDir,
      base_ref: baseRef,
      merge_branch: mergeBranch,
      agents,
      submissions: [],
      folded: [],
    };
    await deps.state.put(taskKey(taskId), task);
    return c.json({ task_id: taskId, mode: "local", status: task.status, agents }, 201);
  });

  app.get("/task/:id", async (c) => {
    const deps = c.get("deps");
    const task = await deps.state.get<TaskRecord>(taskKey(c.req.param("id")));
    if (!task) return c.json({ error: "task not found" }, 404);
    return c.json(stripTokens(task));
  });

  // Artifacts mode only: create per-agent forks AFTER the orchestrator has
  // pushed the seed files to the baseline repo. Returns each agent's scoped
  // submit token plus the fork remote + short-lived git write token (once).
  app.post("/task/:id/agents", async (c) => {
    const id = c.req.param("id");
    return withTaskLock(id, () =>
      transact(c, id, async (task) => {
        const deps = c.get("deps");
        if (!task) return { commit: null, response: c.json({ error: "task not found" }, 404) };
        if (task.mode !== "artifacts" || !isArtifacts(deps.git)) {
          return {
            commit: null,
            response: c.json({ error: "agents are created with the task in local mode" }, 400),
          };
        }
        if (task.status !== "collecting") {
          return {
            commit: null,
            response: c.json({ error: `task is ${task.status}, not accepting new agents` }, 409),
          };
        }
        if (task.agents.length > 0) {
          return {
            commit: null,
            response: c.json({ error: "agents already created for this task" }, 409),
          };
        }
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        const names = Array.isArray(body.agents)
          ? body.agents.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
          : [];
        if (names.length === 0) {
          return {
            commit: null,
            response: c.json({ error: "agents must be a non-empty array of names" }, 400),
          };
        }
        if (names.length > MAX_AGENTS) {
          return {
            commit: null,
            response: c.json({ error: `max ${MAX_AGENTS} agents per task` }, 400),
          };
        }

        const agents: AgentBrief[] = [];
        for (let i = 0; i < names.length; i++) {
          const agentId = `agent-${i + 1}`;
          const { branch, remote, gitToken } = await deps.git.createWorktree(id, agentId);
          const token = await issueToken(deps.secret, {
            taskId: id,
            agentId,
            scopes: ["submit"],
            exp: Date.now() + TOKEN_TTL_MS,
          });
          agents.push({
            agent_id: agentId,
            name: names[i].trim(),
            token,
            branch,
            brief: task.brief,
            remote,
            git_token: gitToken,
          });
        }
        task.agents = agents;
        return {
          commit: task,
          response: c.json({ task_id: id, mode: "artifacts", agents }, 201),
        };
      }),
    );
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
    const rationale = body.rationale;
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
    if (await deps.state.get(subKey(id, agent.agent_id))) {
      return c.json({ error: "agent already submitted" }, 409);
    }

    // Mode-specific payload. Local: the worker applies the diff. Artifacts:
    // the agent pushed to its fork; the worker merges from the fork ref.
    let submission: Submission & { ref?: string };
    if (task.mode === "artifacts" && isArtifacts(deps.git)) {
      const ref = body.ref;
      const filesTouched = Array.isArray(body.files_touched)
        ? body.files_touched.filter((p): p is string => typeof p === "string" && p.length > 0)
        : [];
      if (typeof ref !== "string" || !ref.trim()) {
        return c.json({ error: "ref (pushed fork ref) is required" }, 400);
      }
      if (filesTouched.length === 0) {
        return c.json({ error: "files_touched (non-empty array of paths) is required" }, 400);
      }
      const diff = typeof body.diff === "string" ? body.diff : "";
      submission = {
        agent_id: agent.agent_id,
        branch: agent.branch, // fork repo name
        diff,
        rationale: rationale.trim(),
        files_touched: filesTouched,
        diff_stat: diff ? diffStat(diff) : { additions: 0, deletions: 0 },
        submitted_at: new Date().toISOString(),
        ref: ref.trim(),
      };
    } else {
      const diff = body.diff;
      if (typeof diff !== "string" || !diff.trim()) {
        return c.json({ error: "diff (unified diff string) is required" }, 400);
      }
      submission = {
        agent_id: agent.agent_id,
        branch: agent.branch,
        diff,
        rationale: rationale.trim(),
        files_touched: filesTouchedBy(diff),
        diff_stat: diffStat(diff),
        submitted_at: new Date().toISOString(),
      };
    }

    // The submission is recorded under its own immutable key FIRST, so a
    // lost fold never loses the submission itself. Folding (the
    // read-modify-write) is deterministic and idempotent: concurrent folds
    // converge, and the orchestrator can always drive it via POST /fold.
    await deps.state.put(subKey(id, agent.agent_id), submission);
    const res = await foldTaskInner(c, id);
    if (res.status === 409) {
      // Fold is contended; the submission is safely recorded — the
      // orchestrator retries the fold.
      return c.json({ status: "recorded", task_id: id, fold: "pending" }, 202);
    }
    return res;
  }

  /** Immutable per-agent submission key. Never read-modify-written. */
  const subKey = (taskId: string, agentId: string) => `sub:${taskId}:${agentId}`;

  type TxnOut = Promise<{ commit: TaskRecord | null; response: Response }>;

  /**
   * Fold every recorded-but-unfolded submission into the running merged
   * result. Deterministic and idempotent: folding the same set twice yields
   * the same record, so concurrent folds (or a retry after a lost race)
   * converge instead of corrupting. Runs inside transact()'s rev-guarded
   * write; the in-isolate withTaskLock serializes the single-isolate case.
   */
  function foldTaskInner(c: AppContext, id: string): Promise<Response> {
    // Note: callers hold withTaskLock(id); do NOT nest another (deadlock).
    return transact(c, id, (task) => foldTxn(c, id, task));
  }

  async function foldTxn(c: AppContext, id: string, task: TaskRecord | null): TxnOut {
    const deps = c.get("deps");
    if (!task) return { commit: null, response: c.json({ error: "task not found" }, 404) };
    if (task.status !== "collecting") {
      return { commit: null, response: statusResponse(c, task) };
    }
    task.folded = task.folded ?? [];

    const subs: Array<Submission & { ref?: string }> = [];
    for (const a of task.agents) {
      const s = await deps.state.get<Submission & { ref?: string }>(subKey(id, a.agent_id));
      if (s) subs.push(s);
    }
    subs.sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
    const unfolded = subs.filter((s) => !task.folded.includes(s.agent_id));
    if (unfolded.length === 0) {
      // Nothing to do, but commit anyway so statusResponse()'s terminal
      // transitions (e.g. collecting -> merged) persist.
      return { commit: task, response: statusResponse(c, task) };
    }

    for (const sub of unfolded) {
      const agent = task.agents.find((a) => a.agent_id === sub.agent_id);
      if (!agent) continue; // agent removed; skip rather than stall the fold
      const res =
        task.mode === "artifacts" && isArtifacts(deps.git)
          ? await foldCandidateArtifacts(deps.git, task, agent, sub)
          : await foldCandidateLocal(c, deps.git as GitBackend, task, agent, sub);
      if (res.error) return { commit: null, response: res.error };
      task.folded.push(sub.agent_id);
      const { ref: _r, ...publicSub } = sub;
      task.submissions.push(publicSub);
      if (res.conflicts.length > 0) {
        const mergedCount = task.submissions.length - 1;
        task.conflicts = res.conflicts.map((k) => ({
          path: k.path,
          first_agent_id: "merged",
          first_label: `merged so far (${mergedCount} candidate${mergedCount === 1 ? "" : "s"})`,
          first_text: k.ours, // running merged result side
          second_agent_id: sub.agent_id,
          second_text: k.theirs, // newcomer candidate side
        }));
        task.status = "arena";
        return {
          commit: task,
          response: c.json({
            status: "arena",
            task_id: id,
            conflicts: task.conflicts.map((k) => ({ path: k.path })),
          }),
        };
      }
      if (res.mergedDiff !== undefined) task.merged_diff = res.mergedDiff;
    }
    return { commit: task, response: statusResponse(c, task) };
  }

  /** Client-facing status view shared by submit/fold when nothing errors. */
  function statusResponse(c: AppContext, task: TaskRecord): Response {
    const id = task.id;
    if (task.status === "arena") {
      return c.json({
        status: "arena",
        task_id: id,
        conflicts: (task.conflicts ?? []).map((k) => ({ path: k.path })),
      });
    }
    if (task.status === "merged") {
      return c.json({ status: "auto_merged", task_id: id, merged_diff: task.merged_diff });
    }
    if (task.status === "resolved") {
      return c.json({
        status: "resolved",
        task_id: id,
        winner_agent_id: task.result?.winner_agent_id,
      });
    }
    if (task.submissions.length < 2) {
      return c.json({ status: "awaiting_more", task_id: id, submitted: task.submissions.length });
    }
    const remaining = task.agents.length - task.submissions.length;
    if (remaining <= 0) {
      task.status = "merged";
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

  interface FoldedCandidate {
    conflicts: Array<{ path: string; ours: string; theirs: string }>;
    mergedDiff?: string;
    error?: Response;
  }

  // Local mode: apply the candidate diff to its worktree, adopt into the
  // running merge branch. (Single-writer in practice: tests/local only —
  // the in-isolate lock serializes folds, so no double-apply.)
  async function foldCandidateLocal(
    c: AppContext,
    git: GitBackend,
    task: TaskRecord,
    agent: AgentBrief,
    sub: Submission,
  ): Promise<FoldedCandidate> {
    if (!task.merge_branch) {
      return {
        conflicts: [],
        error: c.json({ error: "task has no merge branch" }, 500),
      };
    }
    try {
      await git.applyDiff(agent.branch, sub.diff);
    } catch (e) {
      return {
        conflicts: [],
        error: c.json({ error: e instanceof Error ? e.message : String(e) }, 400),
      };
    }
    const res = await git.adoptMerge(task.base_ref, agent.branch, task.merge_branch);
    return {
      conflicts: res.conflicts.map((k) => ({ path: k.path, ours: k.ours, theirs: k.theirs })),
      mergedDiff: res.clean ? res.mergedDiff ?? "" : undefined,
    };
  }

  // Artifacts mode: read base / running-merged / fork contents and merge
  // with pure merge.ts. Side-effect-free: safe to retry after a lost race.
  async function foldCandidateArtifacts(
    git: ArtifactsGitBackend,
    task: TaskRecord,
    agent: AgentBrief,
    sub: Submission & { ref?: string },
  ): Promise<FoldedCandidate> {
    const ref = sub.ref ?? "main";
    task.merged_files = task.merged_files ?? {};
    const conflicts: Array<{ path: string; ours: string; theirs: string }> = [];
    for (const path of sub.files_touched) {
      const base = await readFileOrEmpty(git, task.repo_dir, task.base_ref, path);
      const ours = task.merged_files[path] ?? base;
      const theirs = await readFileOrEmpty(git, agent.branch, ref, path);
      const r = mergeFile({ base, a: ours, b: theirs });
      if (r.conflict) {
        conflicts.push({ path, ours, theirs });
      } else if (r.merged !== undefined) {
        task.merged_files[path] = r.merged;
      }
    }
    return { conflicts };
  }

  // Explicit fold trigger for the orchestrator: drive convergence after
  // concurrent submits (or after a 202 "recorded" response).
  app.post("/task/:id/fold", async (c) => {
    const id = c.req.param("id");
    return withTaskLock(id, () => foldTaskInner(c, id));
  });

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
    // Note: the route already holds withTaskLock(id); do NOT nest another
    // (self-deadlock). transact() adds the cross-isolate rev check.
    return transact(c, id, async (task) => {
        if (!task) return { commit: null, response: c.json({ error: "task not found" }, 404) };
        if (task.status !== "arena") {
          return {
            commit: null,
            response: c.json({ error: `task is ${task.status}, nothing to decide` }, 409),
          };
        }
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        const winnerId = body.winner_agent_id;
        const winning = task.submissions.find((s) => s.agent_id === winnerId);
        if (!winning) {
          return {
            commit: null,
            response: c.json({ error: "winner_agent_id must be a submitted candidate" }, 400),
          };
        }
        task.status = "resolved";
        task.result = {
          winner_agent_id: winning.agent_id,
          winning_diff: winning.diff,
          decided_by: typeof body.decided_by === "string" ? body.decided_by : "human",
          rationale: typeof body.rationale === "string" ? body.rationale : undefined,
          decided_at: new Date().toISOString(),
        };
        return {
          commit: task,
          response: c.json({ status: "resolved", task_id: id, winner_agent_id: winning.agent_id }),
        };
      });
  }

  // Artifacts mode only: delete every repo created for the task (baseline +
  // forks) and drop the task record. Local mode has nothing server-side to
  // clean (fixture dirs are the test's job).
  app.post("/task/:id/teardown", async (c) => {
    const deps = c.get("deps");
    const id = c.req.param("id");
    return withTaskLock(id, async () => {
      const task = await deps.state.get<TaskRecord>(taskKey(id));
      if (!task) return c.json({ error: "task not found" }, 404);
      if (task.mode !== "artifacts" || !isArtifacts(deps.git)) {
        return c.json({ error: "teardown is only meaningful in artifacts mode" }, 400);
      }
      await deps.git.cleanupTask(
        id,
        task.agents.map((a) => a.branch),
      );
      await deps.state.delete(taskKey(id));
      return c.json({ ok: true, task_id: id, torn_down: true });
    });
  });

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
