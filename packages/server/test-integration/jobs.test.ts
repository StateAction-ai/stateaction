import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, test } from "node:test";
import { validateValue } from "@stateaction/contracts";
import { hashServiceToken } from "../src/auth/service.js";
import {
  BootstrapCapabilityStore,
  ControllerCapabilityStore,
  issueControllerCapability,
} from "../src/jobs/credentials.js";
import { assertJobCurrent } from "../src/jobs/current.js";
import {
  admitNextJob,
  claimControllerLease,
  claimWorker,
  getJobStatus,
  markSubmissionUnknown,
  recordExecutionEvidence,
  recordExecutionRef,
  recordHeartbeat,
  recordWorkerSubmissionIntent,
  refreshInputReadUrl,
  renewControllerLease,
  requestJobCancel,
  type ClaimGrant,
} from "../src/jobs/service.js";
import { TransportError } from "../src/transport/errors.js";
import { JobCapabilityStore } from "../src/transport/runtime.js";
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

const evidence: Record<string, unknown> = {};
const open: JobsTestDb[] = [];
const scenario = async () => {
  const db = await jobsDatabase();
  open.push(db);
  return db;
};
// The shared bounded Postgres has few connection slots: release each
// scenario's pools as soon as its test ends.
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});
after(async () => {
  await writeArtifact("jobs.json", evidence);
});

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) =>
      error instanceof TransportError
        ? error.code
        : ((error as { code?: string }).code ?? `unexpected:${String(error)}`),
  );

/** Admits, leases, records intent and returns the one-time bootstrap token. */
async function submitted(db: JobsTestDb) {
  const { jobId, recordingId } = await queuedJob(db);
  const deps = depsFor(db);
  const admitted = await admitNextJob(deps);
  assert.equal(admitted.state, "admitted");
  const ctl = owner();
  const lease = await claimControllerLease(deps, {
    jobId,
    runRef: "run-1",
    owner: ctl,
  });
  assert.equal(lease.granted, true);
  const intent = await recordWorkerSubmissionIntent(deps, {
    jobId,
    owner: ctl,
  });
  assert.equal(intent.state, "recorded");
  if (intent.state !== "recorded") throw new Error("unreachable");
  return { deps, jobId, recordingId, ctl, bootstrap: intent.bootstrapToken };
}
const claimInput = (
  jobId: string,
  bootstrapToken: string,
  ref = `local-${randomUUID()}`,
) => ({
  jobId,
  bootstrapToken,
  invocationNonce: nonce(),
  executor: { kind: "local" as const, localExecutionRef: ref },
});

test("concurrent admissions across connections admit exactly one job; queued jobs hold nothing", async () => {
  const db = await scenario();
  const deps = depsFor(db);
  const jobs = [await queuedJob(db), await queuedJob(db), await queuedJob(db)];
  const results = await Promise.all(
    Array.from({ length: 8 }, () => admitNextJob(deps)),
  );
  const admitted = results.filter((r) => r.state === "admitted");
  assert.equal(admitted.length, 1, "exactly one admission wins the slot");
  const winner = (
    admitted[0] as { job: { jobId: string; dispatchKey: string } }
  ).job;
  assert.equal(winner.dispatchKey, `job:${winner.jobId}`);
  assert.equal(await slotHolder(db), winner.jobId);
  const states = await db.owner.query(
    "SELECT id, state, admitted_at, controller_lease_owner FROM jobs",
  );
  assert.equal(states.rows.filter((r) => r.state === "submitting").length, 1);
  for (const r of states.rows.filter((x) => x.state === "queued")) {
    assert.equal(r.admitted_at, null);
    assert.equal(r.controller_lease_owner, null);
  }
  const inputs = await db.owner.query(
    "SELECT job_id, task_input_sha256 FROM job_inputs",
  );
  assert.deepEqual(
    inputs.rows.map((r) => r.job_id),
    [winner.jobId],
  );
  const row = await jobRow(db, winner.jobId);
  assert.ok(row.execution_deadline, "absolute deadline persisted at admission");
  assert.equal((await admitNextJob(deps)).state, "slot_busy");
  assert.equal(jobs.length, 3);
  evidence.concurrentAdmission = {
    attempts: 8,
    admitted: 1,
    holder: winner.jobId,
  };
});

test("the slot is released only by terminal state AND terminal execution evidence", async () => {
  const db = await scenario();
  const { deps, jobId, ctl } = await submitted(db);
  const second = await queuedJob(db);
  // Cancel blocks new work at once but the physical call may still be live.
  assert.deepEqual(await requestJobCancel(deps, jobId), {
    state: "cancel_requested",
  });
  // No evidence names an execution yet (unknown submission): nothing can release.
  assert.equal(
    await code(
      recordExecutionEvidence(deps, {
        jobId,
        recordedBy: "op",
        evidence: { kind: "local_child_reaped", executionRef: "other" },
      }),
    ),
    "conflict",
  );
  assert.equal(
    await code(
      recordExecutionEvidence(deps, {
        jobId,
        recordedBy: "op",
        evidence: { kind: "pre_submission_rejected" },
      }),
    ),
    "conflict",
    "a job with submission intent can never be released as never submitted",
  );
  // Terminal business state alone keeps the slot.
  await recordExecutionRef(deps, {
    jobId,
    owner: ctl,
    executor: { kind: "local", localExecutionRef: "child-1" },
  });
  await db.owner.query(
    "UPDATE jobs SET state = 'cancelled', finished_at = now() WHERE id = $1",
    [jobId],
  );
  assert.equal(await slotHolder(db), jobId);
  assert.equal((await admitNextJob(deps)).state, "slot_busy");
  // Direct slot release without evidence is rejected by the database.
  assert.equal(
    await code(
      db.app.query(
        "UPDATE dispatch_admission SET job_id = NULL, admitted_at = NULL WHERE slot = 1",
      ),
    ),
    "SAC04",
  );
  // The exact terminal execution evidence completes both conditions.
  assert.equal(
    await code(
      recordExecutionEvidence(deps, {
        jobId,
        recordedBy: "op",
        evidence: { kind: "local_child_reaped", executionRef: "wrong" },
      }),
    ),
    "conflict",
  );
  assert.equal(await slotHolder(db), jobId);
  const done = await recordExecutionEvidence(deps, {
    jobId,
    recordedBy: "op",
    evidence: { kind: "local_child_reaped", executionRef: "child-1" },
  });
  assert.equal(done.slotReleased, true, "both conditions now hold");
  assert.equal(await slotHolder(db), null);
  const next = await admitNextJob(deps);
  assert.equal(next.state, "admitted");
  assert.equal((next as { job: { jobId: string } }).job.jobId, second.jobId);
  evidence.slotRelease = { released: true };
});

test("evidence recorded before the business state is terminal keeps the slot until acceptance/failure", async () => {
  const db = await scenario();
  const { deps, jobId, ctl, bootstrap } = await submitted(db);
  await claimWorker(deps, claimInput(jobId, bootstrap, "child-9"));
  const ref = (await jobRow(db, jobId)).execution_call_id as string;
  await db.owner.query(
    "UPDATE jobs SET state = 'result_pending' WHERE id = $1",
    [jobId],
  );
  const r = await recordExecutionEvidence(deps, {
    jobId,
    recordedBy: "ctl",
    evidence: { kind: "local_child_reaped", executionRef: ref },
  });
  assert.equal(r.slotReleased, false);
  assert.equal(await slotHolder(db), jobId);
  await db.owner.query(
    "UPDATE jobs SET state = 'failed', finished_at = now() WHERE id = $1",
    [jobId],
  );
  assert.equal(await slotHolder(db), null);
  assert.ok(ctl);
});

test("a never-submitted rejection fails the job and frees the slot", async () => {
  const db = await scenario();
  const { jobId } = await queuedJob(db);
  const deps = depsFor(db);
  await admitNextJob(deps);
  const r = await recordExecutionEvidence(deps, {
    jobId,
    recordedBy: "ctl",
    evidence: { kind: "pre_submission_rejected", detail: { status: 400 } },
  });
  assert.equal(r.slotReleased, true);
  assert.equal((await jobRow(db, jobId)).state, "failed");
});

test("controller leases: one live owner, duplicate runs exit, lease expiry never frees or resubmits", async () => {
  const db = await scenario();
  const { deps, jobId, ctl } = await submitted(db);
  const other = await claimControllerLease(deps, {
    jobId,
    runRef: "run-1",
    owner: owner(2),
  });
  assert.deepEqual(other, { granted: false, reason: "live_owner" });
  const dup = await claimControllerLease(deps, {
    jobId,
    runRef: "run-2",
    owner: owner(3),
  });
  assert.deepEqual(dup, { granted: false, reason: "different_run" });
  assert.equal(
    (await renewControllerLease(deps, { jobId, owner: ctl })).renewed,
    true,
  );
  // Intent exists exactly once; no second bootstrap token is ever minted.
  assert.deepEqual(
    await recordWorkerSubmissionIntent(deps, { jobId, owner: ctl }),
    { state: "already_recorded" },
  );
  // Unknown submission keeps evidence and the slot.
  assert.deepEqual(await markSubmissionUnknown(deps, { jobId, owner: ctl }), {
    state: "submit_unknown",
  });
  await db.owner.query(
    "UPDATE jobs SET controller_lease_expires_at = now() - interval '1 hour' WHERE id = $1",
    [jobId],
  );
  assert.equal(
    await slotHolder(db),
    jobId,
    "lease expiry does not free admission",
  );
  assert.equal(
    (await renewControllerLease(deps, { jobId, owner: ctl })).renewed,
    false,
  );
  const retry = await claimControllerLease(deps, {
    jobId,
    runRef: "run-1",
    owner: owner(4),
  });
  assert.equal(retry.granted, true, "same run may retake an expired lease");
  assert.deepEqual(
    await recordWorkerSubmissionIntent(deps, { jobId, owner: owner(4) }),
    { state: "already_recorded" },
  );
  const row = await db.owner.query(
    "SELECT submission_intent_at, bootstrap_token_sha256, unknown_at FROM jobs WHERE id = $1",
    [jobId],
  );
  assert.ok(
    row.rows[0].submission_intent_at &&
      row.rows[0].bootstrap_token_sha256 &&
      row.rows[0].unknown_at,
  );
});

test("duplicate physical workers: exactly one claim wins and only the winner receives signed URLs", async () => {
  const db = await scenario();
  const { deps, jobId, recordingId, bootstrap } = await submitted(db);
  assert.equal(db.signed.length, 0, "nothing signed before a claim wins");
  const attempts = Array.from({ length: 6 }, () =>
    claimWorker(deps, claimInput(jobId, bootstrap)),
  );
  const settled = await Promise.allSettled(attempts);
  const wins = settled.filter(
    (s) => s.status === "fulfilled",
  ) as PromiseFulfilledResult<ClaimGrant>[];
  assert.equal(wins.length, 1);
  assert.equal(
    settled.filter(
      (s) =>
        s.status === "rejected" &&
        (s.reason as TransportError).code === "conflict",
    ).length,
    5,
  );
  assert.equal(
    db.signed.length,
    3,
    "only the winning claim signed the three sealed inputs",
  );
  const grant = wins[0]!.value;
  assert.equal(validateValue("jobs.claim-grant.v1", grant).valid, true);
  const row = await jobRow(db, jobId);
  assert.equal(row.state, "running");
  assert.equal(row.invocation_nonce, grant.invocationNonce);
  const status = await db.owner.query(
    "SELECT status FROM recordings WHERE id = $1",
    [recordingId],
  );
  assert.equal(status.rows[0].status, "processing");
  // Replays of the same nonce/call, or the same bootstrap with a new worker, fail without reading.
  const before = db.signed.length;
  assert.equal(
    await code(
      claimWorker(deps, {
        ...claimInput(jobId, bootstrap),
        invocationNonce: grant.invocationNonce as string,
      }),
    ),
    "conflict",
  );
  assert.equal(
    await code(claimWorker(deps, claimInput(jobId, bootstrap))),
    "conflict",
  );
  assert.equal(db.signed.length, before);
  // The bootstrap capability no longer resolves; the running capability does.
  assert.equal(
    await new BootstrapCapabilityStore(db.app).findByTokenSha256(
      hashServiceToken(bootstrap),
    ),
    null,
  );
  const cap = (grant.capability as { token: string }).token;
  const store = new JobCapabilityStore(db.app, ["job:heartbeat"]);
  assert.equal(
    (await store.findByTokenSha256(hashServiceToken(cap)))?.jobId,
    jobId,
  );
  evidence.duplicateClaims = {
    attempts: 6,
    wins: 1,
    signedUrls: db.signed.length,
  };
});

test("mismatched backend or execution ID, bad bootstrap and expired deadlines refuse before reading", async () => {
  const db = await scenario();
  const { deps, jobId, ctl, bootstrap } = await submitted(db);
  await recordExecutionRef(deps, {
    jobId,
    owner: ctl,
    executor: { kind: "local", localExecutionRef: "child-A" },
  });
  assert.equal(
    await code(
      claimWorker(deps, {
        ...claimInput(jobId, bootstrap),
        executor: { kind: "modal", functionCallId: "fc-abc123" },
      }),
    ),
    "conflict",
  );
  assert.equal(
    await code(claimWorker(deps, claimInput(jobId, bootstrap, "child-B"))),
    "conflict",
  );
  assert.equal(
    await code(
      claimWorker(deps, claimInput(jobId, "sa_svc_" + "x".repeat(43))),
    ),
    "conflict",
  );
  await db.owner.query(
    "ALTER TABLE jobs DISABLE TRIGGER jobs_orchestration_guard",
  );
  await db.owner.query(
    "UPDATE jobs SET start_deadline = now() - interval '1 second' WHERE id = $1",
    [jobId],
  );
  await db.owner.query(
    "ALTER TABLE jobs ENABLE TRIGGER jobs_orchestration_guard",
  );
  assert.equal(
    await code(claimWorker(deps, claimInput(jobId, bootstrap, "child-A"))),
    "forbidden",
  );
  assert.equal(db.signed.length, 0);
});

test("heartbeats and reads need the current claim; cancel, stale pointer, revoked permission and deadline stop them", async () => {
  const db = await scenario();
  const { deps, jobId, recordingId, bootstrap } = await submitted(db);
  const grant = await claimWorker(deps, claimInput(jobId, bootstrap));
  const n = grant.invocationNonce as string;
  const files = (grant.inputs as { fileId: string }[]).map((f) => f.fileId);
  const before = (await jobRow(db, jobId)).execution_deadline;
  const hb = await recordHeartbeat(deps, {
    jobId,
    invocationNonce: n,
    phase: "decoding",
    processedFrames: "10",
    totalFrames: null,
  });
  assert.equal(
    hb.executionDeadline.getTime(),
    (before as Date).getTime(),
    "heartbeats never extend the hard deadline",
  );
  assert.equal(
    await code(
      recordHeartbeat(deps, {
        jobId,
        invocationNonce: nonce(),
        phase: "decoding",
      }),
    ),
    "forbidden",
  );
  assert.ok(
    (
      await refreshInputReadUrl(deps, { jobId, fileId: files[0]! })
    ).readUrl.startsWith("http"),
  );
  assert.equal(
    await code(refreshInputReadUrl(deps, { jobId, fileId: randomUUID() })),
    "not_found",
  );
  // Revoking the owner's processing permission stops reads at once.
  const reg = await db.owner.query(
    "SELECT ingest_permission_id FROM recording_registrations WHERE recording_id = $1",
    [recordingId],
  );
  await db.owner.query(
    "UPDATE ingest_permissions SET status = 'revoked', revoked_by = 'op', revoked_at = now() WHERE id = $1",
    [reg.rows[0].ingest_permission_id],
  );
  assert.equal(await code(assertJobCurrent(db.app, jobId)), "forbidden");
  assert.equal(
    await code(refreshInputReadUrl(deps, { jobId, fileId: files[0]! })),
    "forbidden",
  );
  assert.equal(
    await code(
      recordHeartbeat(deps, { jobId, invocationNonce: n, phase: "decoding" }),
    ),
    "forbidden",
  );
  evidence.revokedPermission = "forbidden";
});

test("cancel, replaced recording pointer and expired absolute deadline revoke worker authority", async () => {
  for (const mode of ["cancel", "pointer", "deadline"] as const) {
    const db = await scenario();
    const { deps, jobId, recordingId, bootstrap } = await submitted(db);
    const grant = await claimWorker(deps, claimInput(jobId, bootstrap));
    const n = grant.invocationNonce as string;
    assert.equal(await code(assertJobCurrent(db.app, jobId, n)), "ok");
    if (mode === "cancel") await requestJobCancel(deps, jobId);
    if (mode === "pointer")
      await db.owner.query(
        "UPDATE recordings SET current_job_id = NULL WHERE id = $1",
        [recordingId],
      );
    if (mode === "deadline") {
      await db.owner.query(
        "ALTER TABLE jobs DISABLE TRIGGER jobs_orchestration_guard",
      );
      await db.owner.query(
        "UPDATE jobs SET start_deadline = now() - interval '2 seconds', execution_deadline = now() - interval '1 second' WHERE id = $1",
        [jobId],
      );
      await db.owner.query(
        "ALTER TABLE jobs ENABLE TRIGGER jobs_orchestration_guard",
      );
    }
    assert.equal(
      await code(assertJobCurrent(db.app, jobId, n)),
      "forbidden",
      mode,
    );
    assert.equal(
      await code(
        recordHeartbeat(deps, { jobId, invocationNonce: n, phase: "sealing" }),
      ),
      "forbidden",
      mode,
    );
    assert.equal(
      await slotHolder(db),
      jobId,
      "stale/cancelled attempts still occupy the slot until evidence",
    );
  }
});

test("queued job cancel holds nothing; deadlines and identity are write-once at the database", async () => {
  const db = await scenario();
  const { jobId } = await queuedJob(db);
  const deps = depsFor(db);
  assert.deepEqual(await requestJobCancel(deps, jobId), { state: "cancelled" });
  assert.equal(await slotHolder(db), null);
  assert.equal((await admitNextJob(deps)).state, "idle");
  const s = await submitted(db);
  assert.equal(
    await code(
      db.app.query(
        "UPDATE jobs SET execution_deadline = execution_deadline + interval '1 hour' WHERE id = $1",
        [s.jobId],
      ),
    ),
    "SAC01",
  );
  assert.equal(
    await code(
      db.app.query("UPDATE jobs SET state = 'running' WHERE id = $1", [
        s.jobId,
      ]),
    ),
    "SAC04",
    "running requires a claim",
  );
  assert.equal(
    await code(
      db.owner.query(
        "UPDATE job_inputs SET code_revision = 'x' WHERE job_id = $1",
        [s.jobId],
      ),
    ),
    "SAC01",
  );
});

test("machine credentials: operator-issued, hashed, scoped and revocable; no human session path", async () => {
  const db = await scenario();
  const issued = await issueControllerCapability(db.owner, {
    kind: "workflow",
    scopes: ["jobs:status", "jobs:reconcile"],
    label: "test controller",
    ttlSeconds: 3600,
  });
  const store = new ControllerCapabilityStore(db.app);
  const found = await store.findByTokenSha256(hashServiceToken(issued.token));
  assert.equal(found?.kind, "workflow");
  assert.deepEqual([...found!.scopes], ["jobs:status", "jobs:reconcile"]);
  const stored = await db.owner.query(
    "SELECT token_sha256 FROM service_capabilities",
  );
  assert.ok(
    !JSON.stringify(stored.rows).includes(issued.token),
    "only the hash is stored",
  );
  // The web role can revoke but not mint.
  assert.equal(
    await code(
      db.app.query(
        "INSERT INTO service_capabilities (credential_id, token_sha256, kind, audience, scopes, label, expires_at) VALUES (gen_random_uuid(), repeat('a', 64), 'workflow', 'x', ARRAY['jobs:status'], 'x', now() + interval '1 hour')",
      ),
    ),
    "42501",
  );
  await db.app.query(
    "UPDATE service_capabilities SET revoked_at = now() WHERE credential_id = $1",
    [issued.credentialId],
  );
  assert.ok(
    (await store.findByTokenSha256(hashServiceToken(issued.token)))?.revokedAt,
  );
});

test("job status v2 projects the recorded execution identity and the immutable deadline (SA-42), set by the worker claim or the controller", async () => {
  const db = await scenario();
  const { deps, jobId, bootstrap } = await submitted(db);
  const before = await getJobStatus(deps, jobId);
  assert.equal(validateValue("jobs.job-status.v2", before).valid, true);
  assert.equal(before.executionBackend, "local");
  assert.equal(before.executionRef, null);
  assert.ok(before.executionDeadline);
  assert.ok(
    before.startDeadline,
    "the submission intent fixed the worker start deadline",
  );
  // A claim that names the reference first (the worker winning before the controller records).
  await claimWorker(deps, claimInput(jobId, bootstrap, "child-status"));
  const claimed = await getJobStatus(deps, jobId);
  assert.equal(validateValue("jobs.job-status.v2", claimed).valid, true);
  assert.equal(claimed.executionRef, "child-status");
  assert.equal(claimed.executionDeadline, before.executionDeadline);
  assert.equal(claimed.startDeadline, before.startDeadline);
});
