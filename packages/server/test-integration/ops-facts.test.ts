import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  advanceResult,
  closeOutputs,
  submitCandidate,
} from "../src/acceptance/service.js";
import {
  admitNextJob,
  claimControllerLease,
  recordExecutionEvidence,
  recordWorkerSubmissionIntent,
} from "../src/jobs/service.js";
import { flagUncertain } from "../src/jobs/recovery.js";
import {
  buildReceipt,
  estimateRun,
  evaluateAlerts,
  loadJobFacts,
  OpsInputError,
} from "../src/ops/index.js";
import {
  acceptanceDatabase,
  acceptanceDeps,
  candidateBody,
  checksSummary,
  manifestFor,
  runningJob,
  uploadClip,
  uploadOutput,
} from "./acceptance-harness.js";
import { writeArtifact } from "./harness.js";
import { depsFor, jobsDatabase, owner, queuedJob } from "./jobs-harness.js";

// SA-45 durable fact loader against REAL restricted-role Postgres (+ real local object
// storage for the accepted/failed acceptance paths). Not Render, Modal or device qualification.
const evidenceOut: Record<string, unknown> = {};
after(async () => {
  await writeArtifact("ops-facts.json", evidenceOut);
});
const WEEK = 7 * 86_400;

async function reapEvidence(
  db: Awaited<ReturnType<typeof acceptanceDatabase>>,
  jobId: string,
) {
  const ref = (
    await db.owner.query("SELECT execution_call_id FROM jobs WHERE id = $1", [
      jobId,
    ])
  ).rows[0].execution_call_id as string;
  await recordExecutionEvidence(
    { pool: db.app },
    {
      jobId,
      recordedBy: "ops-test",
      evidence: { kind: "local_child_reaped", executionRef: ref },
    },
  );
}

test("accepted, failed and queued jobs report real sealed bytes and accepted QC only", async () => {
  const db = await acceptanceDatabase();
  const { transport, accept } = await acceptanceDeps(db);
  try {
    // Accepted success.
    const ok = await runningJob(db);
    const clips = [await uploadClip(transport, ok, 0)];
    const bytes = await manifestFor(db, ok, clips, () => {});
    const manifest = await uploadOutput(
      transport,
      ok,
      "result-manifest.json",
      "result_manifest",
      bytes,
    );
    const doc = JSON.parse(bytes.toString()) as Record<string, any>;
    await closeOutputs(accept, {
      jobId: ok.jobId,
      invocationNonce: ok.nonce,
      outcome: "succeeded",
    });
    await submitCandidate(accept, candidateBody(ok, manifest, doc));
    await advanceResult(accept, ok.jobId);
    await reapEvidence(db, ok.jobId);
    await advanceResult(accept, ok.jobId);

    // Failed worker report.
    const bad = await runningJob(db);
    const failBytes = await manifestFor(db, bad, [], (d) => {
      d.verified_sources = [];
      d.attestation.source_eof_verified = false;
      d.outputs = [];
      d.clips = [];
      d.checks = [
        {
          code: "worker_failed",
          status: "fail",
          message: "boom",
          rule_revision: "sa31-export-2",
          measurements: {},
        },
      ];
    });
    const failManifest = await uploadOutput(
      transport,
      bad,
      "result-manifest.json",
      "result_manifest",
      failBytes,
    );
    await closeOutputs(accept, {
      jobId: bad.jobId,
      invocationNonce: bad.nonce,
      outcome: "failed",
    });
    await submitCandidate(accept, {
      schemaVersion: 1,
      jobId: bad.jobId,
      invocationNonce: bad.nonce,
      manifestFileId: failManifest.fileId,
      manifestSha256: failManifest.sha,
      summary: {
        outcome: "failed",
        clipCount: 0,
        checks: { pass: 0, warn: 0, fail: 1, measured: 0, notEvaluated: 0 },
        errorCode: "worker_failed",
      },
    } as never);
    await advanceResult(accept, bad.jobId);
    await reapEvidence(db, bad.jobId);
    await advanceResult(accept, bad.jobId);

    // Queued (never admitted).
    const queued = await queuedJob(db);

    const loaded = await loadJobFacts(db.app, { sinceSeconds: WEEK });
    assert.equal(loaded.unreadable, 0);
    const by = new Map(loaded.jobs.map((j) => [j.jobId, j]));
    const a = by.get(ok.jobId)!;
    const f = by.get(bad.jobId)!;
    const q = by.get(queued.jobId)!;
    for (const j of [a, f, q]) assert.equal(j.provenance, "restricted_db_read");
    assert.equal(a.state, "succeeded");
    assert.equal(f.state, "failed");
    assert.equal(f.errorCode, "worker_failed");
    assert.equal(q.state, "queued");

    // Sealed bytes straight from the database, by basis.
    const dbBytes = async (jobId: string) =>
      (
        await db.owner.query(
          `SELECT CASE WHEN f.role = 'viewer_rrd' THEN 'rrd' ELSE 'output' END AS bucket,
                  sum(f.size_bytes)::bigint::text AS declared
           FROM files f WHERE f.job_id = $1 AND f.purpose = 'output' GROUP BY 1`,
          [jobId],
        )
      ).rows as { bucket: string; declared: string }[];
    for (const row of await dbBytes(ok.jobId))
      assert.equal(
        a.bytes[row.bucket as "output" | "rrd"]?.declared,
        Number(row.declared),
        row.bucket,
      );
    assert.equal(a.bytes.output?.verified, a.bytes.output?.declared);
    assert.equal(a.bytes.source?.declared, 3000);
    assert.equal(a.bytes.source?.uploaded, 3000);
    assert.equal(a.bytes.failedOutput, undefined);
    // A failed closure's retained outputs are failedOutput, not output.
    assert.ok((f.bytes.failedOutput?.declared ?? 0) > 0);
    assert.equal(f.bytes.output, undefined);
    // Not yet uploaded: queued job has source bytes only; output stays unknown, never zero.
    assert.equal(q.bytes.output, undefined);
    assert.equal(q.bytes.source?.declared, 3000);

    // QC only from an accepted candidate; its counts are the stored summary.
    const cand = async (jobId: string) =>
      (
        await db.owner.query(
          "SELECT status, summary -> 'checks' AS checks FROM job_result_candidates WHERE job_id = $1",
          [jobId],
        )
      ).rows[0] as { status: string; checks: Record<string, number> };
    const okCand = await cand(ok.jobId);
    assert.equal(okCand.status, "accepted");
    assert.deepEqual(a.qc, checksSummary(doc));
    const failCand = await cand(bad.jobId);
    if (failCand.status === "accepted") assert.deepEqual(f.qc, failCand.checks);
    else assert.equal(f.qc, undefined);
    assert.equal(q.qc, undefined);

    // Receipts: no worker line exists, so worker facts stay unknown while durable facts are real.
    const receipts = loaded.jobs.map((j) => buildReceipt(j));
    const r = receipts.find((x) => x.jobId === ok.jobId)!;
    assert.deepEqual(r.worker.wallSeconds, { status: "unknown" });
    assert.equal(r.provenance, "restricted_db_read");
    assert.equal(
      r.bytes.source.verified.status,
      a.bytes.source?.verified === undefined ? "unknown" : "measured",
    );
    assert.equal(r.qc.status, "measured");
    const costs = new Map(receipts.map((x) => [x.jobId, estimateRun(x)]));
    const alerts = evaluateAlerts(
      loaded.jobs,
      { queuedDelaySeconds: 3600, heartbeatStaleSeconds: 3600 },
      loaded.databaseNow,
      costs,
    );
    evidenceOut.acceptance = {
      jobs: loaded.jobs.map((j) => ({
        state: j.state,
        errorCode: j.errorCode,
        bytes: j.bytes,
        qc: j.qc ?? null,
      })),
      alerts: alerts.map((x) => ({ rule: x.rule, status: x.status })),
    };

    // The real CLI against the same restricted role (no credential in output).
    const dir = mkdtempSync(join(tmpdir(), "ops-db-"));
    try {
      const t = join(dir, "t.json");
      writeFileSync(
        t,
        JSON.stringify({
          queuedDelaySeconds: 3600,
          heartbeatStaleSeconds: 3600,
        }),
      );
      const run = spawnSync(
        process.execPath,
        [
          "--conditions=react-server",
          "--import",
          "tsx",
          "src/ops-report-cli.ts",
          "--from-db",
          "--thresholds",
          t,
        ],
        {
          cwd: join(import.meta.dirname, ".."),
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            OPS_REPORT_DATABASE_URL: db.appUrl,
            APP_ENV: "local",
          },
          timeout: 60_000,
        },
      );
      assert.equal(run.status, 0, run.stderr);
      const report = JSON.parse(run.stdout);
      assert.equal(report.factsSource, "restricted_db_read");
      assert.equal(report.receipts.length, 3);
      const secret = new URL(db.appUrl).password;
      if (secret)
        assert.equal(
          run.stdout.includes(secret) || run.stderr.includes(secret),
          false,
        );
      assert.equal(run.stdout.includes(new URL(db.appUrl).host), false);
      evidenceOut.cliReport = report;
      // The owner/migration credential is refused by the CLI and by the loader.
      const owned = spawnSync(
        process.execPath,
        [
          "--conditions=react-server",
          "--import",
          "tsx",
          "src/ops-report-cli.ts",
          "--from-db",
          "--thresholds",
          t,
        ],
        {
          cwd: join(import.meta.dirname, ".."),
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            OPS_REPORT_DATABASE_URL: db.ownerUrl,
            APP_ENV: "local",
          },
          timeout: 60_000,
        },
      );
      assert.equal(owned.status, 1);
      assert.match(owned.stderr, /privileged database role/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await assert.rejects(
      loadJobFacts(db.owner, { sinceSeconds: WEEK }),
      /privileged database role/,
    );
    // More matching jobs than the limit is an error, not a silent cut.
    await assert.rejects(
      loadJobFacts(db.app, { sinceSeconds: WEEK, limit: 2 }),
      OpsInputError,
    );
    // Snapshot writes nothing (read-only transaction): row counts unchanged.
    const before = (await db.owner.query("SELECT count(*)::int AS n FROM jobs"))
      .rows[0].n;
    await loadJobFacts(db.app, { sinceSeconds: WEEK });
    assert.equal(
      (await db.owner.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n,
      before,
    );
  } finally {
    await db.close();
  }
});

test("an uncertain spawn surfaces as submit_unknown with an alert; the loader does not touch the slot", async () => {
  const db = await jobsDatabase();
  try {
    const q = await queuedJob(db);
    const deps = depsFor(db);
    assert.equal((await admitNextJob(deps)).state, "admitted");
    const ctl = owner();
    await claimControllerLease(deps, {
      jobId: q.jobId,
      runRef: "run-1",
      owner: ctl,
    });
    await recordWorkerSubmissionIntent(deps, { jobId: q.jobId, owner: ctl });
    await db.owner.query(
      "UPDATE jobs SET controller_lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [q.jobId],
    );
    const due = {
      ...deps,
      config: {
        ...deps.config,
        repair: { dispatchWindowSeconds: 0, leaseGraceSeconds: 0 },
      },
    };
    assert.deepEqual((await flagUncertain(due, { limit: 5 })).unknown, [
      q.jobId,
    ]);
    const loaded = await loadJobFacts(db.app, { sinceSeconds: WEEK });
    const job = loaded.jobs.find((j) => j.jobId === q.jobId)!;
    assert.equal(job.state, "submit_unknown");
    assert.equal(job.provenance, "restricted_db_read");
    assert.ok(job.unknownAt !== undefined);
    const alerts = evaluateAlerts(
      loaded.jobs,
      { queuedDelaySeconds: 3600, heartbeatStaleSeconds: 3600 },
      loaded.databaseNow,
    );
    assert.deepEqual(
      alerts.map((a) => [a.rule, a.status]),
      [["stuck_or_uncertain", "triggered"]],
    );
    assert.equal(
      (
        await db.owner.query(
          "SELECT job_id FROM dispatch_admission WHERE slot = 1",
        )
      ).rows[0].job_id,
      q.jobId,
    );
    evidenceOut.uncertain = {
      state: job.state,
      alerts: alerts.map((a) => a.rule),
    };
  } finally {
    await db.close();
  }
});
