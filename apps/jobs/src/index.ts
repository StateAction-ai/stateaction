import { task, type TaskContext } from "@renderinc/sdk/workflows";
import {
  parsePlatformVerifyRequest,
  type PlatformVerifyResult,
} from "@stateaction/contracts";
import { LocalExecutor } from "./local-executor.js";
export { processRecording } from "./process-recording.js";
// This foundation probe is intentionally separate from the future durable processing task.
export const verifyPlatform = task(
  {
    name: "verify-platform",
    timeoutSeconds: 60,
    plan: "flex",
    retry: { maxRetries: 0, waitDurationMs: 1000, backoffScaling: 1 },
  },
  async (context: TaskContext, value: unknown) => {
    const input = parsePlatformVerifyRequest(value);
    const worker = await new LocalExecutor().verify(input);
    const renderRunId = context.metadata.taskRunId;
    if (!renderRunId)
      throw new Error("Missing actual Render task run identity");
    return {
      requestId: input.requestId,
      renderRunId,
      worker,
    } satisfies PlatformVerifyResult;
  },
);
