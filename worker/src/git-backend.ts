// Git layer abstraction for Merge Arena.
//
// LocalGitBackend implements the full contract with real git (node:child_process
// spawnSync) against temp fixture repos. Works in tests and local dev with no
// network. The artifacts phase will add an ArtifactsGitBackend (Cloudflare
// Artifacts repo binding) behind the same interface — routes never touch git
// directly, so the swap is contained here.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export interface ConflictFile {
  path: string;
  /** Content of the conflicted file from branch `b` (merge target). */
  ours: string;
  /** Content of the conflicted file from branch `a` (merged-in branch). */
  theirs: string;
}

export interface ThreeWayResult {
  clean: boolean;
  /** Unified diff of the merged result vs `base`. Set only when clean. */
  mergedDiff?: string;
  conflicts: ConflictFile[];
}

export interface GitBackend {
  seedFixture(taskId: string, files?: Record<string, string>): Promise<{ repoDir: string; baseRef: string }>;
  createWorktree(taskId: string, agentId: string): { branch: string };
  applyDiff(branch: string, unifiedDiff: string): Promise<void>;
  threeWay(base: string, a: string, b: string): Promise<ThreeWayResult>;
  /**
   * Merge `candidateBranch` into `mergeBranch` and LEAVE `mergeBranch` at the
   * merged tip on a clean merge (a merge commit is created). On conflict the
   * merge is aborted and `mergeBranch` is unchanged; conflicts are reported
   * with `ours` = mergeBranch side, `theirs` = candidate side.
   */
  adoptMerge(base: string, candidateBranch: string, mergeBranch: string): Promise<ThreeWayResult>;
  /** Remove all fixture repos created by this instance (test teardown). */
  cleanup(): Promise<void>;
}

export function defaultFixtureFiles(): Record<string, string> {
  return {
    "src/app.ts":
      'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
    "README.md": "# Merge Arena\n\nAgent-native merge queue.\n",
  };
}

interface SpawnResult {
  code: number;
  out: string;
  err: string;
}

export class LocalGitBackend implements GitBackend {
  // taskId -> { repoDir, baseRef }; branch -> taskId. A single instance can
  // serve many tasks because every lookup is keyed, never "current repo".
  private tasks = new Map<string, { repoDir: string; baseRef: string }>();
  private branchTask = new Map<string, string>();
  private dirs = new Set<string>();
  // Serializes git operations: agents submit concurrently, but each task's
  // fixture repo is a single git dir — concurrent checkout/apply/commit
  // would race on the index. (Production uses the Artifacts backend, where
  // locking is server-side.)
  private queue: Promise<void> = Promise.resolve();

  private locked<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** LocalGitBackend shells out to git — it only runs under Node.js (tests,
   *  local scripts). The deployed Worker gets an Artifacts-backed backend in
   *  the artifacts phase; fail loudly here instead of hitting unenv stubs. */
  private assertNode(): void {
    const v = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
    if (!v) {
      throw new Error(
        "LocalGitBackend requires a Node.js runtime (tests / local scripts); " +
          "the deployed Worker uses the Artifacts git backend (artifacts phase).",
      );
    }
  }

  private git(dir: string, args: string[], input?: string): SpawnResult {
    const r = spawnSync("git", args, {
      cwd: dir,
      input,
      encoding: "utf8",
      env: { ...process.env, GIT_EDITOR: "true", GIT_TERMINAL_PROMPT: "0" },
    });
    return {
      code: r.status ?? 1,
      out: (r.stdout ?? "").toString(),
      err: (r.stderr ?? "").toString(),
    };
  }

  private must(dir: string, args: string[], what: string, input?: string): SpawnResult {
    const r = this.git(dir, args, input);
    if (r.code !== 0) {
      const detail = (r.err.trim() || r.out.trim()).split("\n").slice(0, 3).join(" | ");
      throw new Error(`${what} failed: ${detail}`);
    }
    return r;
  }

  private repoDirFor(branch: string): string {
    const taskId = this.branchTask.get(branch);
    if (!taskId) throw new Error(`unknown branch "${branch}" (no worktree registered)`);
    const rec = this.tasks.get(taskId);
    if (!rec) throw new Error(`fixture repo for task "${taskId}" is gone`);
    return rec.repoDir;
  }

  async seedFixture(taskId: string, files: Record<string, string> = defaultFixtureFiles()) {
    this.assertNode();
    const dir = mkdtempSync(join(tmpdir(), "merge-arena-"));
    this.dirs.add(dir);
    this.must(dir, ["init", "-b", "main", "-q"], "git init");
    this.must(dir, ["config", "user.email", "arena@merge-arena.local"], "git config");
    this.must(dir, ["config", "user.name", "merge-arena"], "git config");
    for (const [p, content] of Object.entries(files)) {
      const full = join(dir, p);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    this.must(dir, ["add", "-A"], "git add");
    this.must(dir, ["commit", "-qm", "base"], "git commit");
    const baseRef = this.must(dir, ["rev-parse", "HEAD"], "git rev-parse").out.trim();
    this.tasks.set(taskId, { repoDir: dir, baseRef });
    return { repoDir: dir, baseRef };
  }

  createWorktree(taskId: string, agentId: string): { branch: string } {
    const rec = this.tasks.get(taskId);
    if (!rec) throw new Error(`no fixture seeded for task "${taskId}"`);
    const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const branch = `task-${taskId}-${safe}`;
    this.must(rec.repoDir, ["branch", branch, rec.baseRef], `create branch ${branch}`);
    this.branchTask.set(branch, taskId);
    return { branch };
  }

  async applyDiff(branch: string, unifiedDiff: string): Promise<void> {
    return this.locked(() => this.applyDiffInner(branch, unifiedDiff));
  }

  private applyDiffInner(branch: string, unifiedDiff: string): void {
    const dir = this.repoDirFor(branch);
    this.must(dir, ["checkout", "-q", branch], `checkout ${branch}`);
    const r = this.git(dir, ["apply", "--whitespace=fix", "-"], unifiedDiff);
    if (r.code !== 0) {
      this.git(dir, ["checkout", "-q", "--", "."]); // restore clean tree
      const detail = (r.err.trim() || r.out.trim()).split("\n").slice(0, 3).join(" | ");
      throw new Error(`diff did not apply cleanly to ${branch}: ${detail}`);
    }
    const dirty = this.must(dir, ["status", "--porcelain"], "git status").out.trim();
    if (!dirty) throw new Error("diff applied but produced no changes");
    this.must(dir, ["add", "-A"], "git add");
    this.must(dir, ["commit", "-qm", `candidate ${branch}`], "git commit");
  }

  async threeWay(base: string, a: string, b: string): Promise<ThreeWayResult> {
    return this.locked(() => this.threeWayInner(base, a, b));
  }

  private threeWayInner(base: string, a: string, b: string): ThreeWayResult {
    let dir: string;
    try {
      dir = this.repoDirFor(b);
    } catch {
      dir = this.repoDirFor(a);
    }
    const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const mergeBranch = `arena-merge-${tag}`;
    this.must(dir, ["checkout", "-q", "-b", mergeBranch, b], "create merge branch");
    try {
      return this.mergeInto(dir, base, a, mergeBranch);
    } finally {
      this.git(dir, ["merge", "--abort"]);
      this.git(dir, ["checkout", "-q", b]);
      this.git(dir, ["branch", "-D", mergeBranch]);
    }
  }

  async adoptMerge(base: string, candidateBranch: string, mergeBranch: string): Promise<ThreeWayResult> {
    return this.locked(() => this.adoptMergeInner(base, candidateBranch, mergeBranch));
  }

  private adoptMergeInner(base: string, candidateBranch: string, mergeBranch: string): ThreeWayResult {
    const dir = this.repoDirFor(mergeBranch);
    this.must(dir, ["checkout", "-q", mergeBranch], `checkout ${mergeBranch}`);
    return this.mergeInto(dir, base, candidateBranch, mergeBranch);
  }

  /**
   * Merge branch `a` into checked-out branch `b`. On clean merge, `b` is left
   * at the merged tip; on conflict the merge is aborted and conflicts from
   * both sides are returned (`ours` = b, `theirs` = a).
   */
  private mergeInto(dir: string, base: string, a: string, b: string): ThreeWayResult {
    const r = this.git(dir, ["merge", "--no-edit", "--no-ff", a]);
    if (r.code === 0) {
      const mergedDiff = this.must(dir, ["diff", `${base}..${b}`], "git diff").out;
      return { clean: true, mergedDiff, conflicts: [] };
    }
    const unmerged = this.must(dir, ["diff", "--name-only", "--diff-filter=U"], "list conflicts")
      .out.split("\n").map((s) => s.trim()).filter(Boolean);
    if (unmerged.length === 0) {
      const detail = (r.err.trim() || r.out.trim()).split("\n").slice(0, 3).join(" | ");
      throw new Error(`merge of ${a} into ${b} failed without file conflicts: ${detail}`);
    }
    const conflicts: ConflictFile[] = unmerged.map((path) => ({
      path,
      ours: this.must(dir, ["show", `:2:${path}`], `read ours ${path}`).out,
      theirs: this.must(dir, ["show", `:3:${path}`], `read theirs ${path}`).out,
    }));
    this.git(dir, ["merge", "--abort"]);
    return { clean: false, conflicts };
  }

  async cleanup(): Promise<void> {
    for (const dir of this.dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    this.dirs.clear();
    this.tasks.clear();
    this.branchTask.clear();
  }
}
