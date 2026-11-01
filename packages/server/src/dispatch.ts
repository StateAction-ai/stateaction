import { timingSafeEqual } from "node:crypto";
import { Render } from "@renderinc/sdk";
import { parsePlatformVerifyRequest } from "@stateaction/contracts";
import { assertLocalDispatch } from "./config.js";
export async function requestPlatformVerification(
  request: Request,
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
        signal: AbortSignal.timeout(2000),
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
