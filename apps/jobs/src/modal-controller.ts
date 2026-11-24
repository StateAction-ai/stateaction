import type { ModalRerunBinding } from "@stateaction/contracts";
import { setTimeout as sleep } from "node:timers/promises";
import type { DagRunNode, Stage } from "@stateaction/contracts";
import {
  AmbiguousApiError,
  ApiRejection,
  type JobStatus,
} from "./api-client.js";
import type { ModalControllerSettings } from "./config.js";
import type { ControllerDeps } from "./controller.js";
import { CALL_ID, JournalCorrupt, type ModalJournal } from "./journal.js";
import {
  ModalSpawnNotSent,
  parseRunResult,
  type ModalBootstrap,
  type ModalClient,
  type HandPoseBootstrap,
  type ModalRunResult,
  type StageBootstrap,
} from "./modal-executor.js";
import {
  markStageUnknown,
  markUnknown,
  type Evidence,
  type Outcome,
} from "./outcomes.js";

/**
 * SA-42 Modal driver. Same state machine as the local executor, adapted to the
 * one fact that differs: the provider call ID exists only AFTER the single spawn.
 *
 *   server intent + token -> journal `intent` -> journal `spawning` -> ONE spawn
 *   -> journal `submitted` (call ID) -> record_execution -> poll -> structured
 *   terminal result -> `provider_call_terminal` evidence.
 *
 * Invariants (each has a test):
 *  - at most one spawn per job: a `spawning` journal without a call ID, a
 *    rejected/lost spawn or a missing journal NEVER leads to a second spawn;
 *  - a known call ID (journal OR the server's recorded reference, which the
 *    worker claim may have set first) is adopted, never respawned;
 *  - the only terminal proof is a structured result for the exact recorded call.
 *    A cancel request, poll timeout, function timeout, lease expiry or our own
 *    deadline is NEVER physical-termination proof (stays needs_operator, the
 *    admission slot is retained).
 *
 * SA-91: the same driver runs ONE recipe stage when `stage` is given. The journal is keyed by
 * (job, stage) (`<stateDir>/<jobId>/<stage>/modal-journal.json`), the token is that stage's claim
 * token (`issue_stage_claim`), the server row is the stage run (`record_stage_run`), the known call
 * is the server's stage call, a stage result must carry its receipt, and the stage wall budget
 * cancels an overrunning call (a crashed container is requeued by Modal under the same call ID).
 */
export type ModalDeps = Omit<ControllerDeps, "settings" | "modal"> & {
  settings: ModalControllerSettings;
  modal: ModalClient;
};
type Id = { jobId: string; runRef: string; owner: string };
type Emit = (event: string, detail?: Record<string, unknown>) => void;

/** SA-91: one recipe stage for the shared driver. */
export type ModalStage = {
  stage: Stage;
  module: string;
  budgetSeconds: number;
  binding?: ModalRerunBinding;
  /** The server's recorded run of this stage (dag-run), or undefined when none is recorded. */
  node: DagRunNode | undefined;
  /** Job status read once by the recipe runner for this entry. */
  status: JobStatus;
  bootstrap: (token: string) => StageBootstrap | HandPoseBootstrap;
};

const iso = (ms: number) => new Date(ms).toISOString();
const GPU_WATCH_INTERVAL_MS = 15_000;

type KnownGpuCall = { catalogId?: string; journal?: ModalJournal };

const primaryGpuCall = (call: KnownGpuCall | undefined) =>
  call?.catalogId ?? call?.journal?.callId;

function rememberGpuCall(
  call: KnownGpuCall | undefined,
  journal: ModalJournal,
) {
  if (!call || !journal.callId || !CALL_ID.test(journal.callId)) return;
  call.journal = journal;
}

export async function driveModal(
  deps: ModalDeps,
  id: Id,
  lost: () => boolean,
  emit: Emit,
  stage?: ModalStage,
): Promise<Outcome> {
  const gpu: KnownGpuCall | undefined =
    stage?.binding && stage.binding.gpu !== "none" ? {} : undefined;
  if (gpu && stage?.node?.callId && CALL_ID.test(stage.node.callId)) {
    gpu.catalogId = stage.node.callId;
  }
  let outcome: Outcome;
  try {
    outcome = await driveModalCall(deps, id, lost, emit, stage, gpu);
  } catch (error) {
    const executionRef = primaryGpuCall(gpu);
    if (!executionRef) throw error;
    outcome = {
      outcome: "needs_operator",
      reason: "gpu_supervision_failed",
      executionRef,
    };
  }

  // A catalog ID and a journal ID are separate facts. An old acknowledgement
  // or terminal result can exempt only the exact call it names.
  const executionRef = primaryGpuCall(gpu);
  if (!executionRef) return outcome;
  const journal = gpu?.journal;
  const journalRef = journal?.callId;
  const failed: string[] = [];
  for (const ref of new Set([executionRef, journalRef])) {
    if (
      !ref ||
      (outcome.outcome === "call_terminal" && outcome.executionRef === ref) ||
      (journalRef === ref &&
        (journal?.phase === "terminal" || journal?.cancelRequestedAt))
    )
      continue;
    try {
      await deps.modal.cancel(ref);
    } catch {
      failed.push(ref);
      emit("gpu_cancel_unconfirmed", { callId: ref });
      continue;
    }
    emit("gpu_cancel_requested", { callId: ref });
    if (journal?.phase === "submitted" && journalRef === ref) {
      try {
        deps.store.writeModal({
          ...journal,
          cancelRequestedAt: iso(Date.now()),
          termination: "gpu_supervision_stopped",
        });
      } catch {
        // By exact ID, a retried termination request is idempotent.
      }
    }
  }
  if (journalRef && journalRef !== executionRef) {
    return {
      outcome: "needs_operator",
      reason: "execution_ref_mismatch",
      executionRef,
      conflictingExecutionRef: journalRef,
      ...(failed.length ? { unconfirmedCancellationRefs: failed } : {}),
    };
  }
  if (failed.length)
    return {
      outcome: "needs_operator",
      reason: "gpu_cancel_unconfirmed",
      executionRef,
    };
  if (outcome.outcome === "needs_operator" && !outcome.executionRef)
    return { ...outcome, executionRef };
  return outcome;
}

async function driveModalCall(
  deps: ModalDeps,
  id: Id,
  lost: () => boolean,
  emit: Emit,
  stage: ModalStage | undefined,
  gpu: KnownGpuCall | undefined,
): Promise<Outcome> {
  const { settings, api, store, modal } = deps;
  const { jobId, owner } = id;
  const key = stage?.stage;
  const uncertain = (reason: string, ref?: string) =>
    stage
      ? markStageUnknown(api, id, stage, reason, ref ?? primaryGpuCall(gpu))
      : markUnknown(api, id, reason, ref);
  const stageFields = (budgetFrom: number) =>
    stage
      ? {
          stage: stage.stage,
          budgetDeadline: iso(budgetFrom + stage.budgetSeconds * 1000),
        }
      : {};

  // A local journal for this job means a different executor ran it: never guess around it.
  if (store.hasLocalJournal(jobId, key))
    return uncertain("foreign_local_journal");
  let journal: ModalJournal | undefined;
  try {
    journal = store.readModal(jobId, key);
    if (journal) rememberGpuCall(gpu, journal);
  } catch (error) {
    if (!(error instanceof JournalCorrupt)) throw error;
    return uncertain("journal_corrupt");
  }

  const status = stage ? stage.status : await api.status(jobId);
  if (status.executionBackend !== "modal")
    // The admitted backend is authoritative; never spawn on a different one.
    return { outcome: "needs_operator", reason: "backend_mismatch" };
  // A stage's known call is the server's stage call (the claiming worker's, else the spawn's).
  const known = stage ? (stage.node?.callId ?? null) : status.executionRef;
  if (known !== null && !CALL_ID.test(known))
    return { outcome: "needs_operator", reason: "invalid_recorded_ref" };
  if (
    journal?.callId !== undefined &&
    known !== null &&
    known !== journal.callId
  )
    return {
      outcome: "needs_operator",
      reason: "execution_ref_mismatch",
      executionRef: journal.callId,
    };

  let issuedClaim = false;
  if (!journal) {
    if (known !== null) {
      // The server already holds a call (the worker claim or an earlier controller recorded it):
      // adopt it. The deadline is the server's immutable one.
      if (status.executionDeadline === null || status.startDeadline === null)
        return { outcome: "needs_operator", reason: "no_deadline" };
      journal = {
        version: 1,
        executor: "modal",
        jobId,
        runRef: id.runRef,
        phase: "submitted",
        // Both bounds are the server's immutable ones (never the execution deadline in place of the start bound).
        startDeadline: status.startDeadline,
        executionDeadline: status.executionDeadline,
        callId: known,
        executionRecorded: true,
        // An adopted stage keeps its budget from the server-observed start, else from now.
        ...stageFields(
          stage?.node?.startedAt
            ? Date.parse(stage.node.startedAt)
            : gpu
              ? Date.now() - stage!.budgetSeconds * 1000
              : Date.now(),
        ),
      };
      rememberGpuCall(gpu, journal);
      store.writeModal(journal);
      emit("adopted_from_server");
    } else {
      // A stage with a recorded run but no known call has an issued claim we hold no token for.
      if (stage && stage.node !== undefined && stage.node.state !== "pending")
        return uncertain("no_local_journal");
      if (!stage && status.state !== "submitting")
        return { outcome: "needs_operator", reason: "no_local_journal" };
      const sub = await api.act(
        jobId,
        stage
          ? { action: "issue_stage_claim", owner, stage: stage.stage }
          : { action: "record_worker_submission", owner },
      );
      if (!("state" in sub) || sub.state !== "recorded")
        // Lost acknowledgement (or another controller): intent exists, the token is gone. NEVER spawn.
        return uncertain("intent_recorded_without_token");
      issuedClaim = true;
      store.saveToken(jobId, sub.bootstrapToken, key);
      if (sub.executionBackend !== "modal") {
        store.discardToken(jobId, key);
        return uncertain("backend_mismatch_after_intent");
      }
      journal = {
        version: 1,
        executor: "modal",
        jobId,
        runRef: id.runRef,
        phase: "intent",
        startDeadline: sub.startDeadline,
        executionDeadline: sub.executionDeadline,
        ...(stage ? { stage: stage.stage } : {}),
      };
      store.writeModal(journal);
      emit("intent_journaled");
    }
  } else if (journal.phase === "spawning" || journal.phase === "intent") {
    if (known !== null) {
      // The spawn did happen and the worker (or a record) already reported the call: adopt.
      journal = {
        ...journal,
        phase: "submitted",
        callId: known,
        executionRecorded: true,
        ...(stage && journal.budgetDeadline === undefined
          ? stageFields(
              gpu ? Date.now() - stage.budgetSeconds * 1000 : Date.now(),
            )
          : {}),
      };
      rememberGpuCall(gpu, journal);
      store.writeModal(journal);
      store.discardToken(jobId, key);
      emit("adopted_from_server");
    }
  }

  if (!journal) return { outcome: "needs_operator", reason: "no_journal" };
  if (journal.phase === "spawning") {
    // The spawn may or may not have happened, and nothing proves which: never a second one.
    store.discardToken(jobId, key);
    return uncertain("spawn_outcome_uncertain");
  }

  if (journal.phase === "intent") {
    // A spawn needs the lease, a token and BOTH immutable deadlines still ahead: after a lease loss
    // or an expired start/execution bound a new paid call could never claim (and nobody supervises it).
    if (lost()) {
      emit("lease_lost");
      return { outcome: "lease_lost" };
    }
    const token = store.loadToken(jobId, key);
    const submitBy = Math.min(
      Date.parse(journal.startDeadline),
      Date.parse(journal.executionDeadline),
    );
    if (!token || Date.now() >= submitBy)
      return uncertain("no_token_or_deadline");
    // Check a resumed intent before recording submission. The SDK rechecks at spawn.
    if (
      !issuedClaim &&
      stage?.binding &&
      !(await modal.checkFunction?.(stage.module, stage.binding))
    ) {
      return { outcome: "needs_operator", reason: "rerun_binding_unavailable" };
    }
    if (stage) {
      // The server row goes BEFORE the local spawn mark: a lost answer re-enters at `intent`
      // (provably unspawned) and repeats this idempotent record instead of becoming uncertain.
      try {
        await api.act(jobId, {
          action: "record_stage_run",
          owner,
          stage: stage.stage,
          state: "submitting",
          module: stage.module,
        });
      } catch (error) {
        if (!(error instanceof ApiRejection)) throw error;
        return uncertain("stage_submission_refused");
      }
      if (lost()) {
        emit("lease_lost");
        return { outcome: "lease_lost" };
      }
    }
    // The reservation survives a same-run takeover during a stalled journal write.
    if (!store.reserveSpawn(jobId, key))
      return uncertain("spawn_outcome_uncertain");
    // Written BEFORE the spawn; from here on an unacknowledged spawn stays uncertain forever.
    // A stage's wall budget starts here and is fixed for every later entry.
    journal = { ...journal, phase: "spawning", ...stageFields(Date.now()) };
    store.writeModal(journal);
    emit("spawning");
    const bootstrap: ModalBootstrap = stage
      ? stage.bootstrap(token)
      : {
          schemaVersion: 1,
          apiUrl: settings.apiUrl,
          jobId,
          bootstrapToken: token,
          pipeline: settings.pipeline,
        };
    let callId: string;
    try {
      callId = await modal.spawn(
        bootstrap,
        () => !lost() && Date.now() < submitBy,
        stage?.binding,
      );
    } catch (error) {
      store.discardToken(jobId, key);
      if (error instanceof ModalSpawnNotSent) {
        if (lost()) return { outcome: "lease_lost" };
        return uncertain("spawn_not_sent");
      }
      // An issued request can start a call even if its acknowledgement is lost.
      return uncertain("spawn_outcome_uncertain");
    }
    if (!CALL_ID.test(callId)) {
      store.discardToken(jobId, key);
      return uncertain("invalid_call_id");
    }
    const submitted: ModalJournal = {
      ...journal,
      phase: "submitted",
      callId,
    };
    rememberGpuCall(gpu, submitted);
    try {
      store.discardToken(jobId, key);
      store.writeModal(submitted);
    } catch (error) {
      // Last resort to keep the identity durable somewhere: tell the server, then fail the task.
      await api
        .act(jobId, recordCall(owner, callId, stage))
        .catch(() => undefined);
      throw error;
    }
    journal = submitted;
    emit("call_submitted", { callId });
    return supervise(
      deps,
      id,
      journal,
      "spawned_by_this_run",
      lost,
      emit,
      stage,
      gpu,
    );
  }

  return supervise(
    deps,
    id,
    journal,
    "adopted_from_journal",
    lost,
    emit,
    stage,
    gpu,
  );
}

/** The server record of a known call: the job's execution, or the stage run (SA-91). */
function recordCall(owner: string, callId: string, stage?: ModalStage) {
  return stage
    ? {
        action: "record_stage_run" as const,
        owner,
        stage: stage.stage,
        state: "running" as const,
        module: stage.module,
        callId,
      }
    : {
        action: "record_execution" as const,
        owner,
        executor: { kind: "modal" as const, functionCallId: callId },
      };
}

async function supervise(
  deps: ModalDeps,
  id: Id,
  start: ModalJournal,
  recovery: "spawned_by_this_run" | "adopted_from_journal",
  lost: () => boolean,
  emit: Emit,
  stage: ModalStage | undefined,
  gpu: KnownGpuCall | undefined,
): Promise<Outcome> {
  const { settings, api, store, modal } = deps;
  let journal = start;
  const callId = journal.callId!;
  const deadline = Date.parse(journal.executionDeadline);
  const budget =
    journal.budgetDeadline === undefined
      ? undefined
      : Date.parse(journal.budgetDeadline);
  const expect = stage
    ? { jobId: id.jobId, stage: stage.stage, module: stage.module }
    : undefined;
  let termination = journal.termination ?? "natural_exit";
  let lastStatus = 0;
  let lastWatch = 0;
  const gpuBinding = gpu ? stage!.binding : undefined;
  const containers = new Set<string>();
  const checkBudget = () => {
    if (termination !== "natural_exit") return;
    const now = Date.now();
    if (now >= deadline) termination = "execution_deadline";
    else if (budget !== undefined && now >= budget)
      termination = "budget_exceeded";
  };
  let graceUntil: number | undefined;
  let result: ModalRunResult | undefined =
    journal.phase === "terminal"
      ? {
          schemaVersion: stage ? 2 : 1,
          functionCallId: callId,
          exitCode: journal.exitCode!,
          ...(stage ? { receipt: journal.receipt ?? null } : {}),
        }
      : undefined;

  while (result === undefined) {
    if (lost()) {
      emit("lease_lost");
      return { outcome: "lease_lost", executionRef: callId };
    }
    checkBudget();
    if (!journal.executionRecorded && termination === "natural_exit") {
      try {
        // Idempotent: `recorded:false` means the worker claim already set this same ID.
        await api.act(id.jobId, recordCall(id.owner, callId, stage));
        journal = { ...journal, executionRecorded: true };
        store.writeModal(journal);
        emit("execution_recorded");
      } catch (error) {
        if (error instanceof ApiRejection && !lost())
          // A different reference is recorded (or the job no longer accepts one): no evidence.
          return {
            outcome: "needs_operator",
            reason: "execution_ref_conflict",
            executionRef: callId,
          };
        if (
          !(error instanceof AmbiguousApiError || error instanceof ApiRejection)
        )
          throw error;
        // Ambiguous: retried on the next tick.
      }
    }

    if (
      gpuBinding &&
      termination === "natural_exit" &&
      Date.now() - lastWatch >= GPU_WATCH_INTERVAL_MS
    ) {
      lastWatch = Date.now();
      try {
        if (!modal.watchGpuCall) throw new Error("GPU watchdog unavailable");
        for (const container of await modal.watchGpuCall(callId, gpuBinding))
          containers.add(container);
        if (containers.size > 1) termination = "provider_container_restarted";
      } catch {
        termination = "gpu_watchdog_unavailable";
      }
    }
    checkBudget();
    if (
      termination === "natural_exit" &&
      Date.now() - lastStatus >= settings.renewIntervalMs
    ) {
      lastStatus = Date.now();
      try {
        const current = await api.status(id.jobId);
        if (current.state === "cancel_requested")
          termination = "cancel_requested";
        else if (
          current.state === "submitting" &&
          Date.now() >= Date.parse(journal.startDeadline)
        )
          termination = "start_deadline";
      } catch {
        /* ambiguous status: keep supervising */
      }
    }
    checkBudget();
    if (termination !== "natural_exit") {
      // A cancel is only a REQUEST. We keep polling for an observed terminal result for a finite
      // grace; without one the call stays uncertain and the admission slot stays held.
      graceUntil ??= Date.now() + settings.reapGraceMs;
      if (journal.cancelRequestedAt === undefined) {
        try {
          await modal.cancel(callId);
          journal = {
            ...journal,
            cancelRequestedAt: new Date().toISOString(),
            termination,
          };
          rememberGpuCall(gpu, journal);
          store.writeModal(journal);
          emit("cancel_requested", { termination });
        } catch {
          /* ambiguous: retried on the next tick within the grace */
        }
      }
      if (Date.now() >= graceUntil)
        return {
          outcome: "needs_operator",
          reason: "call_not_provably_terminal_after_cancel",
          executionRef: callId,
        };
    }
    const seen = await modal.poll(callId);
    if (gpuBinding) checkBudget();
    if (seen.kind === "returned") {
      const parsed = parseRunResult(seen.value, callId, expect);
      if (parsed) {
        result = parsed;
        break;
      }
      // A value that is not our structured result for this call proves nothing.
      emit("unexpected_result");
    }

    await sleep(settings.pollIntervalMs);
  }

  if (journal.phase !== "terminal") {
    journal = {
      ...journal,
      phase: "terminal",
      exitCode: result.exitCode,
      termination,
      ...(stage && result.receipt ? { receipt: result.receipt } : {}),
    };
    rememberGpuCall(gpu, journal);
    store.writeModal(journal);
    emit("call_terminal", { exitCode: result.exitCode });
  }

  let evidence: Evidence = "withheld";
  if (!journal.evidenceRecorded) {
    try {
      await api.act(id.jobId, {
        action: "record_execution_evidence",
        evidence: {
          kind: "provider_call_terminal",
          executionRef: callId,
          detail: {
            observation: "structured_result_observed",
            exitCode: String(result.exitCode),
            termination: journal.termination ?? termination,
            recovery,
            proof: "function_call_returned_structured_result",
            runRef: id.runRef,
          },
        },
      });
      journal = { ...journal, evidenceRecorded: true };
      store.writeModal(journal);
      evidence = "recorded";
    } catch (error) {
      if (
        !(error instanceof AmbiguousApiError || error instanceof ApiRejection)
      )
        throw error;
      evidence = "unconfirmed";
    }
  } else evidence = "recorded";
  emit("evidence", { evidence });
  return { outcome: "call_terminal", executionRef: callId, result, evidence };
}
