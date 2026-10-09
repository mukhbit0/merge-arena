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
// CORRECTION (verified live 2026-10-10): createToken returns
// {id, plaintext, scope, expiresAt}, not a bare string — see tokenText().
// Repo handles are disposable (`using`); this backend scopes them per call.
//
// Model: one baseline repo per task (`arena-<taskId>-base`), one fork per
// agent (`arena-<taskId>-<agent>`). Agents are REAL git clients: they clone
// and push with the short-lived token this backend mints. The Worker never
// shells out to git — there is no git CLI in workerd.
//
// The backend is STATELESS by design: repo names are derived deterministically
// from taskId/agentId, because in workerd a fresh backend instance is built
// per request — an in-memory task map would be empty on the next request.
// (That was a real production bug: /agents 500'd because the instance that
// seeded the baseline was gone by the next request.)
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
  /**
   * Mint a scoped token. The verified docs type this as Promise<string>,
   * but the REAL binding returns {id, plaintext, scope, expiresAt} —
   * normalize with tokenText().
   */
  createToken(
    scope: "read" | "write",
    ttlSeconds: number,
  ): Promise<string | { plaintext?: string; token?: string }>;
  fork(name: string, opts?: { defaultBranchOnly?: boolean }): Promise<unknown>;
  log(opts: { ref: string }): Promise<Array<{ sha: string; message?: string }>>;
  /** Raw return is normalized by ArtifactsGitBackend.fileText (real binding returns an object). */
  readFile(opts: { ref: string; path: string }): Promise<unknown>;
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

export interface SeededBaseline {
  repoDir: string;
  baseRef: string;
  /** Full-access token for the baseline — only available at creation time. */
  access: ArtifactsRepoAccess;
}

export interface ForkCreated {
  /** Fork repo name (also used as the agent's `branch` in task records). */
  branch: string;
  remote: string;
  /** Short-lived write token minted for this agent. */
  gitToken: string;
}

const DEFAULT_BRANCH = "main";
const TOKEN_TTL_S = 3600;

const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
const baseName = (taskId: string) => `arena-${safe(taskId)}-base`;
const forkName = (taskId: string, agentId: string) => `arena-${safe(taskId)}-${safe(agentId)}`;

export class ArtifactsGitBackend {
  constructor(private artifacts: ArtifactsBindingLike) {
    if (!artifacts) throw new Error("ArtifactsGitBackend requires the ARTIFACTS binding");
  }

  /** Normalize createToken's return: string, or {plaintext} from the real binding. */
  static tokenText(t: string | { plaintext?: string; token?: string }): string {
    if (typeof t === "string") return t;
    const s = t.plaintext ?? t.token;
    if (!s) throw new Error("createToken returned an unrecognized shape (no plaintext/token)");
    return s;
  }

  /**
   * Create the empty baseline repo. The orchestrator pushes seed files with
   * the returned access token (the Worker cannot commit from inside workerd).
   */
  async seedFixture(taskId: string, _files?: Record<string, string>): Promise<SeededBaseline> {
    const name = baseName(taskId);
    const created = await this.artifacts.create(name, {
      description: `Merge Arena baseline for task ${taskId}`,
      setDefaultBranch: DEFAULT_BRANCH,
    });
    return {
      repoDir: name,
      baseRef: DEFAULT_BRANCH,
      access: { name, remote: created.remote, token: created.token },
    };
  }

  /**
   * Fork the baseline for one agent and mint its short-lived write token.
   * Forks must be created AFTER the orchestrator pushed seed files, or
   * agents will clone empty forks.
   */
  async createWorktree(taskId: string, agentId: string): Promise<ForkCreated> {
    const name = forkName(taskId, agentId);
    const baseline = await this.artifacts.get(baseName(taskId));
    await baseline.fork(name, { defaultBranchOnly: true });
    const fork = await this.artifacts.get(name);
    const token = ArtifactsGitBackend.tokenText(await fork.createToken("write", TOKEN_TTL_S));
    const { remote } = await fork.info();
    return { branch: name, remote, gitToken: token };
  }

  /**
   * Fork access derived from names. Mints a FRESH write token on every call
   * (the creation-time token is not recoverable statelessly); prefer the
   * token returned by createWorktree.
   */
  async agentAccess(taskId: string, agentId: string): Promise<ArtifactsRepoAccess> {
    const name = forkName(taskId, agentId);
    const fork = await this.artifacts.get(name);
    const token = ArtifactsGitBackend.tokenText(await fork.createToken("write", TOKEN_TTL_S));
    const { remote } = await fork.info();
    return { name, remote, token };
  }

  /** Read one file at a ref from a repo (verified read path; used by arena views). */
  async readFile(repoName: string, ref: string, path: string): Promise<string> {
    const repo = await this.artifacts.get(repoName);
    const raw = await repo.readFile({ ref, path });
    return ArtifactsGitBackend.fileText(raw);
  }

  /**
   * Normalize readFile's return to text. The real binding returns an object,
   * not a bare string (verified live 2026-10-10: `s.split is not a function`).
   */
  static fileText(raw: unknown): string {
    if (typeof raw === "string") return raw;
    if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
    if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      for (const k of ["content", "text", "data", "body"]) {
        const v = o[k];
        if (typeof v === "string") return v;
        if (v instanceof Uint8Array) return new TextDecoder().decode(v);
      }
      throw new Error(`readFile returned object with keys [${Object.keys(o).join(",")}]`);
    }
    throw new Error(`readFile returned ${typeof raw}`);
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
        return ArtifactsGitBackend.fileText(await repo.readFile({ ref, path }));
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
  async cleanupTask(taskId: string, forkNames: string[] = []): Promise<void> {
    for (const fork of forkNames) {
      try {
        await this.artifacts.delete(fork);
      } catch {
        // best effort
      }
    }
    try {
      await this.artifacts.delete(baseName(taskId));
    } catch {
      // best effort
    }
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
