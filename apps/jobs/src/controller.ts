import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { AmbiguousApiError, ApiRejection, type JobsApi } from "./api-client.js";
import type { ControllerSettings } from "./config.js";
import { JournalCorrupt, type Journal, type JournalStore } from "./journal.js";
import {
  awaitWorkerExit,
  inspect,
  spawnChild,
  type Bootstrap,
  type Exit,
} from "./local-process.js";
import { bootId } from "./proc.js";

/**
 * Shared controller: the SAME function runs under the official Render local
 * runner and on Render. It owns no business state and no SQL; every decision
 * is made against SA-25's authoritative API. It never frees capacity itself:
 * slot release needs terminal business state (SA-28) PLUS the physical
 * evidence recorded here.
 */
export type Outcome =
  | { outcome: "not_admitted"; state: string }
  | { outcome: "no_effect"; reason: string }
  | {
      outcome: "child_exited";
      executionRef: string;
      exit: Exit;
      evidence: Evidence;
    }
  | { outcome: "submit_unknown"; reason: string }
  | { outcome: "needs_operator"; reason: string; executionRef?: string }
  | { outcome: "lease_lost"; executionRef?: string };
export type Evidence = "recorded" | "unconfirmed" | "withheld";

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
        else leaseRevoked = true;
      } catch {
        // An ambiguous renewal cannot extend the last confirmed lease.
      }
      if (lost()) return;
    }
  })();
  try {
    return await drive(deps, { jobId, runRef, owner }, leaseDeadline, emit);
  } finally {
    stopRenew.stop = true;
    await renewer.catch(() => undefined);
  }
}

async function drive(
  deps: ControllerDeps,
  id: { jobId: string; runRef: string; owner: string },
  leaseDeadline: () => number | undefined,
  emit: (event: string, detail?: Record<string, unknown>) => void,
): Promise<Outcome> {
  const { settings, api, store } = deps;
  const { jobId, owner } = id;
  const lost = () => leaseDeadline() === undefined;
  if (lost()) return { outcome: "lease_lost" };
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
    if (settings.pipeline !== "local_fixture_noop")
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
    if (settings.pipeline !== "local_fixture_noop")
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
    if (settings.pipeline !== "local_fixture_noop")
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
      if (journal.singleProcess)
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
    return supervise(deps, id, journal, spawned.exited, leaseDeadline, emit);
  }

  // phase running | exited: adopt the known execution; never spawn.
  return supervise(deps, id, journal, undefined, leaseDeadline, emit);
}

async function supervise(
  deps: ControllerDeps,
  id: { jobId: string; owner: string; runRef: string },
  start: Journal,
  ownChild: Promise<Exit> | undefined,
  leaseDeadline: () => number | undefined,
  emit: (event: string, detail?: Record<string, unknown>) => void,
): Promise<Outcome> {
  const { settings, store } = deps;
  if (!start.singleProcess)
    return unknown(
      deps,
      id,
      "execution_isolation_unproven",
      start.executionRef,
    );
  let journal = start;
  let exit: Exit | undefined = journal.exit;
  const deadline = Date.parse(journal.executionDeadline);
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
      const state = inspect(journal);
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
    };
    store.write(journal);
    emit("child_exited", { exit: journal.exit });
  }

  // The verified fixture could not create child processes.
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
              : "adopted_single_process_exited",
            exitCode: String(journal.exit?.code ?? "null"),
            exitSignal: String(journal.exit?.signal ?? "null"),
            termination,
            recovery,
            proof: "seccomp_single_process_exited",
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
  // Intent exists; ambiguity is recorded for SA-27 repair. Never respawn, never evidence, never release.
  try {
    await deps.api.act(id.jobId, {
      action: "mark_submit_unknown",
      owner: id.owner,
    });
  } catch (error) {
    if (!(error instanceof AmbiguousApiError || error instanceof ApiRejection))
      throw error;
  }
  return executionRef
    ? { outcome: "needs_operator", reason, executionRef }
    : { outcome: "submit_unknown", reason };
}
