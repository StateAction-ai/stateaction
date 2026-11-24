import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { requestSha256, type RecipeV1 } from "@stateaction/contracts";

/**
 * A contract-shaped stand-in for SA-25's machine API, used ONLY by fast unit
 * tests of the controller (deadline kill, lost acknowledgement, journals).
 * The real API/Postgres proof is test-integration. It records every call.
 */
export type StubOptions = {
  jobId: string;
  state: string;
  executionDeadline: Date;
  /** Override only the worker's deadline when testing controller enforcement. */
  workerExecutionDeadline?: Date;
  /** First record_worker_submission outcome: token handed out, or already recorded. */
  submission: "recorded" | "already_recorded";
  claimWins?: boolean;
  /** SA-42: status identity projection (default local with no reference). */
  statusBackend?: "local" | "modal";
  initialExecutionRef?: string;
  /** SA-42 test control: false makes every lease renewal report a lost lease. */
  renewWins?: boolean;
  /**
   * SA-91: a recipe job. Without it `/recipe` and `/dag-run` answer 404 (a job without a recipe),
   * exactly as the real API does.
   */
  recipe?: RecipeV1;
  parallelRecipe?: boolean;
  /** SA-91: the server refuses a stage receipt naming this output digest (no such stored file). */
  rejectReceiptSha256?: string;
  /** SA-91 fault injection: a status code to answer instead of handling this action body. */
  fault?: (body: Record<string, unknown>) => number | undefined;
};

/** SA-91 stage run as the stub records it (the job_stage_runs subset the controller sees). */
export type StubStageRun = {
  state: string;
  module: string;
  callId?: string;
  errorCode?: string;
  receipt?: { counts: Record<string, number> } & Record<string, unknown>;
};
const RANK: Record<string, number> = {
  pending: 0,
  submitting: 1,
  submit_unknown: 2,
  running: 3,
};
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "not_run"]);
/** Every started stub; test files close them in an `after` hook even when assertions fail. */
export const stubs: Server[] = [];
export const closeStubs = () => {
  for (const s of stubs) {
    s.closeAllConnections();
    s.close();
  }
};
export type Call = { path: string; body?: Record<string, unknown> };

export async function startStub(options: StubOptions) {
  const calls: Call[] = [];
  const token = `sa_svc_${randomBytes(32).toString("base64url")}`;
  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
  let state = options.state;
  let executionRef: string | null = options.initialExecutionRef ?? null;
  // SA-91 recipe state: the stub enforces the 011 ordering and proof rules the controller relies on.
  const runs = new Map<string, StubStageRun>();
  const claims = new Map<string, { token: string; callId?: string }>();
  const stageEvidence = new Map<string, string>();
  const recordingId = randomUUID();
  const spec = (stage: string) =>
    options.recipe?.stages.find((x) => x.stage === stage);
  const callOf = (stage: string) =>
    claims.get(stage)?.callId ?? runs.get(stage)?.callId;
  const priorSettled = (stage: string) =>
    (options.parallelRecipe && stage === "hand_pose") ||
    (options.recipe?.stages ?? [])
      .slice(
        0,
        (options.recipe?.stages ?? []).findIndex((x) => x.stage === stage),
      )
      .every((x) => !x.enabled || TERMINAL.has(runs.get(x.stage)?.state ?? ""));
  const dagRun = () => ({
    schemaVersion: 1,
    jobId: options.jobId,
    recordingId,
    jobState: state,
    recipeId: options.recipe!.recipeId,
    recipeSha256: requestSha256(options.recipe),
    maxJobCostUsd: options.recipe!.maxJobCostUsd,
    estimatedCostUsd: null,
    stages: options.recipe!.stages.map((x) => {
      const r = runs.get(x.stage);
      return {
        stage: x.stage,
        enabled: x.enabled,
        module: x.module,
        state: r ? r.state : x.enabled ? "pending" : "not_run",
        errorCode: r
          ? (r.errorCode ?? null)
          : x.enabled
            ? null
            : "stage_disabled",
        callId: r ? (callOf(x.stage) ?? null) : null,
        gpu: { requestedType: x.resources.gpu, observedType: null },
        startedAt: null,
        finishedAt: null,
        counts: r?.receipt?.counts ?? {},
        estimatedCostUsd: null,
        receiptSha256: r?.receipt ? requestSha256(r.receipt) : null,
      };
    }),
    renderedAt: iso(new Date()),
  });
  /**
   * jobs.prior-stages.v1 stand-in: the server attributes files to a stage by slot; the stub has no
   * file table, so a stage owns the files its recorded receipt named, with the 011 slot names.
   */
  const priorStages = () => ({
    schemaVersion: 1,
    jobId: options.jobId,
    stages: (["segment", "caption"] as const)
      .filter((stage) => runs.has(stage))
      .map((stage) => {
        const r = runs.get(stage)!;
        const outputs = (
          (r.receipt?.outputs ?? []) as {
            fileId: string;
            role: string;
            sizeBytes: string;
            sha256: string;
          }[]
        ).map((o, i) => ({
          ...o,
          slot:
            o.role === "segments_json"
              ? "segments.json"
              : o.role === "captions_json"
                ? "captions.json"
                : `diagnostics/${stage}/file-${i}.txt`,
        }));
        return {
          stage,
          state: r.state,
          errorCode: r.errorCode ?? null,
          counts: r.receipt?.counts ?? {},
          outputs,
        };
      }),
  });
  /** job_stage_record_run: forward-only, write-once call, proof before a claimed stage ends. */
  const recordStageRun = (b: Record<string, unknown>): number | boolean => {
    const stage = b.stage as string;
    const next = b.state as string;
    const x = spec(stage);
    if (!x || x.module !== b.module) return 409;
    if (!x.enabled && next !== "not_run") return 409;
    if (next !== "not_run" && !priorSettled(stage)) return 409;
    const claim = claims.get(stage);
    if (
      ["submitting", "submit_unknown", "running", "succeeded"].includes(next) &&
      !claim
    )
      return 409;
    if (claim && next === "not_run") return 409;
    const known = callOf(stage);
    const callId = b.callId as string | undefined;
    if (known && callId && known !== callId) return 409;
    if (
      claim &&
      ["succeeded", "failed", "cancelled"].includes(next) &&
      (!(known ?? callId) || stageEvidence.get(stage) !== (known ?? callId))
    )
      return 409;
    if (next === "succeeded" && !b.receipt) return 409;
    const receipt = b.receipt as StubStageRun["receipt"] | undefined;
    if (
      receipt &&
      options.rejectReceiptSha256 &&
      (receipt.outputs as { sha256: string }[]).some(
        (o) => o.sha256 === options.rejectReceiptSha256,
      )
    )
      return 409;
    const old = runs.get(stage);
    if (old) {
      const same =
        old.state === next &&
        old.errorCode === b.errorCode &&
        (!callId || old.callId === callId);
      if (same) return false;
      if (TERMINAL.has(old.state)) return 409;
      if (
        !(
          (RANK[next] ?? 4) > (RANK[old.state] ?? 4) &&
          (next !== "not_run" || old.state === "pending")
        )
      )
        return 409;
    }
    runs.set(stage, {
      state: next,
      module: b.module as string,
      ...((old?.callId ?? callId) ? { callId: old?.callId ?? callId } : {}),
      ...(b.errorCode ? { errorCode: b.errorCode as string } : {}),
      ...((receipt ?? old?.receipt)
        ? { receipt: receipt ?? old!.receipt }
        : {}),
    });
    return true;
  };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = req.url ?? "";
      calls.push({ path: `${req.method} ${url}`, body });
      const send = (data: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ data, requestId: randomUUID() }));
      };
      if (req.method === "POST" && url.endsWith("/rerun-preparation"))
        return send({ state: "regular" });
      if (req.method === "GET" && url.endsWith("/recipe"))
        return options.recipe
          ? send(options.recipe)
          : send({ error: { code: "not_found" } }, 404);
      if (req.method === "GET" && url.endsWith("/prior-stages"))
        return options.recipe
          ? send(priorStages())
          : send({ error: { code: "not_found" } }, 404);
      if (req.method === "GET" && url.endsWith("/dag-run"))
        return options.recipe
          ? send(dagRun())
          : send({ error: { code: "not_found" } }, 404);
      if (req.method === "GET")
        return send({
          jobId: options.jobId,
          kind: "process_recording",
          targetId: randomUUID(),
          state,
          previousJobId: null,
          createdAt: iso(new Date()),
          updatedAt: iso(new Date()),
          executionBackend: options.statusBackend ?? "local",
          executionRef,
          startDeadline: iso(
            new Date(
              Math.min(
                Date.now() + 60_000,
                options.executionDeadline.getTime(),
              ),
            ),
          ),
          executionDeadline: iso(options.executionDeadline),
        });
      if (url.endsWith("/claim")) {
        if (options.claimWins === false) return send({ error: "x" }, 403);
        // COALESCE(execution_call_id, claimed ref); a different recorded ref refuses the claim.
        const claimed =
          (
            body.executor as {
              functionCallId?: string;
              localExecutionRef?: string;
            }
          )?.functionCallId ??
          (body.executor as { localExecutionRef?: string })
            ?.localExecutionRef ??
          null;
        if (
          executionRef !== null &&
          claimed !== null &&
          executionRef !== claimed
        )
          return send({ error: { code: "conflict" } }, 409);
        executionRef ??= claimed;
        state = "running";
        return send({
          jobId: options.jobId,
          invocationNonce: body.invocationNonce,
          executionDeadline: iso(
            options.workerExecutionDeadline ?? options.executionDeadline,
          ),
          capability: {
            token: `sa_svc_${randomBytes(32).toString("base64url")}`,
          },
        });
      }
      if (url.endsWith("/heartbeat"))
        return send({
          accepted: true,
          executionDeadline: iso(
            options.workerExecutionDeadline ?? options.executionDeadline,
          ),
        });
      const later = iso(new Date(Date.now() + 120_000));
      const injected = body?.action ? options.fault?.(body) : undefined;
      if (injected !== undefined)
        return send({ error: { code: "injected" } }, injected);
      switch (body.action) {
        case "start_parallel_recipe":
          return send({ recorded: options.parallelRecipe ?? false });
        case "seal_parallel_recipe":
          return send({
            recorded: options.recipe?.stages.every((spec) =>
              TERMINAL.has(runs.get(spec.stage)?.state ?? ""),
            ),
          });
        case "record_workflow_run":
          return send({ recorded: true });
        case "claim_lease":
          return send({ granted: true, expiresAt: later });
        case "renew_lease":
          if (options.renewWins === false) return send({ renewed: false });
          return send({ renewed: true, expiresAt: later });
        case "record_worker_submission":
          if (options.submission === "already_recorded")
            return send({ state: "already_recorded" });
          return send({
            state: "recorded",
            bootstrapToken: token,
            startDeadline: iso(
              new Date(
                Math.min(
                  Date.now() + 60_000,
                  options.executionDeadline.getTime(),
                ),
              ),
            ),
            executionDeadline: iso(options.executionDeadline),
            taskInput: {
              schemaVersion: 2,
              jobId: options.jobId,
              targetId: randomUUID(),
              profileRevision: "stub-1",
              kind: "process_recording",
              sourceManifestSha256: "a".repeat(64),
              rgbProfile: "h264_mcap_v1",
            },
            executionBackend: options.statusBackend ?? "local",
          });
        case "record_execution": {
          const ref = body.executor as {
            functionCallId?: string;
            localExecutionRef?: string;
          };
          const next = ref.functionCallId ?? ref.localExecutionRef ?? null;
          if (executionRef !== null && executionRef !== next)
            return send({ error: { code: "conflict" } }, 409);
          const first = executionRef === null;
          executionRef = next;
          return send({ recorded: first });
        }
        case "mark_submit_unknown":
          state = "submit_unknown";
          return send({ state: "submit_unknown" });
        case "record_execution_evidence": {
          if (options.recipe) {
            const ref = (body.evidence as { executionRef?: string })
              .executionRef;
            const stage = [...claims.keys()].find((x) => callOf(x) === ref);
            if (!stage) return send({ error: { code: "conflict" } }, 409);
            stageEvidence.set(stage, ref!);
          }
          return send({ recorded: true, slotReleased: false });
        }
        case "issue_stage_claim": {
          const stage = body.stage as string;
          if (!spec(stage)?.enabled || !priorSettled(stage))
            return send({ error: { code: "conflict" } }, 409);
          if (claims.has(stage)) return send({ state: "already_recorded" });
          const stageToken = `sa_svc_${randomBytes(32).toString("base64url")}`;
          claims.set(stage, { token: stageToken });
          return send({
            state: "recorded",
            bootstrapToken: stageToken,
            startDeadline: iso(
              new Date(
                Math.min(
                  Date.now() + 60_000,
                  options.executionDeadline.getTime(),
                ),
              ),
            ),
            executionDeadline: iso(options.executionDeadline),
            taskInput: {
              schemaVersion: 2,
              jobId: options.jobId,
              targetId: randomUUID(),
              profileRevision: "stub-1",
              kind: "process_recording",
              sourceManifestSha256: "a".repeat(64),
              rgbProfile: "h264_mcap_v1",
            },
            executionBackend: options.statusBackend ?? "local",
          });
        }
        case "record_stage_run": {
          const r = recordStageRun(body);
          return typeof r === "number"
            ? send({ error: { code: "conflict" } }, r)
            : send({ recorded: r });
        }
      }
      send({ error: "unhandled" }, 400);
    });
  });
  server.unref(); // a failing test must never hold the process open
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  stubs.push(server);
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    calls,
    /** Test control: flip the job state (e.g. to cancel_requested). */
    setState: (next: string) => {
      state = next;
    },
    executionRef: () => executionRef,
    /** SA-91: the recorded stage runs and issued stage claims. */
    runs,
    claims,
    stageEvidence,
    /** SA-91 test control: a stage worker claims its stage with this call identity. */
    claimStage: (stage: string, callId: string) => {
      const claim = claims.get(stage);
      if (!claim || (claim.callId && claim.callId !== callId)) return false;
      claim.callId = callId;
      executionRef ??= callId;
      state = "running";
      return true;
    },
    actions: () =>
      calls.filter((c) => c.body?.action).map((c) => c.body!.action as string),
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
