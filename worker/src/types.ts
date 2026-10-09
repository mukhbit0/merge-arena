// Shared record types for the Merge Arena worker core.

import type { StateStore, StateEnv } from "./storage";
import type { GitBackend } from "./git-backend";

export interface AgentBrief {
  agent_id: string;
  name: string;
  /** Scoped submit token. Returned once at task creation; never in GET /task. */
  token: string;
  branch: string;
  brief: string;
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

export interface TaskRecord {
  id: string;
  brief: string;
  status: TaskStatus;
  created_at: string;
  repo_dir: string;
  base_ref: string;
  agents: AgentBrief[];
  submissions: Submission[];
  /** Branch holding the running merged result; advances with each clean adopt. */
  merge_branch: string;
  merged_diff?: string;
  conflicts?: StoredConflict[];
  result?: TaskResult;
}

/** Dependencies a request handler needs. Constructed per request via getDeps. */
export interface Deps {
  state: StateStore;
  git: GitBackend;
  secret: string;
}

/** Worker environment bindings (subset we use in worker-core). */
export interface Env extends StateEnv {
  STATE_KV?: StateEnv["STATE_KV"];
  MERGE_ARENA_SECRET?: string;
}
