import type { Stage, StageRunState } from "@stateaction/contracts";
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
  | { outcome: "lease_lost"; executionRef?: string }
  | {
      /**
       * SA-91: a recipe job ran its stages in order. Each stage the controller reached is listed
       * with the state it recorded (or found recorded). `stopped` is the outcome of the stage that
       * could not finish (unknown call, operator path, lease loss, unconfirmed evidence); no later
       * stage was started.
       */
      outcome: "recipe_run";
      stages: StageSummary[];
      stopped?: Outcome;
    };
export type StageSummary = {
  stage: Stage;
  state: StageRunState;
  errorCode?: string;
  callId?: string;
};
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

/**
 * SA-91: the same ambiguity for one recipe stage. A stage whose call is not known is recorded
 * `submit_unknown` (its issued claim holds the slot for the operator path); the job is marked as
 * before. Never respawn, never evidence, never release.
 */
export async function markStageUnknown(
  api: JobsApi,
  id: { jobId: string; owner: string },
  stage: { stage: Stage; module: string },
  reason: string,
  executionRef?: string,
): Promise<Outcome> {
  if (executionRef === undefined)
    try {
      await api.act(id.jobId, {
        action: "record_stage_run",
        owner: id.owner,
        stage: stage.stage,
        state: "submit_unknown",
        module: stage.module,
      });
    } catch (error) {
      if (
        !(error instanceof AmbiguousApiError || error instanceof ApiRejection)
      )
        throw error;
    }
  return markUnknown(api, id, reason, executionRef);
}
