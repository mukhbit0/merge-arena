// ci-worker tests: event parsing + queue batch handling, all in-process.

import { describe, it, expect } from "vitest";
import { parsePushEvent, taskIdFromRepo } from "../src/events";
import { handleBatch, type QueueBatchLike, type QueueMessageLike } from "../src/index";

const pushEvent = (over: Record<string, unknown> = {}) => ({
  type: "cf.artifacts.repo.pushed",
  source: { type: "artifacts.repo", namespace: "merge-arena", repoName: "arena-abcd1234-agent-1" },
  payload: {
    ref: "refs/heads/main",
    before: "abc000",
    after: "def789",
    commits: [{ id: "def789", message: "agent work", parents: ["abc000"] }],
    totalCommitsCount: 1,
    commitsTruncated: false,
  },
  metadata: { accountId: "acct", eventSubscriptionId: "sub", eventSchemaVersion: 1, eventTimestamp: "2026-10-09T00:00:00Z" },
  ...over,
});

function batch(bodies: unknown[]): { b: QueueBatchLike; acks: unknown[]; retries: unknown[] } {
  const acks: unknown[] = [];
  const retries: unknown[] = [];
  const messages: QueueMessageLike[] = bodies.map((body) => ({
    body,
    ack: () => acks.push(body),
    retry: () => retries.push(body),
  }));
  return { b: { messages }, acks, retries };
}

describe("taskIdFromRepo", () => {
  it("extracts the task id from merge-arena repo names", () => {
    expect(taskIdFromRepo("arena-abcd1234-base")).toBe("abcd1234");
    expect(taskIdFromRepo("arena-abcd1234-agent-1")).toBe("abcd1234");
    expect(taskIdFromRepo("other-repo")).toBeNull();
    expect(taskIdFromRepo("arena-xyz-agent-1")).toBeNull(); // not 8 hex chars
  });
});

describe("parsePushEvent", () => {
  it("parses a real-shaped push event", () => {
    const r = parsePushEvent(pushEvent(), "merge-arena");
    expect(r).not.toBeNull();
    expect(r!.task_id).toBe("abcd1234");
    expect(r!.repo).toBe("arena-abcd1234-agent-1");
    expect(r!.ref).toBe("refs/heads/main");
    expect(r!.sha).toBe("def789");
    expect(r!.commit_count).toBe(1);
    expect(r!.commit_messages).toEqual(["agent work"]);
  });

  it("ignores non-push events, other namespaces, and non-arena repos", () => {
    expect(parsePushEvent({ type: "cf.artifacts.repo.cloned" }, "merge-arena")).toBeNull();
    expect(parsePushEvent(pushEvent({ source: { type: "artifacts.repo", namespace: "other", repoName: "arena-abcd1234-agent-1" } }), "merge-arena")).toBeNull();
    expect(parsePushEvent(pushEvent({ source: { type: "artifacts.repo", namespace: "merge-arena", repoName: "unrelated" } }), "merge-arena")).toBeNull();
    expect(parsePushEvent(null, "merge-arena")).toBeNull();
    expect(parsePushEvent("junk", "merge-arena")).toBeNull();
  });
});

describe("handleBatch", () => {
  it("records CI runs and latest pointer, acks everything parsed", async () => {
    const { b, acks, retries } = batch([pushEvent(), { type: "noise" }]);
    await handleBatch(b, { CI_NAMESPACE: "merge-arena" });
    // handleBatch stores via getState(env); with no STATE_KV binding that is
    // the module-level shared in-memory store (same one local dev uses).
    const { getState } = await import("../../worker/src/storage");
    const store = getState({});
    const rec = await store.get<Record<string, unknown>>("ci:abcd1234:def789");
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe("received");
    expect(rec!.task_id).toBe("abcd1234");
    expect(await store.get("ci:abcd1234:latest")).toBe("def789");
    expect(acks).toHaveLength(2);
    expect(retries).toHaveLength(0);
  });
});
