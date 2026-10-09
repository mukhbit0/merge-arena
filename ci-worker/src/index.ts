// Merge Arena CI worker — consumes Artifacts push events from a Workers
// Queue (event subscription source `artifacts.repo`, event
// `cf.artifacts.repo.pushed`) and records CI runs in shared state.
//
// Phase scope: record every push to a merge-arena repo as a CI run record
// (repo, ref, sha, commits, received_at) with status "received". The demo
// phase's test runner picks runs up and flips status via POST
// /task/:id/ci/:sha on the merge-arena worker; deploy previews arrive with
// Workers Builds wiring (documented in ci-worker/README.md).

import { getState, type StateEnv } from "../../worker/src/storage";
import { parsePushEvent, type CiRunRecord } from "./events";

export interface CiEnv extends StateEnv {
  /** Artifacts namespace this worker watches (default "merge-arena"). */
  CI_NAMESPACE?: string;
}

const ciKey = (taskId: string, sha: string) => `ci:${taskId}:${sha}`;
const ciLatestKey = (taskId: string) => `ci:${taskId}:latest`;

export interface QueueMessageLike {
  body: unknown;
  ack(): void;
  retry(): void;
}

export interface QueueBatchLike {
  messages: QueueMessageLike[];
}

export async function handleBatch(batch: QueueBatchLike, env: CiEnv): Promise<void> {
  const state = getState(env);
  const namespace = env.CI_NAMESPACE ?? "merge-arena";
  for (const msg of batch.messages) {
    try {
      const run = parsePushEvent(msg.body, namespace);
      if (!run) {
        msg.ack(); // not a merge-arena push event: nothing to do
        continue;
      }
      const record: CiRunRecord = { ...run, status: "received", received_at: new Date().toISOString() };
      await state.put(ciKey(run.task_id, run.sha), record);
      await state.put(ciLatestKey(run.task_id), run.sha);
      msg.ack();
    } catch {
      msg.retry();
    }
  }
}

export default {
  async queue(batch: QueueBatchLike, env: CiEnv): Promise<void> {
    await handleBatch(batch, env);
  },
};
