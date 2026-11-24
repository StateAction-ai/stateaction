import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { AmbiguousApiError, ApiRejection, type JobsApi } from "./api-client.js";
import type { ControllerSettings, LocalControllerSettings } from "./config.js";
import { JournalCorrupt, type Journal, type JournalStore } from "./journal.js";
import {
  awaitWorkerExit,
  inspect,
  spawnChild,
  supportsLocalPipeline,
  type Bootstrap,
  type Exit,
} from "./local-process.js";
import { driveModal } from "./modal-controller.js";
import type { ModalClient } from "./modal-executor.js";
import { markUnknown, type Evidence, type Outcome } from "./outcomes.js";
import { bootId } from "./proc.js";
import { runRecipe } from "./recipe.js";

/**
 * Shared controller: the SAME function runs under the official Render local
 * runner and on Render. It owns no business state and no SQL; every decision
 * is made against SA-25's authoritative API. It never frees capacity itself:
 * slot release needs terminal business state (SA-28) PLUS the physical
 * evidence recorded here.
 */
export type { Evidence, Outcome } from "./outcomes.js";
const ACTIVE = new Set([
  "submitting",
  "submit_unknown",
  "running",
  "cancel_requested",
  "needs_attention",
  "result_pending",
]);
const nonce = () => `ctl-${randomBytes(18).toString("base64url")}`;

export type ControllerDeps = {
  settings: ControllerSettings;
  api: JobsApi;
  store: JournalStore;
  /** The Modal client (controller-side only); required for, and only used by, the Modal executor. */
  modal?: ModalClient;
  /** Test seam only: observe controller milestones. */
  onEvent?: (event: string, detail?: Record<string, unknown>) => void;
};

export async function runController(
  deps: ControllerDeps,
  input: { jobId: string; runRef: string },
): Promise<Outcome> {
  const { settings, api } = deps;
  const { jobId, runRef } = input;
  const emit = (event: string, detail?: Record<string, unknown>) =>
    deps.onEvent?.(event, detail);

  const status = await api.status(jobId);
  if (!ACTIVE.has(status.state))
    return { outcome: "not_admitted", state: status.state };
  try {
    await api.act(jobId, { action: "record_workflow_run", runRef });
  } catch (error) {
    // A different run already owns this job (SA-27 repair territory): no effects.
    if (error instanceof ApiRejection)
      return { outcome: "no_effect", reason: "run_rejected" };
    throw error;
  }

  // A native retry of the same run must wait for its predecessor's lease; finite.
  const owner = nonce();
  const leaseUntil = Date.now() + settings.leaseWaitMs;
  let leaseExpiresAt: number;
  for (;;) {
    const grant = await api.act(jobId, {
      action: "claim_lease",
      runRef,
      owner,
    });
    if ("granted" in grant && grant.granted) {
      leaseExpiresAt = Date.parse(grant.expiresAt);
      break;
    }
    if (!("granted" in grant) || grant.reason !== "live_owner")
      return { outcome: "no_effect", reason: "lease_refused" };
    if (Date.now() >= leaseUntil)
      return { outcome: "no_effect", reason: "lease_wait_exhausted" };
    await sleep(Math.min(2000, settings.renewIntervalMs));
  }
  emit("lease_claimed");

  let leaseRevoked = false;
  const leaseDeadline = () =>
    !leaseRevoked && Date.now() < leaseExpiresAt ? leaseExpiresAt : undefined;
  const lost = () => leaseDeadline() === undefined;
  const stopRenew = { stop: false };
  const renewer = (async () => {
    for (; !stopRenew.stop; ) {
      await sleep(settings.renewIntervalMs);
      if (stopRenew.stop || lost()) return;
      try {
        const r = await api.act(jobId, { action: "renew_lease", owner });
        if ("renewed" in r && r.renewed)
          leaseExpiresAt = Date.parse(r.expiresAt);
        else {
          const terminal = await jobIsTerminal(api, jobId);
          if (terminal === undefined) continue; // unreadable: neither extend nor revoke
          if (!terminal) leaseRevoked = true;
          else {
            // The job already ended (the sealing worker's accepted result): reaping the child and
            // recording the stage and evidence still run under the last lease, which the server
            // settles after the job ended. Allow a bounded local window for that, then stop renewing.
            leaseExpiresAt = Math.max(leaseExpiresAt, Date.now() + SETTLE_MS);
            return;
          }
        }
      } catch {
        // An ambiguous renewal cannot extend the last confirmed lease.
      }
      if (lost()) return;
    }
  })();
  try {
    // SA-91: a job admitted with a recipe runs its stages; a job without one runs as before.
    const recipe = await api.recipe(jobId);
    const clipPlan = status.kind === "clip_plan";
    if (clipPlan && recipe)
      return {
        outcome: "needs_operator",
        reason: "unexpected_clip_plan_recipe",
      };
    if (recipe)
      return await runRecipe(
        deps,
        { jobId, runRef, owner },
        recipe,
        status,
        leaseDeadline,
        emit,
      );
    return await drive(
      clipPlan
        ? { ...deps, settings: { ...settings, pipeline: "clip_plan_cpu_v1" } }
        : deps,
      { jobId, runRef, owner },
      status.executionBackend,
      leaseDeadline,
      emit,
    );
  } finally {
    stopRenew.stop = true;
    await renewer.catch(() => undefined);
  }
}

/**
 * The server refuses lease renewals for a terminal job by design. A job that is already terminal
 * (the sealing worker's accepted result) is not a revoked lease: the controller must still reap
 * the child and record its stage and evidence under the last confirmed lease. A job still active keeps the
 * refusal a revocation; an unreadable status is ambiguous (retried on the next tick).
 */
async function jobIsTerminal(
  api: JobsApi,
  jobId: string,
): Promise<boolean | undefined> {
  try {
    return ["succeeded", "failed", "cancelled"].includes(
      (await api.status(jobId)).state,
    );
  } catch {
    return undefined;
  }
}

/** Local settle window after the job ended, for reaping the child and recording stage evidence. */
const SETTLE_MS = 5 * 60_000;

async function drive(
  deps: ControllerDeps,
  id: { jobId: string; runRef: string; owner: string },
  executionBackend: Awaited<ReturnType<JobsApi["status"]>>["executionBackend"],
  leaseDeadline: () => number | undefined,
  emit: (event: string, detail?: Record<string, unknown>) => void,
): Promise<Outcome> {
  const { settings, api, store } = deps;
  const { jobId, owner } = id;
  const lost = () => leaseDeadline() === undefined;
  if (lost()) return { outcome: "lease_lost" };
  if (settings.executor === "modal") {
    // The Modal path has its own journal and ordering (the call ID exists only after the spawn).
    if (!deps.modal)
      return { outcome: "no_effect", reason: "modal_client_missing" };
    return driveModal({ ...deps, settings, modal: deps.modal }, id, lost, emit);
  }
  // SA-42: the local executor never spawns for a job admitted to another backend, and never
  // guesses around a Modal journal (that call may be billing).
  if (store.hasModalJournal(jobId))
    return unknown(deps, id, "foreign_modal_journal");
  if (executionBackend !== "local")
    return { outcome: "needs_operator", reason: "backend_mismatch" };
  const currentBoot = bootId();
  let journal: Journal | undefined;
  try {
    journal = store.read(jobId);
  } catch (error) {
    if (!(error instanceof JournalCorrupt)) throw error;
    if (lost()) return { outcome: "lease_lost" };
    return unknown(deps, id, "journal_corrupt");
  }

  if (lost())
    return journal
      ? { outcome: "lease_lost", executionRef: journal.executionRef }
      : { outcome: "lease_lost" };
  if (journal && journal.bootId !== currentBoot)
    return unknown(deps, id, "boot_changed", journal.executionRef);
  if (journal && journal.runRef !== id.runRef)
    return unknown(deps, id, "journal_run_mismatch", journal.executionRef);

  if (!journal) {
    if (!supportsLocalPipeline(settings))
      return {
        outcome: "needs_operator",
        reason: "execution_isolation_unproven",
      };
    const status = await api.status(jobId);
    if (lost()) return { outcome: "lease_lost" };
    if (status.state !== "submitting")
      // Intent exists elsewhere/earlier but we hold no local identity: operator recovery.
      return { outcome: "needs_operator", reason: "no_local_journal" };
    const sub = await api.act(jobId, {
      action: "record_worker_submission",
      owner,
    });
    if (lost()) return { outcome: "lease_lost" };
    if (!("state" in sub) || sub.state !== "recorded") {
      // Lost acknowledgement (or another controller): intent exists, the token is gone. NEVER spawn.
      return unknown(deps, id, "intent_recorded_without_token");
    }
    // Persist token + execution identity before ANY physical effect.
    store.saveToken(jobId, sub.bootstrapToken);
    if (lost()) return { outcome: "lease_lost" };
    journal = {
      version: 1,
      jobId,
      runRef: id.runRef,
      executionRef: `local-${randomUUID()}`,
      phase: "intent",
      ...(settings.pipeline !== "local_fixture_noop"
        ? { threadedPipeline: true }
        : {}),
      bootId: currentBoot,
      startDeadline: sub.startDeadline,
      executionDeadline: sub.executionDeadline,
    };
    store.write(journal);
    emit("intent_journaled");
  }

  if (journal.phase === "spawning")
    // The spawn may or may not have happened: never a second child.
    return unknown(deps, id, "spawn_outcome_uncertain", journal.executionRef);

  if (journal.phase === "intent") {
    if (
      !supportsLocalPipeline(settings) ||
      Boolean(journal.threadedPipeline) !==
        (settings.pipeline !== "local_fixture_noop")
    )
      return unknown(
        deps,
        id,
        "execution_isolation_unproven",
        journal.executionRef,
      );
    if (lost())
      return { outcome: "lease_lost", executionRef: journal.executionRef };
    if (Date.parse(journal.executionDeadline) <= Date.now())
      return unknown(deps, id, "deadline_before_spawn", journal.executionRef);
    await api.act(jobId, {
      action: "record_execution",
      owner,
      executor: { kind: "local", localExecutionRef: journal.executionRef },
    });
    journal = { ...journal, phase: "execution_recorded" };
    emit("execution_recorded");
  }

  if (journal.phase === "execution_recorded") {
    if (
      !supportsLocalPipeline(settings) ||
      Boolean(journal.threadedPipeline) !==
        (settings.pipeline !== "local_fixture_noop")
    )
      return unknown(
        deps,
        id,
        "execution_isolation_unproven",
        journal.executionRef,
      );
    const token = store.loadToken(jobId);
    if (!token || Date.parse(journal.executionDeadline) <= Date.now())
      return unknown(deps, id, "no_token_or_deadline", journal.executionRef);
    if (lost())
      return { outcome: "lease_lost", executionRef: journal.executionRef };
    // A stalled controller can resume after a same-run takeover. Only the
    // winner may write a spawn phase or start a process, even after lease loss.
    if (!store.reserveSpawn(jobId))
      return {
        outcome: "needs_operator",
        reason: "spawn_already_reserved",
        executionRef: journal.executionRef,
      };
    // Written BEFORE the spawn; the token file stays until the child has its stdin.
    journal = { ...journal, phase: "spawning" };
    store.write(journal);
    emit("spawning");
    if (lost())
      return { outcome: "lease_lost", executionRef: journal.executionRef };
    const spawned = await spawnChild(settings, store, journal);
    journal = spawned.journal;
    let bootstrap: Bootstrap | undefined;
    try {
      if (lost())
        return { outcome: "lease_lost", executionRef: journal.executionRef };
      // Persist the kernel acknowledgement before the worker can claim the job.
      store.write(journal);
      if (lost())
        return { outcome: "lease_lost", executionRef: journal.executionRef };
      if (journal.singleProcess || journal.pidNamespace)
        bootstrap = {
          schemaVersion: 1,
          apiUrl: settings.apiUrl,
          jobId,
          bootstrapToken: token,
          executionRef: journal.executionRef,
          pipeline: settings.pipeline,
          ...(settings.fixtureHoldSeconds === undefined
            ? {}
            : { fixtureHoldSeconds: settings.fixtureHoldSeconds }),
        };
    } finally {
      spawned.provideBootstrap(bootstrap);
    }
    store.discardToken(jobId);
    emit("child_running", { pid: journal.pid });
    return supervise(
      { ...deps, settings },
      id,
      journal,
      spawned.exited,
      leaseDeadline,
      emit,
    );
  }

  // phase running | exited: adopt the known execution; never spawn.
  return supervise(
    { ...deps, settings },
    id,
    journal,
    undefined,
    leaseDeadline,
    emit,
  );
}

export async function supervise(
  deps: ControllerDeps & { settings: LocalControllerSettings },
  id: { jobId: string; owner: string; runRef: string },
  start: Journal,
  ownChild: Promise<Exit> | undefined,
  leaseDeadline: () => number | undefined,
  emit: (event: string, detail?: Record<string, unknown>) => void,
): Promise<Outcome> {
  const { settings, store } = deps;
  if (!start.singleProcess && !start.pidNamespace)
    return unknown(
      deps,
      id,
      "execution_isolation_unproven",
      start.executionRef,
    );
  let journal = start;
  let exit: Exit | undefined = journal.exit;
  const deadline = Date.parse(journal.executionDeadline);
  // SA-91 stage only: the stage wall budget (absent for a job without a recipe).
  const budget =
    journal.budgetDeadline === undefined
      ? undefined
      : Date.parse(journal.budgetDeadline);
  const ref = journal.executionRef;
  const lost = () => leaseDeadline() === undefined;
  const leaseLost = (): Outcome => {
    emit("lease_lost");
    return { outcome: "lease_lost", executionRef: ref };
  };
  if (ownChild) void ownChild.then((e) => (exit = e));

  // Provenance recorded with the evidence: why the child was ended and how this run found it.
  let termination = "natural_exit";
  const recovery = ownChild ? "spawned_by_this_run" : "adopted_from_journal";
  let lastStatus = 0;

  if (journal.phase === "running") {
    for (;;) {
      if (lost()) return leaseLost();
      const state = inspect(journal, settings.python);
      if (lost()) return leaseLost();
      if (state.kind === "unknown") return unknown(deps, id, state.reason, ref);
      if (state.kind === "gone") break;
      // Cancellation and the start deadline are enforced physically (the server already stops
      // reads/outputs); polled on the renewal cadence and finite.
      if (
        termination === "natural_exit" &&
        Date.now() - lastStatus >= settings.renewIntervalMs
      ) {
        lastStatus = Date.now();
        try {
          const current = (await deps.api.status(id.jobId)).state;
          if (current === "cancel_requested") termination = "cancel_requested";
          else if (
            current === "submitting" &&
            Date.now() >= Date.parse(journal.startDeadline)
          )
            termination = "start_deadline";
        } catch {
          /* ambiguous status: keep supervising */
        }
        if (lost()) return leaseLost();
      }
      if (
        termination === "natural_exit" &&
        budget !== undefined &&
        Date.now() >= budget
      )
        termination = "budget_exceeded";
      if (Date.now() >= deadline || termination !== "natural_exit") {
        if (Date.now() >= deadline) termination = "execution_deadline";
        // Kill only the verified identity, then require proof while the lease is held.
        const exited = await awaitWorkerExit(
          settings.python,
          journal,
          settings.reapGraceMs,
          settings.pollIntervalMs,
          leaseDeadline,
        );
        if (lost()) return leaseLost();
        if (!exited)
          return {
            outcome: "needs_operator",
            reason: "worker_exit_unproven_after_kill",
            executionRef: ref,
          };
        break;
      }
      await sleep(settings.pollIntervalMs);
    }
    // Capture the exit status if this run owns the verified single process.
    if (ownChild && exit === undefined)
      exit = await Promise.race([ownChild, sleep(2000).then(() => undefined)]);
    if (lost()) return leaseLost();
    journal = {
      ...journal,
      phase: "exited",
      exit: exit ?? journal.exit ?? { code: null, signal: "not_observed" },
      ...(journal.stage ? { termination } : {}),
    };
    store.write(journal);
    emit("child_exited", { exit: journal.exit });
  }

  // Neither isolation mode could create a child process. The threaded mode
  // also requires a process-wide exit observation before reaching this point.
  if (lost()) return leaseLost();
  let evidence: Evidence = "withheld";
  if (!journal.evidenceRecorded) {
    const observed =
      ownChild !== undefined || journal.exit?.signal !== "not_observed";
    try {
      await deps.api.act(id.jobId, {
        action: "record_execution_evidence",
        evidence: {
          kind: "local_child_reaped",
          executionRef: ref,
          detail: {
            observation: observed
              ? "reaped_by_controller"
              : journal.pidNamespace
                ? "adopted_thread_group_exited"
                : "adopted_single_process_exited",
            exitCode: String(journal.exit?.code ?? "null"),
            exitSignal: String(journal.exit?.signal ?? "null"),
            termination,
            recovery,
            proof: journal.pidNamespace
              ? "seccomp_pidfd_thread_group_exited"
              : "seccomp_single_process_exited",
            runRef: id.runRef,
          },
        },
      });
      if (lost()) return leaseLost();
      journal = { ...journal, evidenceRecorded: true };
      store.write(journal);
      evidence = "recorded";
    } catch (error) {
      if (
        !(error instanceof AmbiguousApiError || error instanceof ApiRejection)
      )
        throw error;
      if (lost()) return leaseLost();
      evidence = "unconfirmed";
    }
  } else evidence = "recorded";
  emit("evidence", { evidence });
  return {
    outcome: "child_exited",
    executionRef: ref,
    exit: journal.exit!,
    evidence,
  };
}

async function unknown(
  deps: ControllerDeps,
  id: { jobId: string; owner: string },
  reason: string,
  executionRef?: string,
): Promise<Outcome> {
  return markUnknown(deps.api, id, reason, executionRef);
}
