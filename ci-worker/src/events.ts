// Pure event parsing for the CI worker (unit-testable, no Worker APIs).
//
// Shape verified 2026-10-09 against the official events-schemas docs
// (developers.cloudflare.com/queues/event-subscriptions/events-schemas/):
//   type: "cf.artifacts.repo.pushed"
//   source: { type: "artifacts.repo", namespace, repoName }
//   payload: { ref, before, after, commits: [{id, message, ...}], totalCommitsCount, commitsTruncated }
//   metadata: { accountId, eventSubscriptionId, eventSchemaVersion, eventTimestamp }

export interface PushEventLike {
  type?: unknown;
  source?: { type?: unknown; namespace?: unknown; repoName?: unknown };
  payload?: {
    ref?: unknown;
    before?: unknown;
    after?: unknown;
    commits?: Array<{ id?: unknown; message?: unknown }>;
    totalCommitsCount?: unknown;
  };
}

export interface CiRunRecord {
  task_id: string;
  repo: string;
  ref: string;
  sha: string;
  commit_count: number;
  commit_messages: string[];
  /** received | running | passed | failed */
  status: string;
  received_at?: string;
}

/** Merge Arena repos are named `arena-<taskId>-<suffix>` (see artifacts-git.ts). */
const REPO_RE = /^arena-([0-9a-f]{8})-(.+)$/;

export function taskIdFromRepo(repoName: string): string | null {
  const m = REPO_RE.exec(repoName);
  return m ? m[1] : null;
}

/**
 * Parse one queue message body. Returns a CI run record (status unset) when
 * the message is a `cf.artifacts.repo.pushed` event for `namespace` and a
 * merge-arena repo; returns null for anything else (caller acks and moves on).
 */
export function parsePushEvent(body: unknown, namespace: string): Omit<CiRunRecord, "status" | "received_at"> | null {
  const e = body as PushEventLike;
  if (!e || typeof e !== "object") return null;
  if (e.type !== "cf.artifacts.repo.pushed") return null;
  if (e.source?.type !== "artifacts.repo") return null;
  if (e.source?.namespace !== namespace) return null;
  const repoName = typeof e.source?.repoName === "string" ? e.source.repoName : null;
  const taskId = repoName ? taskIdFromRepo(repoName) : null;
  if (!taskId || !repoName) return null;
  const ref = typeof e.payload?.ref === "string" ? e.payload.ref : "";
  const sha = typeof e.payload?.after === "string" ? e.payload.after : "";
  if (!ref || !sha) return null;
  const commits = Array.isArray(e.payload?.commits) ? e.payload!.commits! : [];
  return {
    task_id: taskId,
    repo: repoName,
    ref,
    sha,
    commit_count:
      typeof e.payload?.totalCommitsCount === "number" ? e.payload.totalCommitsCount : commits.length,
    commit_messages: commits
      .map((c) => (typeof c?.message === "string" ? c.message : ""))
      .filter(Boolean)
      .slice(0, 10),
  };
}
