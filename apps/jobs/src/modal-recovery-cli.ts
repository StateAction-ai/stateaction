import {
  readModalRecoveryBootstrapHash,
  settleModalStartupFailure,
} from "@stateaction/server/operator-db";
import { parseArgs } from "node:util";
import { JobsApi } from "./api-client.js";
import { controllerSettings, controllerToken } from "./config.js";
import { recoverModalExecution } from "./modal-recovery.js";
import { observeModalStartupFailure } from "./modal-startup-proof.js";
import { createModalSdkClient } from "./modal-sdk.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    call: { type: "string" },
    run: { type: "string" },
    stage: { type: "string" },
    "pre-entry": { type: "boolean" },
  },
});
const [jobId] = positionals;
const { call, run, stage } = values;
if (
  positionals.length !== 1 ||
  !jobId ||
  !call ||
  !run ||
  (stage !== undefined &&
    stage !== "segment" &&
    stage !== "caption" &&
    stage !== "hand_pose")
)
  throw new Error(
    "Usage: recover-modal <jobId> --call <fc-id> --run <render-run-id> [--stage <stage>] [--pre-entry]",
  );

if (values["pre-entry"]) {
  if (!stage) throw new Error("--pre-entry requires an issued recipe stage");
  const { ModalClient } = await import("modal");
  const modal = new ModalClient({
    timeoutMs: 5000,
    maxRetries: 0,
  });
  try {
    const result = await settleModalStartupFailure(
      { jobId, callId: call, runRef: run, stage },
      (id) => observeModalStartupFailure(modal.cpClient, id),
    );
    console.log(JSON.stringify({ jobId, callId: call, ...result }));
  } finally {
    modal.close();
  }
} else {
  const settings = controllerSettings();
  if (settings.executor !== "modal")
    throw new Error("Recovery requires the Modal backend");
  const api = new JobsApi(
    settings.apiUrl,
    controllerToken(),
    settings.apiTimeoutMs,
  );
  const modal = createModalSdkClient(settings);
  try {
    await recoverModalExecution(
      { api, modal, bootstrapHash: readModalRecoveryBootstrapHash },
      {
        jobId,
        callId: call,
        runRef: run,
        apiUrl: settings.apiUrl,
        ...(stage === undefined ? {} : { stage }),
      },
    );
    console.log(JSON.stringify({ jobId, callId: call, recorded: true }));
  } finally {
    modal.close?.();
  }
}
