import { setTimeout as sleep } from "node:timers/promises";
import { AmbiguousApiError, ApiRejection } from "./api-client.js";
import type { ModalControllerSettings } from "./config.js";
import type { ControllerDeps } from "./controller.js";
import { CALL_ID, JournalCorrupt, type ModalJournal } from "./journal.js";
import {
  ModalSpawnNotSent,
  parseRunResult,
  type ModalClient,
  type ModalRunResult,
} from "./modal-executor.js";
import { markUnknown, type Evidence, type Outcome } from "./outcomes.js";

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
 */
export type ModalDeps = Omit<ControllerDeps, "settings" | "modal"> & {
  settings: ModalControllerSettings;
  modal: ModalClient;
};
type Id = { jobId: string; runRef: string; owner: string };
type Emit = (event: string, detail?: Record<string, unknown>) => void;

export async function driveModal(
  deps: ModalDeps,
  id: Id,
  lost: () => boolean,
  emit: Emit,
): Promise<Outcome> {
  const { settings, api, store, modal } = deps;
  const { jobId, owner } = id;
  const uncertain = (reason: string, ref?: string) =>
    markUnknown(api, id, reason, ref);

  // A local journal for this job means a different executor ran it: never guess around it.
  if (store.hasLocalJournal(jobId)) return uncertain("foreign_local_journal");
  let journal: ModalJournal | undefined;
  try {
    journal = store.readModal(jobId);
  } catch (error) {
    if (!(error instanceof JournalCorrupt)) throw error;
    return uncertain("journal_corrupt");
  }

  const status = await api.status(jobId);
  if (status.executionBackend !== "modal")
    // The admitted backend is authoritative; never spawn on a different one.
    return { outcome: "needs_operator", reason: "backend_mismatch" };
  const known = status.executionRef;
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
      };
      store.writeModal(journal);
      emit("adopted_from_server");
    } else {
      if (status.state !== "submitting")
        return { outcome: "needs_operator", reason: "no_local_journal" };
      const sub = await api.act(jobId, {
        action: "record_worker_submission",
        owner,
      });
      if (!("state" in sub) || sub.state !== "recorded")
        // Lost acknowledgement (or another controller): intent exists, the token is gone. NEVER spawn.
        return uncertain("intent_recorded_without_token");
      store.saveToken(jobId, sub.bootstrapToken);
      if (sub.executionBackend !== "modal") {
        store.discardToken(jobId);
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
      };
      store.writeModal(journal);
      store.discardToken(jobId);
      emit("adopted_from_server");
    }
  }

  if (!journal) return { outcome: "needs_operator", reason: "no_journal" };
  if (journal.phase === "spawning") {
    // The spawn may or may not have happened, and nothing proves which: never a second one.
    store.discardToken(jobId);
    return uncertain("spawn_outcome_uncertain");
  }

  if (journal.phase === "intent") {
    // A spawn needs the lease, a token and BOTH immutable deadlines still ahead: after a lease loss
    // or an expired start/execution bound a new paid call could never claim (and nobody supervises it).
    if (lost()) {
      emit("lease_lost");
      return { outcome: "lease_lost" };
    }
    const token = store.loadToken(jobId);
    const submitBy = Math.min(
      Date.parse(journal.startDeadline),
      Date.parse(journal.executionDeadline),
    );
    if (!token || Date.now() >= submitBy)
      return uncertain("no_token_or_deadline");
    // The reservation survives a same-run takeover during a stalled journal write.
    if (!store.reserveSpawn(jobId)) return uncertain("spawn_outcome_uncertain");
    // Written BEFORE the spawn; from here on an unacknowledged spawn stays uncertain forever.
    journal = { ...journal, phase: "spawning" };
    store.writeModal(journal);
    emit("spawning");
    let callId: string;
    try {
      callId = await modal.spawn(
        {
          schemaVersion: 1,
          apiUrl: settings.apiUrl,
          jobId,
          bootstrapToken: token,
          pipeline: settings.pipeline,
        },
        () => !lost() && Date.now() < submitBy,
      );
    } catch (error) {
      store.discardToken(jobId);
      if (error instanceof ModalSpawnNotSent) {
        if (lost()) return { outcome: "lease_lost" };
        return uncertain("spawn_not_sent");
      }
      // An issued request can start a call even if its acknowledgement is lost.
      return uncertain("spawn_outcome_uncertain");
    }
    store.discardToken(jobId);
    if (!CALL_ID.test(callId)) return uncertain("invalid_call_id");
    const submitted: ModalJournal = {
      ...journal,
      phase: "submitted",
      callId,
    };
    try {
      store.writeModal(submitted);
    } catch (error) {
      // Last resort to keep the identity durable somewhere: tell the server, then fail the task.
      await api
        .act(jobId, {
          action: "record_execution",
          owner,
          executor: { kind: "modal", functionCallId: callId },
        })
        .catch(() => undefined);
      throw error;
    }
    journal = submitted;
    emit("call_submitted", { callId });
    return supervise(deps, id, journal, "spawned_by_this_run", lost, emit);
  }

  return supervise(deps, id, journal, "adopted_from_journal", lost, emit);
}

async function supervise(
  deps: ModalDeps,
  id: Id,
  start: ModalJournal,
  recovery: "spawned_by_this_run" | "adopted_from_journal",
  lost: () => boolean,
  emit: Emit,
): Promise<Outcome> {
  const { settings, api, store, modal } = deps;
  let journal = start;
  const callId = journal.callId!;
  const deadline = Date.parse(journal.executionDeadline);
  let termination = journal.termination ?? "natural_exit";
  let lastStatus = 0;
  let graceUntil: number | undefined;
  let result: ModalRunResult | undefined =
    journal.phase === "terminal"
      ? {
          schemaVersion: 1,
          functionCallId: callId,
          exitCode: journal.exitCode!,
        }
      : undefined;

  while (result === undefined) {
    if (lost()) {
      emit("lease_lost");
      return { outcome: "lease_lost", executionRef: callId };
    }
    if (!journal.executionRecorded) {
      try {
        // Idempotent: `recorded:false` means the worker claim already set this same ID.
        await api.act(id.jobId, {
          action: "record_execution",
          owner: id.owner,
          executor: { kind: "modal", functionCallId: callId },
        });
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

    const seen = await modal.poll(callId);
    if (seen.kind === "returned") {
      const parsed = parseRunResult(seen.value, callId);
      if (parsed) {
        result = parsed;
        break;
      }
      // A value that is not our structured result for this call proves nothing.
      emit("unexpected_result");
    }

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
    if (termination === "natural_exit" && Date.now() >= deadline)
      termination = "execution_deadline";

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
    await sleep(settings.pollIntervalMs);
  }

  if (journal.phase !== "terminal") {
    journal = {
      ...journal,
      phase: "terminal",
      exitCode: result.exitCode,
      termination,
    };
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
