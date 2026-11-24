import { randomUUID } from "node:crypto";
import {
  modalBindingMatchesStage,
  requestSha256,
  type RecipeV1,
  type ModalRerunBinding,
  type Stage,
  type StageReceiptV1,
  type StageRunState,
} from "@stateaction/contracts";
import {
  AmbiguousApiError,
  ApiRejection,
  type JobStatus,
  type PriorStage,
} from "./api-client.js";
import { stageModuleRefusal, type LocalControllerSettings } from "./config.js";
import { supervise, type ControllerDeps } from "./controller.js";
import { JournalCorrupt, type Journal } from "./journal.js";
import {
  lastLogLine,
  spawnChild,
  supportsLocalPipeline,
} from "./local-process.js";
import { driveModal, type ModalStage } from "./modal-controller.js";
import {
  MAX_BOOTSTRAP_BYTES,
  parseStageReceipt,
  type HandPoseBootstrap,
  type StageBootstrap,
  type StageExpectation,
} from "./modal-executor.js";
import {
  markStageUnknown,
  type Outcome,
  type StageSummary,
} from "./outcomes.js";
import { bootId } from "./proc.js";

/** Each stage keeps its SA-91 claim, journal and exact-call terminal proof. */
type Id = { jobId: string; runRef: string; owner: string };
type Emit = (event: string, detail?: Record<string, unknown>) => void;
type Spec = RecipeV1["stages"][number];
type Settled = {
  state: Exclude<StageRunState, "pending" | "submitting" | "running">;
  errorCode?: string;
  receipt?: StageReceiptV1;
};
type SegmentsRef = { fileId: string; sha256: string };

const ACTIVE = new Set(["submitting", "submit_unknown", "running"]);
const TERMINAL = new Set<StageRunState>([
  "succeeded",
  "failed",
  "cancelled",
  "not_run",
]);

export async function runRecipe(
  deps: ControllerDeps,
  id: Id,
  recipe: RecipeV1,
  admitted: Pick<JobStatus, "kind" | "codeRevision">,
  leaseDeadline: () => number | undefined,
  emit: Emit,
): Promise<Outcome> {
  const { api, store, settings } = deps;
  const lost = () => leaseDeadline() === undefined;
  const summaries = new Map<Stage, StageSummary>();
  const stages = () =>
    recipe.stages.flatMap(({ stage }) => {
      const summary = summaries.get(stage);
      return summary ? [summary] : [];
    });
  const stop = (stopped: Outcome): Outcome => ({
    outcome: "recipe_run",
    stages: stages(),
    stopped,
  });
  if (settings.executor === "modal" && !deps.modal)
    return { outcome: "no_effect", reason: "modal_client_missing" };
  const recipeSha256 = requestSha256(recipe);
  const dag = await api.dagRun(id.jobId);
  if (dag.recipeSha256 !== recipeSha256)
    return { outcome: "needs_operator", reason: "recipe_mismatch" };

  // A legacy hand_pose claim may already be responsible for sealing on re-entry.
  const graph = await api.act(id.jobId, {
    action: "start_parallel_recipe",
    owner: id.owner,
  });
  if (!("recorded" in graph))
    return { outcome: "needs_operator", reason: "recipe_graph_invalid" };
  const parallel = graph.recorded;

  let execute: Set<Stage> | undefined;
  let rerunFunctions:
    | Partial<Record<"segment" | "caption" | "handPose", ModalRerunBinding>>
    | undefined;
  if (parallel) {
    let preparation = await api.prepareRerun(id.jobId, id.owner);
    while (preparation.state === "copying" && !lost()) {
      preparation = await api.prepareRerun(id.jobId, id.owner);
    }
    if (lost()) return stop({ outcome: "lease_lost" });
    if (preparation.state === "failed")
      return stop({ outcome: "no_effect", reason: "reuse_unavailable" });
    if (preparation.state === "ready") {
      if (!preparation.execute)
        return stop({
          outcome: "needs_operator",
          reason: "rerun_plan_invalid",
        });
      execute = new Set(preparation.execute);
      rerunFunctions = preparation.functions;
    }
  }

  const releaseBindings =
    settings.executor === "modal" ? settings.verifiedBindings : undefined;
  const bindingFor = (spec: Spec) =>
    execute
      ? rerunFunctions?.[spec.stage === "hand_pose" ? "handPose" : spec.stage]
      : releaseBindings?.get(spec.module);

  /** Relays a settled stage; false when the server refused it (operator path). */
  const record = async (
    spec: Spec,
    settled: Settled,
    callId?: string,
  ): Promise<boolean> => {
    try {
      await recordSettled(deps, id, spec, settled, callId, bindingFor(spec));
    } catch (error) {
      if (!(error instanceof ApiRejection)) throw error;
      return false;
    }
    summaries.set(spec.stage, {
      stage: spec.stage,
      state: settled.state,
      ...(settled.errorCode ? { errorCode: settled.errorCode } : {}),
      ...(callId ? { callId } : {}),
    });
    emit("stage_recorded", { stage: spec.stage, state: settled.state });
    return true;
  };
  const refused = (spec: Spec) =>
    ({
      outcome: "needs_operator",
      reason: `${spec.stage}_record_refused`,
    }) as const;

  let outOfBudget = false;
  const runStage = async (spec: Spec): Promise<Outcome | undefined> => {
    if (lost()) {
      emit("lease_lost");
      return { outcome: "lease_lost" };
    }
    if (execute && !execute.has(spec.stage)) return;
    const expect: StageExpectation = {
      jobId: id.jobId,
      stage: spec.stage,
      module: spec.module,
    };
    // A synthesized `pending` node means no run is recorded for this stage yet.
    const found = dag.stages.find((n) => n.stage === spec.stage);
    const node = found && found.state !== "pending" ? found : undefined;
    if (node && node.module !== spec.module)
      return { outcome: "needs_operator", reason: "stage_module_mismatch" };

    if (!spec.enabled) {
      // Always relayed (an identical replay is a no-op): the server renders a disabled stage
      // without a row as not_run too, but the row is the record.
      if (
        !(await record(spec, { state: "not_run", errorCode: "stage_disabled" }))
      )
        return refused(spec);
      return;
    }
    if (node && TERMINAL.has(node.state)) {
      // Already settled (an earlier entry): never run it again.
      summaries.set(spec.stage, {
        stage: spec.stage,
        state: node.state,
        ...(node.errorCode ? { errorCode: node.errorCode } : {}),
        ...(node.callId ? { callId: node.callId } : {}),
      });
      if (spec.stage !== "hand_pose" && node.errorCode === "budget")
        outOfBudget = true;
      return;
    }

    // The earlier stages as the SERVER recorded them, with every file their slots attribute to
    // them: the caption's segments input and the sealing stage's priorStages. Read per entry, so a
    // controller on a fresh host loses nothing.
    const prior =
      spec.stage === "segment" || (parallel && spec.stage === "hand_pose")
        ? undefined
        : (await api.priorStages(id.jobId)).stages;
    const segmentsRef = segmentsOf(prior);
    const journaled =
      store.hasModalJournal(id.jobId, spec.stage) ||
      store.hasLocalJournal(id.jobId, spec.stage);
    // A stage with neither a journal nor a server row has no claim yet: the gates below may
    // still end it as not_run. Once it is claimed it only ends with proof for its call.
    const fresh = !journaled && node === undefined;
    const binding = bindingFor(spec);
    const clipHandPose =
      admitted.kind === "clip_pipeline" && spec.stage === "hand_pose";
    if (
      settings.executor === "modal" &&
      clipHandPose &&
      !node?.callId &&
      (!binding ||
        binding.gpu !== "none" ||
        binding.codeRevision !== admitted.codeRevision)
    )
      return {
        outcome: "needs_operator",
        reason: "clip_hand_pose_binding_unavailable",
      };
    if (
      settings.executor === "modal" &&
      (execute || releaseBindings) &&
      (!binding ||
        !modalBindingMatchesStage(binding, spec) ||
        (binding.gpu !== "none" &&
          (binding.maxContainers !== 1 ||
            binding.maxBilledSeconds <= 60 ||
            !deps.modal?.watchGpuCall ||
            settings.apiTimeoutMs > 5_000 ||
            settings.pollIntervalMs > 3_000)))
    )
      return { outcome: "needs_operator", reason: "rerun_binding_unavailable" };
    const stageBudgetSeconds =
      binding && binding.gpu !== "none"
        ? Math.min(spec.resources.budgetSeconds, binding.maxBilledSeconds - 60)
        : spec.resources.budgetSeconds;
    if (fresh) {
      const gate = gateOf(spec, prior, outOfBudget);
      if (gate) {
        if (!(await record(spec, { state: "not_run", errorCode: gate })))
          return refused(spec);
        return;
      }
    }
    const status = await api.status(id.jobId);
    if (fresh) {
      if (!ACTIVE.has(status.state))
        return { outcome: "no_effect", reason: "job_not_active" };
      const remaining =
        status.executionDeadline === null
          ? 0
          : Date.parse(status.executionDeadline) - Date.now();
      // The legacy serial graph reserves time for hand pose after the GPU
      // branch. Parallel stages each fit against the shared deadline.
      const handBudget = recipe.stages.find((x) => x.stage === "hand_pose")!
        .resources.budgetSeconds;
      const required = stageBudgetSeconds + (parallel ? 0 : handBudget);
      if (spec.stage !== "hand_pose" && remaining < required * 1000) {
        // Not enough time left for this GPU stage's budget: it and every later GPU stage are not run.
        outOfBudget = true;
        if (!(await record(spec, { state: "not_run", errorCode: "budget" })))
          return refused(spec);
        return;
      }
      if (
        binding &&
        !(await deps.modal?.checkFunction?.(spec.module, binding))
      ) {
        return {
          outcome: "needs_operator",
          reason: "rerun_binding_unavailable",
        };
      }
      const refusal = stageModuleRefusal(settings, spec.stage, spec.module);
      if (refusal) {
        if (!(await record(spec, { state: "not_run", errorCode: refusal })))
          return refused(spec);
        return;
      }
    }

    const bootstrap = (token: string): StageBootstrap | HandPoseBootstrap =>
      spec.stage === "hand_pose"
        ? {
            schemaVersion: 1,
            apiUrl: settings.apiUrl,
            jobId: id.jobId,
            bootstrapToken: token,
            pipeline: "hand_pose_cpu_v1",
            stage: "hand_pose",
            module: spec.module,
            recipeSha256,
            ...(parallel ? { prepareOnly: true as const } : {}),
            priorStages: (prior ?? []).map((p) => ({
              stage: p.stage,
              state: p.state,
              errorCode: p.errorCode,
              counts: p.counts,
              outputs: p.outputs,
            })),
          }
        : {
            schemaVersion: 2,
            apiUrl: settings.apiUrl,
            jobId: id.jobId,
            bootstrapToken: token,
            stage: spec.stage,
            module: spec.module,
            recipeSha256,
            ...(spec.stage === "caption" && segmentsRef
              ? {
                  segmentsFileId: segmentsRef.fileId,
                  segmentsSha256: segmentsRef.sha256,
                }
              : {}),
          };
    if (fresh && oversized(bootstrap)) {
      // The worker refuses a bootstrap over 8 KiB before its claim: fail loudly, never truncate.
      if (
        !(await record(spec, {
          state: "failed",
          errorCode: "bootstrap_too_large",
        }))
      )
        return refused(spec);
      return;
    }
    const run: ModalStage = {
      stage: spec.stage,
      module: spec.module,
      budgetSeconds: stageBudgetSeconds,
      ...(binding ? { binding } : {}),
      node,
      status,
      bootstrap,
    };
    emit("stage_started", { stage: spec.stage });
    const out =
      settings.executor === "modal"
        ? await driveModal(
            { ...deps, settings, modal: deps.modal! },
            id,
            lost,
            emit,
            run,
          )
        : await driveLocalStage(
            { ...deps, settings },
            id,
            run,
            leaseDeadline,
            emit,
          );

    let callId: string;
    let settled: Settled;
    if (out.outcome === "call_terminal" && out.evidence === "recorded") {
      callId = out.executionRef;
      const journal = store.readModal(id.jobId, spec.stage);
      settled = settle(
        journal?.termination ?? "natural_exit",
        out.result.receipt ?? undefined,
      );
    } else if (out.outcome === "child_exited" && out.evidence === "recorded") {
      callId = out.executionRef;
      const journal = store.read(id.jobId, spec.stage);
      settled = settle(
        journal?.termination ?? "natural_exit",
        localReceipt(deps, id.jobId, expect, out.exit.code),
      );
    } else return out;

    if (!(await record(spec, settled, callId))) return refused(spec);
  };

  const runSequence = async (specs: Spec[]) => {
    for (const spec of specs) {
      const stopped = await runStage(spec);
      if (stopped) return stopped;
    }
  };
  if (parallel) {
    const [annotations, hands] = await Promise.allSettled([
      runSequence(recipe.stages.filter(({ stage }) => stage !== "hand_pose")),
      runStage(recipe.stages.find(({ stage }) => stage === "hand_pose")!),
    ]);
    // Keep supervising the other call under the same lease until both branches return.
    if (annotations.status === "rejected") throw annotations.reason;
    if (hands.status === "rejected") throw hands.reason;
    const stopped = annotations.value ?? hands.value;
    if (stopped) return stop(stopped);
    if (lost()) return stop({ outcome: "lease_lost" });
    try {
      const sealed = await api.act(id.jobId, {
        action: "seal_parallel_recipe",
        owner: id.owner,
      });
      if (!("recorded" in sealed) || !sealed.recorded)
        return stop({
          outcome: "needs_operator",
          reason: "recipe_seal_refused",
        });
    } catch (error) {
      if (!(error instanceof ApiRejection)) throw error;
      return stop({ outcome: "needs_operator", reason: "recipe_seal_refused" });
    }
  } else {
    const stopped = await runSequence(recipe.stages);
    if (stopped) return stop(stopped);
  }
  return { outcome: "recipe_run", stages: stages() };
}

/** Why an unclaimed stage is not run, or undefined when it should run. */
function gateOf(
  spec: Spec,
  prior: PriorStage[] | undefined,
  outOfBudget: boolean,
): string | undefined {
  if (!spec.enabled) return "stage_disabled";
  if (spec.stage === "hand_pose") return undefined; // always runs: it seals the job
  if (outOfBudget) return "budget";
  if (spec.stage !== "caption") return undefined;
  const segment = prior?.find((p) => p.stage === "segment");
  if (segment?.state !== "succeeded") return "upstream_failed";
  if (segment.counts.segments === 0) return "no_segments";
  // A succeeded segment stage always stores segments.json; without it there is no input.
  if (!segmentsOf(prior)) return "segments_unavailable";
  return undefined;
}

/** The serialized bootstrap with the largest token and execution ref still fits the worker bound. */
function oversized(
  build: (token: string) => StageBootstrap | HandPoseBootstrap,
): boolean {
  const worst = {
    ...build(`sa_svc_${"x".repeat(43)}`),
    executionRef: "x".repeat(128),
    executorKind: "modal",
  };
  return Buffer.byteLength(JSON.stringify(worst), "utf8") > MAX_BOOTSTRAP_BYTES;
}

/**
 * The recorded stage state from what was observed. A cancel, deadline or budget ending is never
 * a success even if a result arrived afterwards; otherwise the receipt decides, and no receipt is
 * a failure (never an empty success).
 */
function settle(termination: string, receipt?: StageReceiptV1): Settled {
  if (termination === "cancel_requested")
    return { state: "cancelled", errorCode: "cancel_requested" };
  if (termination !== "natural_exit")
    return { state: "failed", errorCode: termination };
  if (!receipt) return { state: "failed", errorCode: "receipt_missing" };
  return receipt.status === "succeeded"
    ? { state: "succeeded", receipt }
    : { state: "failed", errorCode: receipt.errorCode!, receipt };
}

/**
 * Relay the settled stage to `job_stage_runs`. A receipt the server refuses (for example a digest
 * that does not match the stored output) is not a success: the stage is recorded failed without
 * it. An ambiguous answer throws so the native retry repeats this idempotent record.
 */
async function recordSettled(
  deps: ControllerDeps,
  id: Id,
  spec: Spec,
  settled: Settled,
  callId?: string,
  binding?: ModalRerunBinding,
): Promise<void> {
  const base = {
    action: "record_stage_run" as const,
    owner: id.owner,
    stage: spec.stage,
    module: spec.module,
    ...(callId ? { callId } : {}),
  };
  const workerReceipt = settled.receipt;
  const receipt =
    workerReceipt && callId && binding
      ? {
          ...workerReceipt,
          schemaVersion: 2 as const,
          providerBinding: {
            appName: binding.appName,
            codeRevision: binding.codeRevision,
            environment: binding.environment,
            functionId: binding.functionId,
            definitionId: binding.definitionId,
            paramsSha256: binding.paramsSha256,
            definitionSha256: binding.definitionSha256,
            workerReceiptSha256: requestSha256(workerReceipt),
          },
        }
      : workerReceipt;
  try {
    await deps.api.act(id.jobId, {
      ...base,
      state: settled.state,
      ...(settled.errorCode ? { errorCode: settled.errorCode } : {}),
      ...(receipt ? { receipt } : {}),
    });
  } catch (error) {
    if (!(error instanceof ApiRejection) || !settled.receipt) throw error;
    settled.state = "failed";
    settled.errorCode = "receipt_rejected";
    delete settled.receipt;
    await deps.api.act(id.jobId, {
      ...base,
      state: "failed",
      errorCode: "receipt_rejected",
    });
  }
}

function segmentsOf(prior: PriorStage[] | undefined): SegmentsRef | undefined {
  const segment = prior?.find((p) => p.stage === "segment");
  const out = segment?.outputs.find((o) => o.role === "segments_json");
  return segment?.state === "succeeded" && out
    ? { fileId: out.fileId, sha256: out.sha256 }
    : undefined;
}

/**
 * The receipt a local stage child left in its log. An adopted child (controller restart) has no
 * observed exit code: its thread group was proven gone, so a receipt valid for exactly this job,
 * stage and module is still its result (never `receipt_missing` for a sealed success).
 */
function localReceipt(
  deps: ControllerDeps,
  jobId: string,
  expect: StageExpectation,
  exitCode: number | null,
): StageReceiptV1 | undefined {
  return parseStageReceipt(
    lastLogLine(deps.store.logPath(jobId, expect.stage)),
    expect,
    exitCode,
  );
}

/**
 * SA-91 local stage path: the SA-26 local executor for one recipe stage. Same order as the
 * Modal stage path (claim token and journal intent, the server row, then `spawning` before the
 * one child), the same verified-identity supervisor and `local_child_reaped` evidence. The
 * execution ref is known before the spawn, so the server row carries it from `submitting` on.
 */
async function driveLocalStage(
  deps: ControllerDeps & { settings: LocalControllerSettings },
  id: Id,
  stage: ModalStage,
  leaseDeadline: () => number | undefined,
  emit: Emit,
): Promise<Outcome> {
  const { settings, api, store } = deps;
  const { jobId, owner } = id;
  const key = stage.stage;
  const lost = () => leaseDeadline() === undefined;
  const uncertain = (reason: string, ref?: string) =>
    markStageUnknown(api, id, stage, reason, ref);
  if (store.hasModalJournal(jobId, key))
    return uncertain("foreign_modal_journal");
  if (stage.status.executionBackend !== "local")
    return { outcome: "needs_operator", reason: "backend_mismatch" };
  let journal: Journal | undefined;
  try {
    journal = store.read(jobId, key);
  } catch (error) {
    if (!(error instanceof JournalCorrupt)) throw error;
    return uncertain("journal_corrupt");
  }
  const currentBoot = bootId();
  if (journal && journal.bootId !== currentBoot)
    return uncertain("boot_changed", journal.executionRef);
  if (journal && journal.runRef !== id.runRef)
    return uncertain("journal_run_mismatch", journal.executionRef);
  const known = stage.node?.callId ?? null;
  if (journal && known !== null && known !== journal.executionRef)
    return {
      outcome: "needs_operator",
      reason: "execution_ref_mismatch",
      executionRef: journal.executionRef,
    };

  if (!journal) {
    // A local child cannot be adopted without its verified identity.
    if (stage.node !== undefined)
      return known === null
        ? uncertain("no_local_journal")
        : {
            outcome: "needs_operator",
            reason: "no_local_journal",
            executionRef: known,
          };
    if (!supportsLocalPipeline(settings, true))
      return {
        outcome: "needs_operator",
        reason: "execution_isolation_unproven",
      };
    const sub = await api.act(jobId, {
      action: "issue_stage_claim",
      owner,
      stage: key,
    });
    if (lost()) return { outcome: "lease_lost" };
    if (!("state" in sub) || sub.state !== "recorded")
      return uncertain("intent_recorded_without_token");
    store.saveToken(jobId, sub.bootstrapToken, key);
    if (sub.executionBackend !== "local") {
      store.discardToken(jobId, key);
      return uncertain("backend_mismatch_after_intent");
    }
    journal = {
      version: 1,
      jobId,
      stage: key,
      runRef: id.runRef,
      executionRef: `local-${randomUUID()}`,
      phase: "intent",
      threadedPipeline: true,
      bootId: currentBoot,
      startDeadline: sub.startDeadline,
      executionDeadline: sub.executionDeadline,
    };
    store.write(journal);
    emit("intent_journaled", { stage: key });
  }
  const ref = journal.executionRef;

  if (journal.phase === "spawning" || journal.phase === "execution_recorded")
    // The spawn may or may not have happened: never a second child.
    return uncertain("spawn_outcome_uncertain", ref);

  if (journal.phase === "intent") {
    if (!supportsLocalPipeline(settings, true))
      return uncertain("execution_isolation_unproven", ref);
    if (lost()) return { outcome: "lease_lost", executionRef: ref };
    const token = store.loadToken(jobId, key);
    if (!token || Date.parse(journal.executionDeadline) <= Date.now())
      return uncertain("no_token_or_deadline", ref);
    try {
      // The server row (with the identity) before the local spawn mark, as on the Modal path.
      await api.act(jobId, {
        action: "record_stage_run",
        owner,
        stage: key,
        state: "submitting",
        module: stage.module,
        callId: ref,
      });
    } catch (error) {
      if (!(error instanceof ApiRejection)) throw error;
      return uncertain("stage_submission_refused", ref);
    }
    if (lost()) return { outcome: "lease_lost", executionRef: ref };
    if (!store.reserveSpawn(jobId, key))
      return {
        outcome: "needs_operator",
        reason: "spawn_already_reserved",
        executionRef: ref,
      };
    journal = {
      ...journal,
      phase: "spawning",
      budgetDeadline: new Date(
        Date.now() + stage.budgetSeconds * 1000,
      ).toISOString(),
    };
    store.write(journal);
    emit("spawning", { stage: key });
    if (lost()) return { outcome: "lease_lost", executionRef: ref };
    const spawned = await spawnChild(settings, store, journal);
    journal = spawned.journal;
    let bootstrap: StageBootstrap | HandPoseBootstrap | undefined;
    try {
      if (lost()) return { outcome: "lease_lost", executionRef: ref };
      store.write(journal);
      if (lost()) return { outcome: "lease_lost", executionRef: ref };
      if (journal.pidNamespace)
        bootstrap = {
          ...stage.bootstrap(token),
          executionRef: ref,
          executorKind: "local",
        };
    } finally {
      spawned.provideBootstrap(bootstrap);
    }
    store.discardToken(jobId, key);
    emit("child_running", { stage: key, pid: journal.pid });
    try {
      await api.act(jobId, {
        action: "record_stage_run",
        owner,
        stage: key,
        state: "running",
        module: stage.module,
        callId: ref,
      });
    } catch (error) {
      // The identity is already on the row: the running mark is progress only.
      if (
        !(error instanceof AmbiguousApiError || error instanceof ApiRejection)
      )
        throw error;
    }
    return supervise(
      { ...deps, settings },
      id,
      journal,
      spawned.exited,
      leaseDeadline,
      emit,
    );
  }

  // phase running | exited: adopt the known child; never spawn.
  return supervise(
    { ...deps, settings },
    id,
    journal,
    undefined,
    leaseDeadline,
    emit,
  );
}
