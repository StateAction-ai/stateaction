import { randomBytes } from "node:crypto";
import type { Stage } from "@stateaction/contracts";
import type { JobsApi } from "./api-client.js";
import { CALL_ID } from "./journal.js";
import {
  parseRunResult,
  recoveryBinding,
  type ModalClient,
  type StageExpectation,
} from "./modal-executor.js";

type RecoveryInput = {
  jobId: string;
  callId: string;
  apiUrl: string;
  runRef: string;
  stage?: Stage;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPEN_RUNS = new Set(["submitting", "submit_unknown", "running"]);

/** Settle a cancelled submission using a returned result from its exact Modal call. */
export async function recoverModalExecution(
  deps: {
    api: Pick<JobsApi, "status" | "recipe" | "dagRun" | "act">;
    modal: Pick<ModalClient, "poll">;
    bootstrapHash: (input: RecoveryInput) => Promise<string>;
  },
  input: RecoveryInput,
): Promise<void> {
  const { api, modal } = deps;
  const { jobId, callId, runRef, apiUrl } = input;
  if (!UUID.test(jobId) || !CALL_ID.test(callId))
    throw new Error("Expected a job UUID and a Modal call ID");

  const status = await api.status(jobId);
  if (
    status.jobId !== jobId ||
    status.state !== "cancel_requested" ||
    status.executionBackend !== "modal" ||
    status.startDeadline === null
  )
    throw new Error("Recovery requires a Modal submission in cancel_requested");

  const recipe = await api.recipe(jobId);
  let stage: StageExpectation | undefined;
  let knownCall = status.executionRef;
  if (recipe) {
    const spec = recipe.stages.find((spec) => spec.stage === input.stage);
    const dag = await api.dagRun(jobId);
    const node = dag.stages.find((node) => node.stage === input.stage);
    if (
      !spec?.enabled ||
      !node ||
      !OPEN_RUNS.has(node.state) ||
      node.module !== spec.module
    )
      throw new Error("Recovery requires an issued, open stage of this recipe");
    stage = { jobId, stage: spec.stage, module: spec.module };
    knownCall = node.callId;
  } else if (input.stage !== undefined) {
    throw new Error("A job without a recipe has no stage to recover");
  }
  if (knownCall !== null && knownCall !== callId)
    throw new Error("A different Modal call is already recorded");

  const seen = await modal.poll(callId);
  const result =
    seen.kind === "returned"
      ? parseRunResult(seen.value, callId, stage)
      : undefined;
  const bound =
    result?.callBinding === undefined
      ? knownCall === callId
      : result.callBinding ===
        recoveryBinding(jobId, apiUrl, await deps.bootstrapHash(input), stage);
  if (!result || !bound)
    throw new Error(
      "Modal has not returned terminal proof for this submission",
    );

  const owner = randomBytes(32).toString("base64url");
  const grant = await api.act(jobId, { action: "claim_lease", runRef, owner });
  if (!("granted" in grant) || !grant.granted)
    throw new Error(
      "Controller lease refused; verify the run ID and wait for the owner to finish",
    );

  if (stage && knownCall === null)
    await api.act(jobId, {
      action: "record_stage_run",
      owner,
      stage: stage.stage,
      module: stage.module,
      state: "running",
      callId,
    });
  else if (!stage)
    await api.act(jobId, {
      action: "record_execution",
      owner,
      executor: { kind: "modal", functionCallId: callId },
    });

  await api.act(jobId, {
    action: "record_execution_evidence",
    evidence: {
      kind: "provider_call_terminal",
      executionRef: callId,
      detail: {
        proof: "function_call_returned_structured_result",
        recovery: "operator_observed_modal_result",
        exitCode: String(result.exitCode),
        runRef,
      },
    },
  });
  if (stage)
    await api.act(jobId, {
      action: "record_stage_run",
      owner,
      stage: stage.stage,
      module: stage.module,
      state: "cancelled",
      callId,
      errorCode: "cancel_requested",
    });
}
