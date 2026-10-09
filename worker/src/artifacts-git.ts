// Artifacts-backed git layer for Merge Arena (artifacts phase).
//
// Implements the GitBackend interface against the Cloudflare Artifacts
// Workers binding using ONLY the API surface verified against the official
// docs (developers.cloudflare.com/artifacts/api/workers-binding/ and the
// cloudflare/skills artifacts/api.md reference):
//   namespace: create(name, opts?) -> {name, remote, token, defaultBranch},
//              get(name), list(opts?), delete(name)
//   repo:      info(), createToken(scope, ttlSeconds), listTokens(),
//              validateToken(t), revokeToken(t), fork(name, {defaultBranchOnly?}),
//              log({ref}), readFile({ref, path})
// Repo handles are disposable (`using`); this backend scopes them per call.
//
// Model: one baseline repo per task (`arena-<taskId>-base`), one fork per
// agent (`arena-<taskId>-<agent>`). Agents are REAL git clients: they clone
// and push with the short-lived token this backend mints. The Worker never
// shells out to git — there is no git CLI in workerd.
//
// Deliberate limits (documented, not bugs):
// - seedFixture creates an EMPTY baseline repo and returns its remote +
//   initial token via `baselineAccess()`; the orchestrator (Node, with git)
//   pushes the seed files. The Worker cannot commit from inside workerd.
// - applyDiff throws: in artifacts mode agents push to their fork remotes.
// - threeWay/adoptMerge are not implemented on raw repos: merging needs a
//   file listing + a commit path, neither of which is in the verified binding
//   surface. The read-only merge *preview* lives in mergePreview() (readFile
//   at three refs + pure merge.ts computation, paths supplied by caller); the
//   demo/deploy phases resolve where the merged commit lands (agent push of
//   the winning fork, or an orchestrator git merge with a minted write token).
//   These throw a clear error.

import { mergeFile, type FileMergeResult } from "./merge";

export interface ArtifactsRepoHandle {
  info(): Promise<{ remote: string; defaultBranch?: string }>;
  createToken(scope: "read" | "write", ttlSeconds: number): Promise<string>;
  fork(name: string, opts?: { defaultBranchOnly?: boolean }): Promise<unknown>;
  log(opts: { ref: string }): Promise<Array<{ sha: string; message?: string }>>;
  readFile(opts: { ref: string; path: string }): Promise<string>;
}

export interface ArtifactsBindingLike {
  create(
    name: string,
    opts?: { description?: string; readOnly?: boolean; setDefaultBranch?: string },
  ): Promise<{ name: string; remote: string; token: string; defaultBranch?: string }>;
  get(name: string): Promise<ArtifactsRepoHandle>;
  list(opts?: { limit?: number }): Promise<unknown>;
  delete(name: string): Promise<void>;
}

export interface MergePreviewFile {
  path: string;
  overlap: boolean;
  conflict: boolean;
  /** Merged text. Set only when !conflict. */
  merged?: string;
}
export interface ArtifactsRepoAccess {
  name: string;
  remote: string;
  token: string;
}

interface TaskRepos {
  base: ArtifactsRepoAccess;
  forks: Map<string, ArtifactsRepoAccess>; // agentId -> fork access
}

const DEFAULT_BRANCH = "main";
const TOKEN_TTL_S = 3600;

const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
const baseName = (taskId: string) => `arena-${safe(taskId)}-base`;
const forkName = (taskId: string, agentId: string) => `arena-${safe(taskId)}-${safe(agentId)}`;

export class ArtifactsGitBackend {
  private tasks = new Map<string, TaskRepos>();

  constructor(private artifacts: ArtifactsBindingLike) {
    if (!artifacts) throw new Error("ArtifactsGitBackend requires the ARTIFACTS binding");
  }

  /** Create the empty baseline repo. Orchestrator pushes seed files with the returned token. */
  async seedFixture(taskId: string, _files?: Record<string, string>) {
    const name = baseName(taskId);
    const created = await this.artifacts.create(name, {
      description: `Merge Arena baseline for task ${taskId}`,
      setDefaultBranch: DEFAULT_BRANCH,
    });
    const base: ArtifactsRepoAccess = { name, remote: created.remote, token: created.token };
    this.tasks.set(taskId, { base, forks: new Map() });
    return { repoDir: name, baseRef: DEFAULT_BRANCH };
  }

  /** Fork the baseline for one agent and mint its short-lived write token. */
  async createWorktree(taskId: string, agentId: string) {
    const rec = this.tasks.get(taskId);
    if (!rec) throw new Error(`no baseline repo seeded for task "${taskId}"`);
    const name = forkName(taskId, agentId);
    const baseline = await this.artifacts.get(rec.base.name);
    await baseline.fork(name, { defaultBranchOnly: true });
    const fork = await this.artifacts.get(name);
    const token = await fork.createToken("write", TOKEN_TTL_S);
    const { remote } = await fork.info();
    rec.forks.set(agentId, { name, remote, token });
    return { branch: name };
  }

  /** Git remote + token for the orchestrator to seed the baseline repo. */
  baselineAccess(taskId: string): ArtifactsRepoAccess {
    const rec = this.tasks.get(taskId);
    if (!rec) throw new Error(`no baseline repo seeded for task "${taskId}"`);
    return rec.base;
  }

  /** Git remote + short-lived token for an agent's fork. */
  agentAccess(taskId: string, agentId: string): ArtifactsRepoAccess {
    const rec = this.tasks.get(taskId)?.forks.get(agentId);
    if (!rec) throw new Error(`no fork for agent "${agentId}" in task "${taskId}"`);
    return rec;
  }

  /** Read one file at a ref from a repo (verified read path; used by arena views). */
  async readFile(repoName: string, ref: string, path: string): Promise<string> {
    const repo = await this.artifacts.get(repoName);
    return repo.readFile({ ref, path });
  }

  /** Recent commits on a ref (verified read path). */
  async log(repoName: string, ref: string) {
    const repo = await this.artifacts.get(repoName);
    return repo.log({ ref });
  }

  /**
   * Read-only merge preview: for each `path`, read contents at baseRef,
   * refA, and refB and run the pure line-based 3-way merge from merge.ts.
   * Paths must be supplied by the caller (e.g. submission `files_touched`)
   * because the verified binding surface has no file listing. A file absent
   * at a ref reads as "" (added or deleted). No write is implied — landing
   * a merged result is the orchestrator's job (agent push of the winning
   * fork, or an orchestrator git merge with a minted write token).
   */
  async mergePreview(opts: {
    repo: string;
    baseRef: string;
    refA: string;
    refB: string;
    paths: string[];
  }): Promise<MergePreviewFile[]> {
    const repo = await this.artifacts.get(opts.repo);
    const read = async (ref: string, path: string): Promise<string> => {
      try {
        return await repo.readFile({ ref, path });
      } catch {
        return "";
      }
    };
    const out: MergePreviewFile[] = [];
    for (const path of opts.paths) {
      const [base, a, b] = await Promise.all([
        read(opts.baseRef, path),
        read(opts.refA, path),
        read(opts.refB, path),
      ]);
      const r: FileMergeResult = mergeFile({ base, a, b });
      out.push({ path, overlap: r.overlap, conflict: r.conflict, merged: r.merged });
    }
    return out;
  }

  /** Delete every repo created for a task (test/demo teardown). */
  async cleanupTask(taskId: string): Promise<void> {
    const rec = this.tasks.get(taskId);
    if (!rec) return;
    for (const fork of rec.forks.values()) {
      try {
        await this.artifacts.delete(fork.name);
      } catch {
        // best effort
      }
    }
    try {
      await this.artifacts.delete(rec.base.name);
    } catch {
      // best effort
    }
    this.tasks.delete(taskId);
  }

  // --- GitBackend-shaped stubs with honest errors ---------------------------
  // The Worker has no git CLI and the verified binding surface has no
  // file-listing or commit path, so these stay unimplemented until the
  // deploy phase verifies a merge/write route. They throw rather than
  // silently doing the wrong thing.

  async applyDiff(_branch: string, _unifiedDiff: string): Promise<void> {
    throw new Error(
      "applyDiff is not supported in artifacts mode: agents push to their fork remotes with git.",
    );
  }

  async threeWay(_base: string, _a: string, _b: string): Promise<never> {
    throw new Error(
      "threeWay on Artifacts repos is not wired yet: needs a verified file-listing + commit path (deploy phase).",
    );
  }

  async adoptMerge(_base: string, _candidate: string, _merge: string): Promise<never> {
    throw new Error(
      "adoptMerge on Artifacts repos is not wired yet: needs a verified file-listing + commit path (deploy phase).",
    );
  }
}
