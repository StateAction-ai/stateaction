import { AmbiguousApiError, ApiRejection, type JobsApi } from "./api-client.js";
import type { Exit } from "./local-process.js";
import type { ModalRunResult } from "./modal-executor.js";

/** What one controller entry decided. Shared by the local and Modal executors. */
export type Outcome =
  | { outcome: "not_admitted"; state: string }
  | { outcome: "no_effect"; reason: string }
  | {
      outcome: "child_exited";
      executionRef: string;
      exit: Exit;
      evidence: Evidence;
    }
  | {
      /** SA-42: a structured terminal result for the exact recorded Modal call was observed. */
      outcome: "call_terminal";
      executionRef: string;
      result: ModalRunResult;
      evidence: Evidence;
    }
  | { outcome: "submit_unknown"; reason: string }
  | { outcome: "needs_operator"; reason: string; executionRef?: string }
  | { outcome: "lease_lost"; executionRef?: string };
export type Evidence = "recorded" | "unconfirmed" | "withheld";

/**
 * Intent exists; ambiguity is recorded for SA-27 repair. Never respawn, never
 * evidence, never release.
 */
export async function markUnknown(
  api: JobsApi,
  id: { jobId: string; owner: string },
  reason: string,
  executionRef?: string,
): Promise<Outcome> {
  try {
    await api.act(id.jobId, { action: "mark_submit_unknown", owner: id.owner });
  } catch (error) {
    if (!(error instanceof AmbiguousApiError || error instanceof ApiRejection))
      throw error;
  }
  return executionRef
    ? { outcome: "needs_operator", reason, executionRef }
    : { outcome: "submit_unknown", reason };
}
