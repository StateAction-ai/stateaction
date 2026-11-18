import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, test } from "node:test";
import {
  failUndispatched,
  finalizeCancellations,
  flagUncertain,
  jobControlCapabilities,
  operatorGuidance,
  recoverySnapshot,
  retryJob,
  runRepair,
} from "../src/jobs/recovery.js";
import type { TaskStarter } from "../src/jobs/dispatch.js";
import {
  admitNextJob,
  claimControllerLease,
  claimWorker,
  recordExecutionEvidence,
  recordWorkerSubmissionIntent,
  requestJobCancel,
  type JobsDeps,
} from "../src/jobs/service.js";
import { TransportError } from "../src/transport/errors.js";
import { writeArtifact } from "./harness.js";
import {
  depsFor,
  jobRow,
  jobsDatabase,
  nonce,
  owner,
  queuedJob,
  slotHolder,
  type JobsTestDb,
} from "./jobs-harness.js";

// SA-27 recovery against real restricted-role Postgres. Not Render, Modal or device qualification.
const evidence: Record<string, unknown> = {};
const open: JobsTestDb[] = [];
const scenario = async () => {
  const db = await jobsDatabase();
  open.push(db);
  return db;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});
after(async () => {
  await writeArtifact("recovery.json", evidence);
});

const reason = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) =>
      e instanceof TransportError
        ? `${e.code}:${e.message.split(":")[0]}`
        : String(e),
  );
const due = (
  deps: JobsDeps,
  extra: Partial<NonNullable<JobsDeps["config"]["repair"]>> = {},
): JobsDeps => ({
  ...deps,
  config: {
    ...deps.config,
    repair: { dispatchWindowSeconds: 0, leaseGraceSeconds: 0, ...extra },
  },
});
const expireLease = (db: JobsTestDb, jobId: string) =>
  db.owner.query(
    "UPDATE jobs SET controller_lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [jobId],
  );
const starterOf = (
  calls: Array<{ jobId: string; dispatchKey: string }>,
  fail = false,
  delayMs = 0,
): TaskStarter => ({
  async start(input) {
    calls.push(input);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (fail) throw new Error("no acknowledgement");
    return { taskRunId: `run-${calls.length}` };
  },
});
async function admitted(db: JobsTestDb) {
  const q = await queuedJob(db);
  const deps = depsFor(db);
  assert.equal((await admitNextJob(deps)).state, "admitted");
  return { ...q, deps };
}
async function running(db: JobsTestDb) {
  const a = await admitted(db);
  const ctl = owner();
  await claimControllerLease(a.deps, {
    jobId: a.jobId,
    runRef: "run-1",
    owner: ctl,
  });
  const intent = await recordWorkerSubmissionIntent(a.deps, {
    jobId: a.jobId,
    owner: ctl,
  });
  if (intent.state !== "recorded") throw new Error("unreachable");
  const ref = `local-${randomUUID()}`;
  await claimWorker(a.deps, {
    jobId: a.jobId,
    bootstrapToken: intent.bootstrapToken,
    invocationNonce: nonce(),
    executor: { kind: "local", localExecutionRef: ref },
  });
  return { ...a, ctl, ref };
}
const ALL = new Set([
  "cancel",
  "check_cancellation",
  "retry",
  "reupload_guidance",
] as const);
const noAdmit = (deps: JobsDeps) => () => admitNextJob(deps);

test("lost dispatch: ambiguous start keeps the job pending with the same key; no starter starts nothing", async () => {
  const db = await scenario();
  const { jobId, deps } = await admitted(db);
  const none = await runRepair(deps, { recordedBy: "repair:t" }, noAdmit(deps));
  assert.equal(none.report.dispatch.available, false);
  assert.deepEqual(
    none.pending.map((p) => p.jobId),
    [jobId],
  );

  const calls: Array<{ jobId: string; dispatchKey: string }> = [];
  const failing = await runRepair(
    { ...deps, taskStarter: starterOf(calls, true) },
    { recordedBy: "repair:t" },
    noAdmit(deps),
  );
  assert.deepEqual(failing.report.dispatch.ambiguous, [jobId]);
  assert.deepEqual(
    failing.pending.map((p) => p.jobId),
    [jobId],
  );
  const ok = await runRepair(
    { ...deps, taskStarter: starterOf(calls) },
    { recordedBy: "repair:t" },
    noAdmit(deps),
  );
  assert.equal(ok.report.dispatch.started.length, 1);
  assert.deepEqual(
    calls.map((c) => c.dispatchKey),
    [`job:${jobId}`, `job:${jobId}`],
  );
  assert.equal((await jobRow(db, jobId)).state, "submitting");
  evidence.lostDispatch = { calls: calls.length, key: calls[0]!.dispatchKey };
});

test("duplicate concurrent repair passes start the task once", async () => {
  const db = await scenario();
  const { deps } = await admitted(db);
  const calls: Array<{ jobId: string; dispatchKey: string }> = [];
  const withStarter = { ...deps, taskStarter: starterOf(calls, false, 300) };
  const results = await Promise.all(
    [1, 2, 3].map(() =>
      runRepair(withStarter, { recordedBy: "repair:t" }, noAdmit(deps)),
    ),
  );
  assert.equal(calls.length, 1);
  assert.equal(results.filter((r) => r.report.ran).length, 1);
  evidence.duplicateRepair = { starts: calls.length };
});

test("dispatch budget stops new starts and leaves them pending", async () => {
  const db = await scenario();
  const { deps } = await admitted(db);
  const calls: Array<{ jobId: string; dispatchKey: string }> = [];
  const tight = due(deps, {
    wallBudgetMs: 500,
    dispatchWindowSeconds: 3600,
    leaseGraceSeconds: 60,
  });
  const r = await runRepair(
    { ...tight, taskStarter: starterOf(calls) },
    { recordedBy: "repair:t" },
    noAdmit(deps),
  );
  assert.equal(calls.length, 0);
  assert.equal(r.report.dispatch.skippedForBudget.length, 1);
  assert.equal(r.pending.length, 1);
});

test("exhausted controller and lost dispatch fail only provably never-submitted jobs, free the slot, then allow retry with a new job", async () => {
  const db = await scenario();
  const lost = await admitted(db);
  assert.deepEqual(
    await failUndispatched(due(lost.deps), {
      recordedBy: "repair:t",
      limit: 5,
    }),
    [lost.jobId],
  );
  const row = (
    await db.owner.query("SELECT state, error_code FROM jobs WHERE id = $1", [
      lost.jobId,
    ])
  ).rows[0];
  assert.equal(row.state, "failed");
  assert.equal(row.error_code, "dispatch_lost");
  assert.equal(await slotHolder(db), null);
  const retried = await retryJob(lost.deps, {
    jobId: lost.jobId,
    expectedState: "failed",
  });
  assert.notEqual(retried.jobId, lost.jobId);
  assert.equal(retried.replayed, false);
  assert.deepEqual(
    await retryJob(lost.deps, { jobId: lost.jobId, expectedState: "failed" }),
    { ...retried, replayed: true },
  );
  // Replay returns the same successor (asserted above); a stale caller on an old job is refused.

  // Exhausted: a controller ran (run ref recorded) but ended before submitting.
  const next = await admitNextJob(lost.deps);
  assert.equal(next.state, "admitted");
  const id = (next as { job: { jobId: string } }).job.jobId;
  await claimControllerLease(lost.deps, {
    jobId: id,
    runRef: "run-x",
    owner: owner(),
  });
  assert.deepEqual(
    await failUndispatched(due(lost.deps, { leaseGraceSeconds: 3600 }), {
      recordedBy: "repair:t",
      limit: 5,
    }),
    [],
  );
  await expireLease(db, id);
  assert.deepEqual(
    await failUndispatched(due(lost.deps), {
      recordedBy: "repair:t",
      limit: 5,
    }),
    [id],
  );
  assert.equal(
    (await db.owner.query("SELECT error_code FROM jobs WHERE id = $1", [id]))
      .rows[0].error_code,
    "controller_exhausted",
  );
  evidence.exhausted = {
    lostFailedAs: "dispatch_lost",
    exhaustedFailedAs: "controller_exhausted",
  };
});

test("uncertain spawn is never failed, resubmitted, retried or released; it surfaces as submit_unknown then needs_attention", async () => {
  const db = await scenario();
  const a = await admitted(db);
  const ctl = owner();
  await claimControllerLease(a.deps, {
    jobId: a.jobId,
    runRef: "run-1",
    owner: ctl,
  });
  assert.equal(
    (await recordWorkerSubmissionIntent(a.deps, { jobId: a.jobId, owner: ctl }))
      .state,
    "recorded",
  );
  await expireLease(db, a.jobId);
  const d = due(a.deps);
  assert.deepEqual(
    await failUndispatched(d, { recordedBy: "repair:t", limit: 5 }),
    [],
  );
  assert.deepEqual((await flagUncertain(d, { limit: 5 })).unknown, [a.jobId]);
  assert.equal((await jobRow(db, a.jobId)).state, "submit_unknown");
  assert.equal(await slotHolder(db), a.jobId);
  assert.deepEqual(
    await recordWorkerSubmissionIntent(a.deps, { jobId: a.jobId, owner: ctl }),
    { state: "already_recorded" },
    "no second bootstrap token can ever be issued",
  );
  assert.equal(
    await reason(
      retryJob(a.deps, { jobId: a.jobId, expectedState: "submit_unknown" }),
    ),
    "conflict:not_terminal",
  );
  const snap = await recoverySnapshot(db.app, a.jobId);
  assert.equal(operatorGuidance(snap).code, "unknown_spawn");
  assert.deepEqual(
    (
      await jobControlCapabilities(db.app, ALL).forJob({
        recordingId: a.recordingId,
        jobId: a.jobId,
        state: "submit_unknown",
      })
    ).map((x) => x.kind),
    ["cancel"],
  );

  evidence.unknownSpawn = { state: "submit_unknown", slotHeld: true };
});

test("cancel ordering: cancel_requested is not stopped; retry waits for exact evidence; stale requests cannot mutate", async () => {
  const db = await scenario();
  const r = await running(db);
  assert.equal(
    await reason(
      requestJobCancel(r.deps, r.jobId, {
        expectedState: "submitting",
        requireCurrent: true,
      }),
    ),
    "conflict:stale_state",
  );
  assert.deepEqual(
    await requestJobCancel(r.deps, r.jobId, {
      expectedState: "running",
      requireCurrent: true,
    }),
    { state: "cancel_requested" },
  );
  assert.deepEqual(
    await finalizeCancellations(r.deps, { recordedBy: "repair:t", limit: 5 }),
    [],
  );
  assert.equal((await jobRow(db, r.jobId)).state, "cancel_requested");
  assert.equal(await slotHolder(db), r.jobId);
  assert.equal(
    await reason(
      retryJob(r.deps, { jobId: r.jobId, expectedState: "cancel_requested" }),
    ),
    "conflict:not_terminal",
  );
  assert.deepEqual(
    (
      await jobControlCapabilities(db.app, ALL).forJob({
        recordingId: r.recordingId,
        jobId: r.jobId,
        state: "cancel_requested",
      })
    ).map((x) => x.kind),
    ["check_cancellation"],
  );

  await recordExecutionEvidence(r.deps, {
    jobId: r.jobId,
    recordedBy: "ctl",
    evidence: { kind: "local_child_reaped", executionRef: r.ref },
  });
  assert.equal(
    await slotHolder(db),
    r.jobId,
    "evidence alone does not free the slot",
  );
  assert.deepEqual(
    await finalizeCancellations(r.deps, { recordedBy: "repair:t", limit: 5 }),
    [r.jobId],
  );
  assert.equal(await slotHolder(db), null);
  const retry = await retryJob(r.deps, {
    jobId: r.jobId,
    expectedState: "cancelled",
  });
  assert.notEqual(retry.jobId, r.jobId);
  assert.equal(
    await reason(requestJobCancel(r.deps, r.jobId, { requireCurrent: true })),
    "conflict:stale_current_job",
  );
  const cur = (
    await db.owner.query(
      "SELECT current_job_id FROM recordings WHERE id = $1",
      [r.recordingId],
    )
  ).rows[0];
  assert.equal(cur.current_job_id, retry.jobId);
  evidence.cancelRetry = {
    newJob: retry.jobId !== r.jobId,
    outputPrefix: `jobs/${retry.jobId}/outputs/`,
  };
});

test("cancel before any submission completes only through database-verified pre-submission evidence", async () => {
  const db = await scenario();
  const a = await admitted(db);
  await requestJobCancel(a.deps, a.jobId, {
    expectedState: "submitting",
    requireCurrent: true,
  });
  assert.deepEqual(
    await finalizeCancellations(a.deps, { recordedBy: "repair:t", limit: 5 }),
    [a.jobId],
  );
  assert.equal((await jobRow(db, a.jobId)).state, "cancelled");
  assert.equal(await slotHolder(db), null);
});

test("a failed source hash requests corrected source, not a same-bytes retry", async () => {
  const db = await scenario();
  const a = await admitted(db);
  await db.owner.query(
    "UPDATE jobs SET state = 'failed', error_code = 'source_sha_mismatch', finished_at = now() WHERE id = $1",
    [a.jobId],
  );
  assert.equal(
    await slotHolder(db),
    a.jobId,
    "terminal state alone never frees the slot",
  );
  assert.equal(
    await reason(retryJob(a.deps, { jobId: a.jobId, expectedState: "failed" })),
    "conflict:source_reupload_required",
  );
  await recordExecutionEvidence(a.deps, {
    jobId: a.jobId,
    recordedBy: "ctl",
    evidence: { kind: "pre_submission_rejected" },
  });
  assert.equal(await slotHolder(db), null);
  assert.equal(
    await reason(retryJob(a.deps, { jobId: a.jobId, expectedState: "failed" })),
    "conflict:source_reupload_required",
  );
  const snap = await recoverySnapshot(db.app, a.jobId);
  assert.equal(operatorGuidance(snap).code, "reupload_required");
  assert.deepEqual(
    (
      await jobControlCapabilities(db.app, ALL).forJob({
        recordingId: a.recordingId,
        jobId: a.jobId,
        state: "failed",
      })
    ).map((x) => x.kind),
    ["reupload_guidance"],
  );
});

test("retry of a failed job without recorded termination is refused", async () => {
  const db = await scenario();
  const a = await admitted(db);
  await db.owner.query(
    "UPDATE jobs SET state = 'failed', error_code = 'worker_failed', finished_at = now() WHERE id = $1",
    [a.jobId],
  );
  assert.equal(
    await reason(retryJob(a.deps, { jobId: a.jobId, expectedState: "failed" })),
    "conflict:termination_unproven",
  );
  assert.equal(
    operatorGuidance(await recoverySnapshot(db.app, a.jobId)).code,
    "retry_blocked_termination_unproven",
  );
});

test("a controller lost past the immutable deadline without evidence becomes needs_attention and keeps the slot", async () => {
  const db = await scenario();
  const q = await queuedJob(db);
  const base = depsFor(db);
  const deps = {
    ...base,
    config: { ...base.config, executionDeadlineSeconds: 2 },
  };
  assert.equal((await admitNextJob(deps)).state, "admitted");
  const ctl = owner();
  await claimControllerLease(deps, {
    jobId: q.jobId,
    runRef: "run-1",
    owner: ctl,
  });
  await recordWorkerSubmissionIntent(deps, { jobId: q.jobId, owner: ctl });
  await new Promise((r) => setTimeout(r, 2200));
  await expireLease(db, q.jobId);
  const flagged = await flagUncertain(due(deps), { limit: 5 });
  assert.deepEqual(flagged.attention, [q.jobId]);
  assert.equal((await jobRow(db, q.jobId)).state, "needs_attention");
  assert.equal(await slotHolder(db), q.jobId);
  assert.equal(
    operatorGuidance(await recoverySnapshot(db.app, q.jobId)).code,
    "needs_operator",
  );
});

test("capabilities advertise nothing whose authenticated mutation is not wired", async () => {
  const db = await scenario();
  const a = await admitted(db);
  const none = await jobControlCapabilities(db.app).forJob({
    recordingId: a.recordingId,
    jobId: a.jobId,
    state: "submitting",
  });
  assert.deepEqual(none, []);
});

test("HTTP retry binds to the exact prior job, its terminal state and the request ID", async () => {
  const db = await scenario();
  const lost = await admitted(db);
  await failUndispatched(due(lost.deps), { recordedBy: "repair:t", limit: 5 });
  const requestId = randomUUID();
  const first = await retryJob(lost.deps, {
    jobId: lost.jobId,
    expectedState: "failed",
    newJobId: requestId,
  });
  assert.deepEqual(first, {
    jobId: requestId,
    previousJobId: lost.jobId,
    replayed: false,
  });
  // Lost response: the identical request replays and creates nothing.
  assert.deepEqual(
    await retryJob(lost.deps, {
      jobId: lost.jobId,
      expectedState: "failed",
      newJobId: requestId,
    }),
    { ...first, replayed: true },
  );
  const jobsFor = async () =>
    Number(
      (
        await db.owner.query(
          "SELECT count(*) n FROM jobs WHERE recording_id = $1",
          [lost.recordingId],
        )
      ).rows[0].n,
    );
  assert.equal(await jobsFor(), 2);
  // Changed body: a different expected state conflicts, even for the same ID.
  assert.equal(
    await reason(
      retryJob(lost.deps, {
        jobId: lost.jobId,
        expectedState: "cancelled",
        newJobId: requestId,
      }),
    ),
    "conflict:stale_state",
  );
  // A new request ID against an already-retried prior job conflicts.
  assert.equal(
    await reason(
      retryJob(lost.deps, {
        jobId: lost.jobId,
        expectedState: "failed",
        newJobId: randomUUID(),
      }),
    ),
    "conflict:already_retried",
  );
  // The request ID cannot be reused as the identity of any other job.
  assert.equal(
    await reason(
      retryJob(lost.deps, {
        jobId: requestId,
        expectedState: "queued",
        newJobId: requestId,
      }),
    ),
    "conflict:request_id_in_use",
  );
  assert.equal(await jobsFor(), 2, "no second job was ever created");
});

test("time already spent before the dispatch step (slow result repair) consumes the soft budget; nothing starts blindly", async () => {
  const db = await scenario();
  const { jobId, deps } = await admitted(db);
  const calls: Array<{ jobId: string; dispatchKey: string }> = [];
  const r = await runRepair(
    { ...deps, taskStarter: starterOf(calls) },
    { recordedBy: "repair:t", startedAt: Date.now() - 45_000 },
    noAdmit(deps),
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(r.report.dispatch.skippedForBudget, [jobId]);
  assert.deepEqual(
    r.pending.map((p) => p.jobId),
    [jobId],
  );
  assert.equal((await jobRow(db, jobId)).state, "submitting");
});

test("a blocked recording row yields a bounded retryable result, and the repair advisory lock is still released", async () => {
  const db = await scenario();
  const a = await admitted(db);
  await requestJobCancel(a.deps, a.jobId, { expectedState: "submitting" });
  const blocker = await db.owner.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT 1 FROM recordings WHERE id = $1 FOR UPDATE", [
      a.recordingId,
    ]);
    const started = Date.now();
    assert.equal(
      await reason(
        retryJob(a.deps, { jobId: a.jobId, expectedState: "cancel_requested" }),
      ),
      "provider_unavailable:busy",
    );
    assert.ok(Date.now() - started < 15_000, "lock wait is finite");
    // The repair pass fails with the same retryable result instead of hanging...
    assert.equal(
      await reason(
        runRepair(a.deps, { recordedBy: "repair:t" }, noAdmit(a.deps)),
      ),
      "provider_unavailable:busy",
    );
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
  }
  // ...and releases its advisory lock, so the next pass runs and finishes the cancel.
  const next = await runRepair(
    a.deps,
    { recordedBy: "repair:t" },
    noAdmit(a.deps),
  );
  assert.equal(next.report.ran, true);
  assert.deepEqual(next.report.cancelled, [a.jobId]);
});
