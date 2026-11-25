import { randomUUID } from "node:crypto";
import { validateValue } from "@stateaction/contracts";
import type { DatasetAuthenticate } from "../datasets/http.js";
import {
  recordingRunHistory,
  selectRecordingResult,
} from "./result-selection.js";
import { TransportError } from "../transport/errors.js";
import { errorResponse, readBoundedJson } from "../transport/http.js";
import {
  confirmStageRerun,
  planStageRerun,
  type StageRerunCommand,
  type StageRerunDeps,
  type StageRerunRequest,
} from "./stage-reruns.js";

import {
  confirmStageRerunV2,
  planStageRerunV2,
  type StageRerunCommandV2,
  type StageRerunRequestV2,
} from "./stage-rerun-v2.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function stageRerunRoutes(
  deps: StageRerunDeps & { authenticate: DatasetAuthenticate },
) {
  async function handle(
    request: Request,
    recordingId: string,
    mode: "plan" | "confirm" | "planV2" | "confirmV2" | "history" | "select",
  ) {
    const auth = await deps.authenticate(request, "staff");
    if (!auth.ok) {
      if (
        (mode === "planV2" || mode === "confirmV2") &&
        auth.response.status === 403
      )
        return errorResponse(
          new TransportError("not_found", "Not found"),
          randomUUID(),
        );
      return auth.response;
    }
    const requestId = auth.requestId ?? randomUUID();
    try {
      if (!uuid.test(recordingId))
        throw new TransportError("not_found", "Recording not found");
      const headers = new Headers(auth.headers);
      headers.set("cache-control", "private, no-store");
      if (mode === "history") {
        const history = await recordingRunHistory(
          deps.pool,
          auth.principal.userId,
          recordingId,
        );
        return Response.json({ data: history, requestId }, { headers });
      }
      if (mode === "select") {
        const input = (await readBoundedJson(
          request,
          "http.recording-result-selection-command.v1",
          4096,
        )) as {
          jobId: string;
          expectedSelectionSeq: number;
          reason: string;
        };
        if (!input.reason.trim())
          throw new TransportError("invalid_request", "A reason is required");
        const data = await selectRecordingResult(
          deps.pool,
          auth.principal.userId,
          recordingId,
          input,
        );
        return Response.json({ data, requestId }, { headers, status: 201 });
      }
      if (mode === "planV2") {
        const body = (await readBoundedJson(
          request,
          "http.stage-rerun-plan-request.v2",
        )) as StageRerunRequestV2;
        const data = await planStageRerunV2(
          deps,
          auth.principal.userId,
          recordingId,
          body,
        );
        if (!validateValue("http.stage-rerun-plan.v2", data).valid)
          throw new Error("Invalid stage-set rerun preview");
        return Response.json({ data, requestId }, { headers });
      }
      if (mode === "confirmV2") {
        const body = (await readBoundedJson(
          request,
          "http.stage-rerun-command.v2",
        )) as StageRerunCommandV2;
        const data = await confirmStageRerunV2(
          deps,
          auth.principal.userId,
          recordingId,
          body,
        );
        if (!validateValue("http.stage-rerun-result.v2", data).valid)
          throw new Error("Invalid stage-set rerun result");
        return Response.json(
          { data, requestId },
          { headers, status: data.replayed ? 200 : 201 },
        );
      }
      if (mode === "plan") {
        const body = (await readBoundedJson(
          request,
          "http.stage-rerun-plan-request.v1",
          16384,
        )) as StageRerunRequest;
        const { plan, planSha256 } = await planStageRerun(
          deps,
          auth.principal.userId,
          recordingId,
          body,
        );
        const execute = plan.recipe.stages.filter((stage) =>
          plan.execute.includes(stage.stage),
        );
        const reuse = plan.reuse.map((row) => ({
          stage: row.stage,
          state: row.state,
          sourceJobId: row.sourceJobId,
          executionJobId: row.executionJobId,
          importJobId: row.importJobId,
          importManifestSha256: row.importManifestSha256,
          receiptSha256: row.receiptSha256,
          errorCode: row.errorCode,
          copyBytes: row.files
            .reduce((total, file) => total + BigInt(file.sizeBytes), 0n)
            .toString(),
        }));
        const data = {
          planSha256,
          execute,
          reuse,
          maxGpuCostUsd: plan.maxGpuCostUsd,
          maxComputeCostUsd: plan.maxComputeCostUsd,
          estimatedComputeCostUsd: plan.estimatedComputeCostUsd,
          estimatedSeconds: plan.estimatedSeconds,
        };
        if (!validateValue("http.stage-rerun-plan.v1", data).valid)
          throw new Error("Invalid rerun preview");
        return Response.json({ data, requestId }, { headers });
      }
      const body = (await readBoundedJson(
        request,
        "http.stage-rerun-command.v1",
        16384,
      )) as StageRerunCommand;
      if (body.reason.trim().length === 0)
        throw new TransportError("invalid_request", "A reason is required");
      const data = await confirmStageRerun(
        deps,
        auth.principal.userId,
        recordingId,
        body,
      );
      if (!validateValue("http.stage-rerun-result.v1", data).valid)
        throw new Error("Invalid rerun result");
      return Response.json(
        { data, requestId },
        { headers, status: data.replayed ? 200 : 201 },
      );
    } catch (error) {
      const res = errorResponse(error, requestId);
      const headers = new Headers(auth.headers);
      for (const [key, value] of res.headers) headers.set(key, value);
      return new Response(res.body, { status: res.status, headers });
    }
  }
  return {
    plan: (request: Request, recordingId: string) =>
      handle(request, recordingId, "plan"),
    confirm: (request: Request, recordingId: string) =>
      handle(request, recordingId, "confirm"),
    planV2: (request: Request, recordingId: string) =>
      handle(request, recordingId, "planV2"),
    confirmV2: (request: Request, recordingId: string) =>
      handle(request, recordingId, "confirmV2"),
    history: (request: Request, recordingId: string) =>
      handle(request, recordingId, "history"),
    select: (request: Request, recordingId: string) =>
      handle(request, recordingId, "select"),
  };
}
