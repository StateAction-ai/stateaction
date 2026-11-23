import { timingSafeEqual } from "node:crypto";
import { Render } from "@renderinc/sdk";
import { parsePlatformVerifyRequest } from "@stateaction/contracts";
import { assertLocalDispatch } from "./config.js";
/**
 * Hung-runner guard for the local development dispatch, sized from measurement (SA-117):
 * the local Render workflows runner acknowledges `startTask` only after it has started the
 * task, so the acknowledgement latency is intrinsic. Measured over 50 acks each:
 * idle (load ~18) min 1.63 s, p50 2.02 s, p99 2.49 s; under 12 extra busy loops (load ~28)
 * p50 3.07 s, p90 4.25 s, max 4.90 s. The former 2 s deadline sat below that distribution,
 * so it aborted calls the runner had already accepted and reported 503 for a running task.
 * 15 s is about 3x the loaded maximum; it only bounds a runner that never answers. The
 * smoke script's fetch timeouts (apps/jobs/src/smoke.ts) must stay above it.
 *
 * A 503 `local_workflow_unavailable` after the guard fires means the start is UNCONFIRMED,
 * not refused: the runner may already have started the task (the SDK returns no task run
 * id to cancel, and the local runner does not dedupe by idempotency key). Callers must not
 * blindly retry it; check the runner instead.
 */
export const START_TASK_DEADLINE_MS = 15_000;

export async function requestPlatformVerification(
  request: Request,
  options: { startDeadlineMs?: number } = {},
): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  try {
    assertLocalDispatch();
  } catch {
    return Response.json({ error: "not_found" }, { status: 404, headers });
  }
  const token = Buffer.from(`Bearer ${process.env.LOCAL_SMOKE_TOKEN}`);
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  if (supplied.length !== token.length || !timingSafeEqual(token, supplied))
    return Response.json({ error: "unauthorized" }, { status: 401, headers });
  const reader = request.body?.getReader();
  let body = "";
  let bytes = 0;
  if (reader) {
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        return Response.json(
          { error: "body_too_large" },
          { status: 413, headers },
        );
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  }
  let input;
  try {
    input = parsePlatformVerifyRequest(JSON.parse(body));
  } catch {
    return Response.json(
      { error: "invalid_request" },
      { status: 400, headers },
    );
  }
  try {
    const run = await new Render().workflows.startTask(
      "verify-platform",
      [input],
      {
        idempotencyKey: `platform:${input.requestId}`,
        signal: AbortSignal.timeout(
          options.startDeadlineMs ?? START_TASK_DEADLINE_MS,
        ),
      },
    );
    return Response.json(
      { requestId: input.requestId, taskRunId: run.taskRunId },
      { status: 202, headers },
    );
  } catch {
    return Response.json(
      { error: "local_workflow_unavailable" },
      { status: 503, headers },
    );
  }
}
