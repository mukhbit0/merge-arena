// Shared record types for the Merge Arena worker core.

import type { StateStore, StateEnv } from "./storage";
import type { GitBackend } from "./git-backend";
import type { ArtifactsGitBackend, ArtifactsBindingLike } from "./artifacts-git";

export interface AgentBrief {
  agent_id: string;
  name: string;
  /** Scoped submit token. Returned once at task creation; never in GET /task. */
  token: string;
  branch: string;
  brief: string;
  /** Artifacts mode only: fork's git remote, returned once at agent creation. */
  remote?: string;
  /** Artifacts mode only: short-lived write token for the fork. Returned once; never in GET /task. */
  git_token?: string;
}

export interface Submission {
  agent_id: string;
  branch: string;
  diff: string;
  rationale: string;
  files_touched: string[];
  diff_stat: { additions: number; deletions: number };
  submitted_at: string;
}

/**
 * One conflicted file, attributed to the two sides that produced it.
 * `first` is the running merged result (git "ours" — the merge target),
 * `second` is the newest candidate that conflicted with it (git "theirs" —
 * the merged-in branch). `first_label` names the merged side for display.
 */
export interface StoredConflict {
  path: string;
  first_agent_id: string;
  first_label?: string;
  first_text: string;
  second_agent_id: string;
  second_text: string;
}

export type TaskStatus = "collecting" | "arena" | "merged" | "resolved";

export interface TaskResult {
  winner_agent_id: string;
  winning_diff: string;
  decided_by: string;
  rationale?: string;
  decided_at: string;
}

export type TaskMode = "local" | "artifacts";

export interface TaskRecord {
  id: string;
  brief: string;
  /** "local" = LocalGitBackend (tests/local dev); "artifacts" = live Artifacts repos. */
  mode: TaskMode;
  status: TaskStatus;
  created_at: string;
  /**
   * Optimistic-concurrency revision, bumped on every mutation. The
   * in-isolate mutex does NOT span workerd isolates, so concurrent requests
   * can interleave read-modify-write on KV — writers re-read and retry when
   * the rev moved under them.
   */
  rev: number;
  /** Local mode: fixture repo dir. Artifacts mode: baseline repo name. */
  repo_dir: string;
  base_ref: string;
  agents: AgentBrief[];
  submissions: Submission[];
  /**
   * agent_ids whose recorded submissions have been folded into the running
   * merged result. Submissions live under immutable `sub:<task>:<agent>`
   * keys; folding is deterministic/idempotent so concurrent folds converge.
   */
  folded: string[];
  /** Local mode: branch holding the running merged result; advances with each clean adopt. */
  merge_branch?: string;
  /** Artifacts mode: seed files pushed to the baseline repo (authoritative copy is the repo itself). */
  seed_files?: Record<string, string>;
  /** Artifacts mode: the running merged result, path -> content; advanced per clean submission. */
  merged_files?: Record<string, string>;
  /** Artifacts mode: orchestrator's full-access token for the baseline repo. Never returned by any route. */
  baseline_token?: string;
  merged_diff?: string;
  conflicts?: StoredConflict[];
  result?: TaskResult;
}

/** Dependencies a request handler needs. Constructed per request via getDeps. */
export interface Deps {
  state: StateStore;
  git: GitBackend | ArtifactsGitBackend;
  secret: string;
}

/** Worker environment bindings (subset we use in worker-core). */
export interface Env extends StateEnv {
  STATE_KV?: StateEnv["STATE_KV"];
  MERGE_ARENA_SECRET?: string;
  ARTIFACTS?: ArtifactsBindingLike;
}
