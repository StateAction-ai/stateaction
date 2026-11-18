import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { parseContract, type ControllerInput } from "@stateaction/contracts";
import { JobsApi } from "./api-client.js";
import { controllerSettings, controllerToken } from "./config.js";
import { runController } from "./controller.js";
import { JournalStore } from "./journal.js";
import { createModalSdkClient } from "./modal-sdk.js";

/**
 * The ONE production task definition for processing, shared by the official
 * Render local runner and Render. Input is the secret-free {jobId}. Deterministic
 * outcomes are returned (never retried); only transient API failures throw so
 * the native bounded retry re-enters the same run and waits for lease expiry.
 */
export const processRecording = task(
  {
    name: "process-recording",
    timeoutSeconds: 8 * 60 * 60,
    plan: "flex",
    retry: { maxRetries: 2, waitDurationMs: 30_000, backoffScaling: 1 },
  },
  async (context: TaskContext, value: unknown) => {
    const input = parseContract<ControllerInput>(
      "jobs.controller-input.v1",
      value,
    );
    const runRef = context.metadata.taskRunId;
    if (!runRef) throw new Error("Missing actual Render task run identity");
    const settings = controllerSettings();
    const api = new JobsApi(
      settings.apiUrl,
      controllerToken(),
      settings.apiTimeoutMs,
    );
    // The Modal client (and its credential) exists only in the controller, never the worker.
    const modal =
      settings.executor === "modal"
        ? createModalSdkClient(settings)
        : undefined;
    try {
      return await runController(
        {
          settings,
          api,
          store: new JournalStore(settings.stateDir),
          ...(modal ? { modal } : {}),
        },
        { jobId: input.jobId, runRef },
      );
    } finally {
      modal?.close?.();
    }
  },
);
