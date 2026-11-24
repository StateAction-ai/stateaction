import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { after, afterEach, test } from "node:test";
import {
  immutableModalAppName,
  requestSha256,
  segmentId,
  validateValue,
} from "@stateaction/contracts";
import { processRecordingTaskInputV2 } from "../src/admission/job-input.js";
import { appendReview } from "../src/catalog/catalog.js";
import { getClipReviewState } from "../src/datasets/review.js";
import { CatalogError } from "../src/catalog/errors.js";
import {
  advanceResult,
  closeOutputs,
  submitCandidate,
} from "../src/acceptance/service.js";
import { BootstrapCapabilityStore } from "../src/jobs/credentials.js";
import {
  admitNextJob,
  claimControllerLease,
  recordExecutionEvidence,
  recordWorkerSubmissionIntent,
  type JobsDeps,
} from "../src/jobs/service.js";
import {
  claimStage,
  getDagRun,
  getDagRunWithLineage,
  promoteRecipeEvidence,
  getPriorStages,
  issueStageClaim,
  readStageOutput,
  recordStageHeartbeat,
  recordStageRun,
  startParallelRecipe,
} from "../src/jobs/stages.js";
import { hashServiceToken } from "../src/auth/service.js";
import { TransportError } from "../src/transport/errors.js";
import { prepareStageRerun } from "../src/jobs/stage-rerun-preparation.js";
import { s3RerunCopy } from "../src/jobs/stage-rerun-storage.js";
import { confirmStageRerun, planStageRerun } from "../src/jobs/stage-reruns.js";
import { realS3, s3Config } from "./transport-harness.js";
import { retryJob } from "../src/jobs/recovery.js";

import {
  acceptanceDatabase,
  acceptanceDeps,
  candidateBody,
  manifestFor,
  runningJob,
  uploadClip,
  uploadOutput,
  type AcceptanceDb,
} from "./acceptance-harness.js";
import { createActors, writeArtifact } from "./harness.js";
import { JOBS_CONFIG, nonce, queuedJob } from "./jobs-harness.js";

/**
 * SA-88 migration 011 against the real restricted Postgres and real object
 * storage: recipe admission, per-stage claims, forward-only stage runs, the
 * stage-scoped output read, 0-clip annotation acceptance, the caption subset
 * rule and the unchanged clip path.
 */

const evidence: Record<string, unknown> = {};
const open: AcceptanceDb[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});
after(async () => {
  await writeArtifact("stage-runs.json", evidence);
});

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) =>
      error instanceof TransportError
        ? error.code
        : ((error as { code?: string }).code ?? `unexpected:${String(error)}`),
  );
import {
  MODULES,
  claimed,
  finish,
  json,
  segmentsDoc,
  jobFacts,
  receiptOf,
  recipe,
  recipeJob as recipeJobWith,
  runRecipe,
  seal,
} from "./recipe-harness.js";

const recipeJob = (over: Parameters<typeof recipeJobWith>[0] = {}) =>
  recipeJobWith(over, (db) => open.push(db));

// --------------------------------------------------------------------- tests

test("an over-12h recipe is rejected at admission and does not block the queue", async () => {
  const db = await acceptanceDatabase();
  open.push(db);
  const bad = await queuedJob(db);
  const good = await queuedJob(db);
  const over = recipe();
  for (const st of over.stages) st.resources.budgetSeconds = 15_000;
  const fine = recipe();
  const deps: JobsDeps = {
    pool: db.app,
    config: JOBS_CONFIG,
    presignRead: async (key, ttl) => `http://127.0.0.1:9/${key}?ttl=${ttl}`,
    taskInput: async (q, job) => {
      const v2 = (await processRecordingTaskInputV2(
        q as never,
        job.jobId,
      )) as unknown as Record<string, unknown>;
      const r = job.jobId === bad.jobId ? over : fine;
      return {
        ...v2,
        schemaVersion: 3,
        recipe: r,
        recipeSha256: requestSha256(r),
      };
    },
  };
  const result = await admitNextJob(deps);
  assert.equal(result.state, "admitted");
  if (result.state !== "admitted") return;
  assert.equal(result.job.jobId, good.jobId);
  assert.deepEqual(result.rejectedJobIds, [bad.jobId]);
  const row = (
    await db.owner.query(
      "SELECT state, error_code, finished_at FROM jobs WHERE id = $1",
      [bad.jobId],
    )
  ).rows[0];
  assert.equal(row.state, "cancelled");
  assert.equal(row.error_code, "recipe_deadline_exceeded");
  assert.ok(row.finished_at);
  const inputs = await db.owner.query(
    "SELECT 1 FROM job_inputs WHERE job_id = $1",
    [bad.jobId],
  );
  assert.equal(inputs.rowCount, 0);
  const dl = (
    await db.owner.query(
      "SELECT extract(epoch FROM execution_deadline - admitted_at)::int AS secs FROM jobs WHERE id = $1",
      [good.jobId],
    )
  ).rows[0];
  assert.equal(dl.secs, 3 * 600 + 1800);
});

test("clip review commits and replays on the selected result while a rerun is queued", async () => {
  const parent = await recipeJob();
  const result = await runRecipe(parent, undefined, {
    clip: { sourceStartNs: "0", sourceEndNs: "600000000" },
  });
  await seal(parent, result);
  assert.equal(
    (await advanceResult(parent.accept, parent.jobId))?.candidateStatus,
    "accepted",
  );

  const actor = parent.db.actors.staff;
  const deps = {
    pool: parent.db.app,
    reader: parent.accept.reader,
    backend: "local" as const,
  };
  const request = {
    parentJobId: parent.jobId,
    stage: "hand_pose",
    scope: "only",
  } as const;
  const { planSha256, plan } = await planStageRerun(
    deps,
    actor,
    parent.recordingId,
    request,
  );
  const child = randomUUID();
  await confirmStageRerun(deps, actor, parent.recordingId, {
    ...request,
    requestId: child,
    expectedPlanSha256: planSha256,
    expectedMaxGpuCostUsd: plan.maxGpuCostUsd,
    reason: "Queue a new run while the original remains selected",
  });
  assert.deepEqual(
    (
      await parent.db.app.query(
        "SELECT current_job_id, recording_selected_job(id) AS selected FROM recordings WHERE id = $1",
        [parent.recordingId],
      )
    ).rows[0],
    { current_job_id: child, selected: parent.jobId },
  );
  const clipId = result.doc.clips[0].clip_id;
  const before = await getClipReviewState(parent.db.app, {
    clipId,
    viewerUserId: actor,
  });
  assert.equal(before.capabilities.canReview, true);
  const review = {
    reviewId: randomUUID(),
    clipId,
    jobId: parent.jobId,
    reviewerUserId: actor,
    resultManifestSha256: before.resultManifestSha256,
    expectedRevision: before.review.revision,
    decision: "approved",
    taskLabel: "Inspect the fixture",
  } as const;
  assert.equal(
    (await appendReview(parent.db.app, review)).revision,
    before.review.revision + 1,
  );
  assert.equal((await appendReview(parent.db.app, review)).replayed, true);
});

test("a confirmed CPU rerun needs live spend authorization at its actual stage claim", async () => {
  const parent = await recipeJob({ maxJobCostUsd: "1.00" });
  await seal(parent, await runRecipe(parent));
  assert.equal(
    (await advanceResult(parent.accept, parent.jobId))?.candidateStatus,
    "accepted",
  );

  const authorization = randomUUID();
  const bindings = new Map([
    [
      MODULES.hand_pose,
      {
        functionId: "fu-fixture",
        definitionId: "fd-fixture",
        environment: "fixture",
        appName: immutableModalAppName(
          MODULES.hand_pose,
          "a".repeat(40),
          requestSha256({}),
        ),
        codeRevision: "a".repeat(40),
        paramsSha256: requestSha256({}),
        definitionSha256: "b".repeat(64),
        gpu: "none",
        maxBilledSeconds: 1000,
        maxContainers: 1,
        maxCpuMilli: 4000,
        maxMemoryMib: 8192,
        microUsdPerGpuSecond: 0,
        microUsdPerCpuSecond: 211,
      },
    ],
  ]);
  await parent.db.owner.query(
    `INSERT INTO rerun_spend_authorizations
       (id, environment, approval, recording_id, max_compute_cents, max_gpu_cents, expires_at)
     VALUES ($1, 'fixture', 'test CPU authorization', $2, 100, 0, now() + interval '1 hour')`,
    [authorization, parent.recordingId],
  );
  const actor = parent.db.actors.staff;
  const planDeps = {
    pool: parent.db.app,
    reader: parent.accept.reader,
    backend: "modal" as const,
    bindings,
  };
  const input = {
    parentJobId: parent.jobId,
    stage: "hand_pose",
    scope: "only",
  } as const;
  const { plan, planSha256 } = await planStageRerun(
    planDeps,
    actor,
    parent.recordingId,
    input,
  );
  assert.equal(plan.maxGpuCostUsd, "0.00");
  const jobId = randomUUID();
  const command = {
    ...input,
    requestId: jobId,
    expectedPlanSha256: planSha256,
    expectedMaxGpuCostUsd: plan.maxGpuCostUsd,
    reason: "Verify a CPU claim expires with its approval",
  };
  const excluded = {
    ...planDeps,
    production: true,
    publicVideoCanary: {
      ownerUserId: parent.db.actors.collector,
      clientRecordingId: randomUUID(),
      sourceSha256: "a".repeat(64),
    },
  };
  await assert.rejects(
    planStageRerun(excluded, actor, parent.recordingId, input),
    { code: "conflict", message: "rerun_outside_admission_scope" },
  );
  await assert.rejects(
    confirmStageRerun(excluded, actor, parent.recordingId, command),
    { code: "conflict", message: "rerun_outside_admission_scope" },
  );
  assert.deepEqual(
    (
      await parent.db.app.query(
        `SELECT r.current_job_id, recording_selected_job(r.id) AS selected,
            EXISTS (SELECT 1 FROM jobs WHERE id = $2) AS child,
            EXISTS (SELECT 1 FROM rerun_spend_reservations WHERE job_id = $2) AS reserved
     FROM recordings r WHERE r.id = $1`,
        [parent.recordingId, jobId],
      )
    ).rows[0],
    {
      current_job_id: parent.jobId,
      selected: parent.jobId,
      child: false,
      reserved: false,
    },
  );

  const results = await Promise.allSettled([
    confirmStageRerun(planDeps, actor, parent.recordingId, command),
    confirmStageRerun(planDeps, actor, parent.recordingId, {
      ...command,
      reason: "Conflicting request",
    }),
  ]);
  assert.equal(
    results.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  const refused = results.find((outcome) => outcome.status === "rejected");
  assert.ok(refused && refused.status === "rejected");
  assert.equal(refused.reason.message, "request_id_in_use");

  await assert.rejects(
    parent.db.owner.query(
      `INSERT INTO job_stage_reuse (job_id, stage, source_job_id, execution_job_id,
          state, receipt_sha256, fingerprint_sha256)
     VALUES ($1, 'segment', $2, $2, 'succeeded', repeat('a',64), repeat('b',64))`,
      [jobId, parent.jobId],
    ),
    {
      code: "SAC04",
      message: "rerun evidence differs from the original stage",
    },
  );
  const deps: JobsDeps = {
    ...parent.deps,
    config: { ...parent.deps.config, executionBackend: "modal" },
    acceptance: parent.accept,
    rerunCopy: s3RerunCopy(s3Config()),
  };
  const admitted = await admitNextJob(deps);
  assert.equal(admitted.state, "admitted");
  assert.equal(admitted.state === "admitted" && admitted.job.jobId, jobId);
  const owner = nonce();
  assert.equal(
    (
      await claimControllerLease(deps, {
        jobId,
        owner,
        runRef: "rerun-fixture",
      })
    ).granted,
    true,
  );
  assert.equal(await startParallelRecipe(parent.db.app, jobId, owner), true);
  let preparation = await prepareStageRerun(deps, jobId, owner);
  for (
    let attempt = 0;
    preparation.state === "copying" && attempt < 20;
    attempt++
  )
    preparation = await prepareStageRerun(deps, jobId, owner);
  assert.equal(preparation.state, "ready");
  await assert.rejects(
    parent.db.owner.query(
      `INSERT INTO job_rerun_copies (job_id, stage, source_file_id, source_job_id, original_file_id,
          original_job_id, file_id, slot, role, size_bytes, sha256)
     SELECT job_id, 'caption', source_file_id, source_job_id, original_file_id, original_job_id,
            gen_random_uuid(), slot, role, size_bytes, sha256
     FROM job_rerun_copies WHERE job_id = $1 AND slot = 'segments.json'`,
      [jobId],
    ),
    {
      code: "SAC04",
      message: "rerun copy requires a successful origin and its stage slot",
    },
  );

  const claim = { jobId, owner, stage: "hand_pose" } as const;
  await parent.db.owner.query(
    "UPDATE rerun_spend_authorizations SET expires_at = now() - interval '1 second' WHERE id = $1",
    [authorization],
  );
  assert.equal(await code(issueStageClaim(deps, claim)), "conflict");
  assert.equal(
    (
      await parent.db.owner.query(
        "SELECT 1 FROM job_stage_claims WHERE job_id = $1",
        [jobId],
      )
    ).rowCount,
    0,
  );
  const {
    rows: [approval],
  } = await parent.db.owner.query<{ expires_at: Date }>(
    "UPDATE rerun_spend_authorizations SET expires_at = now() + interval '1 minute', max_compute_cents = 1 WHERE id = $1 RETURNING expires_at",
    [authorization],
  );
  await assert.rejects(issueStageClaim(deps, claim), { code: "conflict" });
  assert.equal(
    (
      await parent.db.app.query(
        "SELECT 1 FROM job_stage_claims WHERE job_id = $1",
        [jobId],
      )
    ).rowCount,
    0,
  );
  await parent.db.owner.query(
    "UPDATE rerun_spend_authorizations SET max_compute_cents = 100 WHERE id = $1",
    [authorization],
  );
  const issued = await issueStageClaim(deps, claim);
  assert.equal(issued.state, "recorded");
  if (issued.state !== "recorded") return;
  assert.equal(issued.startDeadline.getTime(), approval!.expires_at.getTime());
  assert.deepEqual(
    (
      await parent.db.app.query(
        "SELECT start_deadline FROM jobs WHERE id = $1",
        [jobId],
      )
    ).rows[0],
    { start_deadline: approval!.expires_at },
  );
  await assert.rejects(
    parent.db.owner.query(
      "INSERT INTO rerun_spend_reconciliations (job_id, compute_cents, gpu_cents, metering_reference) VALUES ($1, 0, 0, 'premature reference')",
      [jobId],
    ),
    {
      code: "SAC04",
      message: "spend reconciliation needs exact terminal provider evidence",
    },
  );

  const callId = "fc-FixtureHand142";
  await claimStage(deps, {
    jobId,
    bootstrapToken: issued.bootstrapToken,
    invocationNonce: nonce(),
    executor: { kind: "modal", functionCallId: callId },
  });
  const stage = { ...claim, module: MODULES.hand_pose, callId };
  await recordStageRun(deps, { ...stage, state: "running" });
  await recordExecutionEvidence(deps, {
    jobId,
    recordedBy: "bound-receipt-test",
    evidence: { kind: "provider_call_terminal", executionRef: callId },
  });
  const worker = {
    ...receiptOf(parent, "hand_pose", []),
    jobId,
    status: "failed" as const,
    errorCode: "fixture_hand_failed",
  };
  const recorded = {
    ...stage,
    state: "failed" as const,
    errorCode: worker.errorCode,
  };
  await assert.rejects(recordStageRun(deps, { ...recorded, receipt: worker }), {
    code: "conflict",
    message: "hosted rerun receipt needs its confirmed deployment evidence",
  });
  const release = bindings.get(MODULES.hand_pose)!;
  const receipt = {
    ...worker,
    schemaVersion: 2 as const,
    providerBinding: {
      appName: release.appName,
      codeRevision: release.codeRevision,
      environment: release.environment,
      definitionId: release.definitionId,
      functionId: release.functionId,
      definitionSha256: release.definitionSha256,
      paramsSha256: release.paramsSha256,
      workerReceiptSha256: requestSha256(worker),
    },
  };
  await assert.rejects(
    recordStageRun(deps, {
      ...recorded,
      receipt: {
        ...receipt,
        providerBinding: {
          ...receipt.providerBinding,
          workerReceiptSha256: "0".repeat(64),
        },
      },
    }),
    {
      code: "invalid_request",
      message: "stage receipt provider evidence rejected",
    },
  );
  await assert.rejects(
    recordStageRun(deps, {
      ...recorded,
      receipt: {
        ...receipt,
        providerBinding: {
          ...receipt.providerBinding,
          definitionSha256: "0".repeat(64),
        },
      },
    }),
    {
      code: "conflict",
      message: "hosted rerun receipt needs its confirmed deployment evidence",
    },
  );
  assert.deepEqual(await recordStageRun(deps, { ...recorded, receipt }), {
    recorded: true,
  });
  assert.deepEqual(
    (
      await parent.db.app.query(
        "SELECT receipt, receipt_sha256 FROM job_stage_runs WHERE job_id = $1",
        [jobId],
      )
    ).rows[0],
    { receipt, receipt_sha256: requestSha256(receipt) },
  );
  await promoteRecipeEvidence(parent.db.app, jobId, "bound-receipt-test");
  await advanceResult(
    { ...parent.accept, config: { ...parent.accept.config, graceSeconds: 0 } },
    jobId,
  );
  const reconciliation = `INSERT INTO rerun_spend_reconciliations
    (job_id, compute_cents, gpu_cents, metering_reference)
    VALUES ($1, 7, 0, 'fixture:exact-provider-call')`;
  await assert.rejects(parent.db.app.query(reconciliation, [jobId]), {
    code: "42501",
  });
  await parent.db.owner.query(reconciliation, [jobId]);
  assert.deepEqual(
    (
      await parent.db.app.query(
        "SELECT gpu_cents::int, compute_cents::int FROM job_rerun_used_spend($1)",
        [authorization],
      )
    ).rows[0],
    { gpu_cents: 0, compute_cents: 7 },
  );
});

async function confirmLocalHandRerun(
  parent: Awaited<ReturnType<typeof recipeJob>>,
) {
  const deps = {
    pool: parent.db.app,
    reader: parent.accept.reader,
    backend: "local" as const,
  };
  const actor = parent.db.actors.staff;
  const input = {
    parentJobId: parent.jobId,
    stage: "hand_pose",
    scope: "only",
  } as const;
  const { plan, planSha256 } = await planStageRerun(
    deps,
    actor,
    parent.recordingId,
    input,
  );
  const command = {
    ...input,
    requestId: randomUUID(),
    expectedPlanSha256: planSha256,
    expectedMaxGpuCostUsd: "0.00",
    reason: "Verify original stage evidence",
  };
  await confirmStageRerun(deps, actor, parent.recordingId, command);
  return { plan, deps, actor, input, command };
}

async function startLocalHandRerun(
  parent: Awaited<ReturnType<typeof recipeJob>>,
  jobId: string,
  rerunCopy = s3RerunCopy(s3Config()),
) {
  const deps = { ...parent.deps, acceptance: parent.accept, rerunCopy };
  const admitted = await admitNextJob(deps);
  assert.equal(admitted.state === "admitted" && admitted.job.jobId, jobId);
  const owner = nonce();
  assert.equal(
    (
      await claimControllerLease(deps, {
        jobId,
        owner,
        runRef: "rerun-guard-test",
      })
    ).granted,
    true,
  );
  assert.equal(await startParallelRecipe(parent.db.app, jobId, owner), true);
  return { deps, owner };
}

async function prepareAllCopies(deps: JobsDeps, jobId: string, owner: string) {
  for (let step = 0; step < 40; step++) {
    const result = await prepareStageRerun(deps, jobId, owner);
    if (result.state !== "copying") return result;
  }
  throw new Error("Fixture reuse copy did not finish");
}

for (const location of ["source", "target", "lease"] as const) {
  test(`rerun copy refuses ${location === "lease" ? "a stale owner" : location + " corruption"}`, async (t) => {
    const parent = await recipeJob();
    await seal(parent, await runRecipe(parent));
    assert.equal(
      (await advanceResult(parent.accept, parent.jobId))?.candidateStatus,
      "accepted",
    );
    const { deps, actor, input, command } = await confirmLocalHandRerun(parent);
    const { requestId: jobId } = command;
    const config = s3Config();
    const client = realS3();
    t.after(() => client.destroy());
    const corrupt = (key: string, size: number) =>
      client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: Buffer.alloc(size, 0x21),
        }),
      );
    if (location === "source") {
      const {
        rows: [source],
      } = await parent.db.app.query<{ object_key: string; size: string }>(
        "SELECT object_key, size_bytes::text AS size FROM files WHERE job_id = $1 AND role = 'segments_json'",
        [parent.jobId],
      );
      await corrupt(source!.object_key, Number(source!.size));
      // The original remains selected, but a fresh plan must find invalid bytes
      // once the active child's preparation has settled below.
    }
    const copy = s3RerunCopy(config);
    let owner = "";
    const child = await startLocalHandRerun(
      parent,
      jobId,
      location === "source"
        ? copy
        : {
            ...copy,
            async advance(request, progress) {
              const next = await copy.advance(request, progress);
              if (!next.targetReady) return next;
              if (location === "target")
                await corrupt(request.target, request.size);
              else
                await parent.db.owner.query(
                  "UPDATE jobs SET controller_lease_expires_at = now() - interval '1 second' WHERE id = $1 AND controller_lease_owner = $2",
                  [jobId, owner],
                );
              return next;
            },
          },
    );
    owner = child.owner;
    if (location === "lease") {
      await assert.rejects(prepareAllCopies(child.deps, jobId, owner), {
        code: "conflict",
        message: "rerun preparation needs a current controller lease",
      });
    } else {
      assert.deepEqual(await prepareAllCopies(child.deps, jobId, owner), {
        state: "failed",
      });
      const {
        rows: [row],
      } = await parent.db.app.query(
        "SELECT state, error_code FROM jobs WHERE id = $1",
        [jobId],
      );
      assert.deepEqual(row, {
        state: "failed",
        error_code:
          location === "source" ? "reuse_unavailable" : "copy_digest_mismatch",
      });
      const replay = await confirmStageRerun(
        deps,
        actor,
        parent.recordingId,
        command,
      );
      assert.deepEqual(replay, {
        jobId,
        parentJobId: parent.jobId,
        replayed: true,
      });
      await assert.rejects(retryJob(deps, { jobId, expectedState: "failed" }), {
        message: /^rerun_confirmation_required:/,
      });
      if (location === "source") {
        await assert.rejects(
          planStageRerun(deps, actor, parent.recordingId, input),
          {
            message: "reuse_unavailable",
          },
        );
      }
    }
    assert.deepEqual(
      (
        await parent.db.app.query(
          `SELECT recording_selected_job($1) AS selected,
              (SELECT count(*)::int FROM job_stage_claims WHERE job_id = $2) AS claims
       ${location === "lease" ? ", (SELECT count(*)::int FROM files WHERE job_id = $2 AND state = 'completed') AS completed" : ""}`,
          [parent.recordingId, jobId],
        )
      ).rows[0],
      {
        selected: parent.jobId,
        claims: 0,
        ...(location === "lease" ? { completed: 0 } : {}),
      },
    );
  });
}

test("failed parent caption keeps its original failed receipt in a hand-pose-only child", async () => {
  const parent = await recipeJob();
  const segment = await claimed(parent, "segment");
  const segments = await uploadOutput(
    parent.transport,
    segment.job,
    "segments.json",
    "segments_json",
    json(segmentsDoc(parent)),
    { http: true },
  );
  await finish(parent, segment, [segments], { segments: 3, failed_windows: 1 });

  const caption = await claimed(parent, "caption");
  const facts = {
    jobId: parent.jobId,
    owner: parent.ctl,
    stage: "caption" as const,
    module: MODULES.caption,
    callId: caption.callId,
  };
  await recordStageRun(parent.deps, { ...facts, state: "running" });
  await recordExecutionEvidence(parent.deps, {
    jobId: parent.jobId,
    recordedBy: "guard-test",
    evidence: { kind: "local_child_reaped", executionRef: caption.callId },
  });
  const receipt = {
    ...receiptOf(parent, "caption", []),
    status: "failed" as const,
    errorCode: "fixture_caption_failed",
  };
  await recordStageRun(parent.deps, {
    ...facts,
    state: "failed",
    errorCode: receipt.errorCode,
    receipt,
  });
  await promoteRecipeEvidence(parent.db.app, parent.jobId, "guard-test");
  await advanceResult(
    { ...parent.accept, config: { ...parent.accept.config, graceSeconds: 0 } },
    parent.jobId,
  );
  assert.equal(
    (
      await parent.db.app.query("SELECT state FROM jobs WHERE id = $1", [
        parent.jobId,
      ])
    ).rows[0].state,
    "failed",
  );

  const { command, plan } = await confirmLocalHandRerun(parent);
  assert.equal(
    plan.reuse.find((entry) => entry.stage === "caption")?.state,
    "failed",
  );
  const { deps, owner } = await startLocalHandRerun(parent, command.requestId);
  assert.equal(
    (await prepareAllCopies(deps, command.requestId, owner)).state,
    "ready",
  );
  const dag = await getDagRunWithLineage(deps, command.requestId);
  const inherited = dag.reuse.find((entry) => entry.stage === "caption");
  assert.equal(inherited?.state, "failed");
  assert.equal(inherited?.errorCode, receipt.errorCode);
  assert.deepEqual(inherited?.receipt, receipt);
  assert.equal(inherited?.executionJobId, parent.jobId);
  assert.equal(
    dag.stages.find((entry) => entry.stage === "caption")?.callId,
    null,
  );
  assert.equal(
    (
      await parent.db.app.query(
        "SELECT 1 FROM job_stage_runs WHERE job_id = $1 AND stage = 'caption'",
        [command.requestId],
      )
    ).rowCount,
    0,
  );
});

test("an invalid task input is rejected at admission and does not block the queue", async () => {
  const db = await acceptanceDatabase();
  open.push(db);
  const bad = await queuedJob(db);
  const good = await queuedJob(db);
  const deps: JobsDeps = {
    pool: db.app,
    config: JOBS_CONFIG,
    presignRead: async (key, ttl) => `http://127.0.0.1:9/${key}?ttl=${ttl}`,
    taskInput: async (q, job) => {
      const v2 = (await processRecordingTaskInputV2(
        q as never,
        job.jobId,
      )) as unknown as Record<string, unknown>;
      // v3 without its recipe fails contract validation.
      return job.jobId === bad.jobId ? { ...v2, schemaVersion: 3 } : v2;
    },
  };
  const result = await admitNextJob(deps);
  assert.equal(result.state, "admitted");
  if (result.state !== "admitted") return;
  assert.equal(result.job.jobId, good.jobId);
  assert.deepEqual(result.rejectedJobIds, [bad.jobId]);
  const row = (
    await db.owner.query(
      "SELECT state, error_code, error_message, finished_at FROM jobs WHERE id = $1",
      [bad.jobId],
    )
  ).rows[0];
  assert.equal(row.state, "cancelled");
  assert.equal(row.error_code, "task_input_invalid");
  assert.match(row.error_message, /^task input rejected: /);
  assert.ok(row.finished_at);
  assert.equal(
    (
      await db.owner.query("SELECT 1 FROM job_inputs WHERE job_id = $1", [
        bad.jobId,
      ])
    ).rowCount,
    0,
  );
  const slot = await db.owner.query(
    "SELECT job_id FROM dispatch_admission WHERE slot = 1",
  );
  assert.equal(slot.rows[0].job_id, good.jobId);
  // The rejected job never comes back: the next call finds the slot busy.
  assert.equal((await admitNextJob(deps)).state, "slot_busy");
});

test("a task-input builder error cancels only that job and admission continues", async () => {
  const db = await acceptanceDatabase();
  open.push(db);
  const bad = await queuedJob(db);
  const good = await queuedJob(db);
  const deps: JobsDeps = {
    pool: db.app,
    config: JOBS_CONFIG,
    presignRead: async (key, ttl) => `http://127.0.0.1:9/${key}?ttl=${ttl}`,
    taskInput: async (q, job) => {
      if (job.jobId === bad.jobId)
        throw new CatalogError("not_found", "task input source is missing");
      return (await processRecordingTaskInputV2(
        q as never,
        job.jobId,
      )) as unknown as Record<string, unknown>;
    },
  };
  const result = await admitNextJob(deps);
  assert.equal(result.state, "admitted");
  if (result.state !== "admitted") return;
  assert.equal(result.job.jobId, good.jobId);
  assert.deepEqual(result.rejectedJobIds, [bad.jobId]);
  const row = (
    await db.owner.query(
      "SELECT state, error_code, error_message, finished_at FROM jobs WHERE id = $1",
      [bad.jobId],
    )
  ).rows[0];
  assert.equal(row.state, "cancelled");
  assert.equal(row.error_code, "task_input_build_failed");
  assert.match(row.error_message, /^task input build failed: /);
  assert.ok(row.finished_at);
  assert.equal(
    (
      await db.owner.query("SELECT 1 FROM job_inputs WHERE job_id = $1", [
        bad.jobId,
      ])
    ).rowCount,
    0,
  );
  const slot = await db.owner.query(
    "SELECT job_id FROM dispatch_admission WHERE slot = 1",
  );
  assert.equal(slot.rows[0].job_id, good.jobId);
  assert.equal((await admitNextJob(deps)).state, "slot_busy");
});

test("a database error inside the task-input builder is not turned into a cancelled job", async () => {
  const db = await acceptanceDatabase();
  open.push(db);
  const bad = await queuedJob(db);
  const deps: JobsDeps = {
    pool: db.app,
    config: JOBS_CONFIG,
    presignRead: async (key, ttl) => `http://127.0.0.1:9/${key}?ttl=${ttl}`,
    taskInput: async () => {
      throw Object.assign(new Error("connection terminated unexpectedly"), {
        code: "08006",
      });
    },
  };
  await assert.rejects(admitNextJob(deps), /connection terminated/);
  const row = (
    await db.owner.query("SELECT state, error_code FROM jobs WHERE id = $1", [
      bad.jobId,
    ])
  ).rows[0];
  assert.equal(row.state, "queued");
  assert.equal(row.error_code, null);
  const slot = await db.owner.query(
    "SELECT job_id FROM dispatch_admission WHERE slot = 1",
  );
  assert.equal(slot.rows[0].job_id, null);
});

test("concurrent admitters with one poisoned job cancel it once and admit exactly one good job", async () => {
  const db = await acceptanceDatabase();
  open.push(db);
  const bad = await queuedJob(db);
  const good = await queuedJob(db);
  const deps: JobsDeps = {
    pool: db.app,
    config: JOBS_CONFIG,
    presignRead: async (key, ttl) => `http://127.0.0.1:9/${key}?ttl=${ttl}`,
    taskInput: async (q, job) => {
      if (job.jobId === bad.jobId)
        throw new CatalogError("not_found", "task input source is missing");
      return (await processRecordingTaskInputV2(
        q as never,
        job.jobId,
      )) as unknown as Record<string, unknown>;
    },
  };
  const results = await Promise.all([
    admitNextJob(deps),
    admitNextJob(deps),
    admitNextJob(deps),
    admitNextJob(deps),
  ]);
  const admitted = results.filter((r) => r.state === "admitted");
  assert.equal(admitted.length, 1, "exactly one admitter wins the slot");
  assert.equal(
    results.filter((r) => r.state === "slot_busy").length,
    results.length - 1,
  );
  const winner = admitted[0];
  assert.equal(winner?.state, "admitted");
  if (winner?.state !== "admitted") return;
  assert.equal(winner.job.jobId, good.jobId);
  const rows = (
    await db.owner.query(
      "SELECT id, state, error_code FROM jobs WHERE id = ANY($1)",
      [[bad.jobId, good.jobId]],
    )
  ).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get(bad.jobId).state, "cancelled");
  assert.equal(byId.get(bad.jobId).error_code, "task_input_build_failed");
  assert.equal(byId.get(good.jobId).state, "submitting");
  const inputs = await db.owner.query("SELECT job_id FROM job_inputs");
  assert.deepEqual(
    inputs.rows.map((r) => r.job_id),
    [good.jobId],
  );
  const slot = await db.owner.query(
    "SELECT job_id FROM dispatch_admission WHERE slot = 1",
  );
  assert.equal(slot.rows[0].job_id, good.jobId);
});

test("recipe admission stores the recipe once and dag-run renders every stage", async () => {
  const s = await recipeJob({ captionEnabled: false });
  const row = (
    await s.db.owner.query(
      "SELECT recipe, recipe_sha256 FROM jobs WHERE id = $1",
      [s.jobId],
    )
  ).rows[0];
  assert.deepEqual(row.recipe, s.recipe);
  assert.equal(row.recipe_sha256, requestSha256(s.recipe));
  assert.equal(
    await code(
      s.db.owner.query("UPDATE jobs SET recipe = '{}'::jsonb WHERE id = $1", [
        s.jobId,
      ]),
    ),
    "SAC01",
  );
  const dag = await getDagRun(s.deps, s.jobId);
  assert.equal(validateValue("http.dag-run.v1", dag).valid, true);
  assert.deepEqual(
    dag.stages.map((n) => [n.stage, n.state, n.errorCode]),
    [
      ["segment", "pending", null],
      ["caption", "not_run", "stage_disabled"],
      ["hand_pose", "pending", null],
    ],
  );
  // A disabled stage is never claimed and only ever recorded as not_run.
  assert.equal(
    await code(
      issueStageClaim(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "caption",
      }),
    ),
    "conflict",
  );
  assert.equal(
    await code(
      recordStageRun(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "caption",
        state: "pending",
        module: MODULES.caption,
      }),
    ),
    "conflict",
  );
  // The single-claim path is refused for a recipe job.
  assert.equal(
    await code(
      recordWorkerSubmissionIntent(s.deps, { jobId: s.jobId, owner: s.ctl }),
    ),
    "conflict",
  );
  evidence.dagDisabled = dag.stages;
});

test("segment claims sign only their job's source inventory across recording owners", async () => {
  const s = await recipeJob();
  const other = await queuedJob({
    app: s.db.app,
    actors: await createActors(s.db.owner),
  });
  const issued = await issueStageClaim(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "segment",
  });
  assert.equal(issued.state, "recorded");
  assert.ok("bootstrapToken" in issued);
  const signed: string[] = [];
  const deps = {
    ...s.deps,
    presignRead: async (key: string, ttl: number) => {
      signed.push(key);
      return s.deps.presignRead(key, ttl);
    },
  };
  const claim = {
    bootstrapToken: issued.bootstrapToken,
    invocationNonce: nonce(),
    executor: { kind: "local", localExecutionRef: "sa85-segment" } as const,
  };

  assert.equal(
    await code(claimStage(deps, { ...claim, jobId: other.jobId })),
    "conflict",
  );
  assert.deepEqual(signed, []);

  const grant = await claimStage(deps, { ...claim, jobId: s.jobId });
  const files = await s.db.owner.query<{ id: string; object_key: string }>(
    "SELECT id, object_key FROM files WHERE recording_id = $1 ORDER BY id",
    [s.recordingId],
  );
  assert.ok(files.rows.length > 0);
  assert.deepEqual(
    signed,
    files.rows.map((row) => row.object_key),
  );
  assert.deepEqual(
    grant.inputs.map((input) => input.fileId),
    files.rows.map((row) => row.id),
  );
  assert.equal(grant.digests.sourceManifestSha256, s.sourceManifestSha256);
  assert.ok(
    grant.inputs.every(
      (input) =>
        Date.parse(input.expiresAt) <= Date.parse(grant.executionDeadline),
    ),
  );
});

test("stage claims: own nonce and token per stage, replay and second claim rejected, recipe order", async () => {
  const s = await recipeJob();
  // caption cannot start before segment has a terminal run
  assert.equal(
    await code(
      issueStageClaim(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "caption",
      }),
    ),
    "conflict",
  );
  assert.equal(
    await code(
      issueStageClaim(s.deps, {
        jobId: s.jobId,
        owner: "ctl-other",
        stage: "segment",
      }),
    ),
    "conflict",
    "lease-fenced",
  );
  const seg = await claimed(s, "segment");
  assert.deepEqual(
    await issueStageClaim(s.deps, {
      jobId: s.jobId,
      owner: s.ctl,
      stage: "segment",
    }),
    { state: "already_recorded" },
  );
  // A replayed bootstrap token resolves to nothing and cannot claim again.
  assert.equal(
    await new BootstrapCapabilityStore(s.db.app).findByTokenSha256(
      hashServiceToken(seg.bootstrapToken),
    ),
    null,
  );
  assert.equal(
    await code(
      claimStage(s.deps, {
        jobId: s.jobId,
        bootstrapToken: seg.bootstrapToken,
        invocationNonce: nonce(),
        executor: { kind: "local", localExecutionRef: "replayed-1" },
      }),
    ),
    "conflict",
  );
  // Heartbeat is per stage and nonce; a wrong nonce is not current.
  const hb = await recordStageHeartbeat(s.deps, {
    jobId: s.jobId,
    stage: "segment",
    invocationNonce: seg.nonce,
    phase: "segmenting",
    processedFrames: "10",
    totalFrames: "100",
  });
  assert.equal(hb.accepted, true);
  assert.equal(
    await code(
      recordStageHeartbeat(s.deps, {
        jobId: s.jobId,
        stage: "segment",
        invocationNonce: nonce(),
        phase: "segmenting",
      }),
    ),
    "forbidden",
  );
  const phase = (
    await s.db.owner.query(
      "SELECT j.heartbeat_phase AS job, c.heartbeat_phase AS stage, c.processed_frames::text AS done FROM jobs j JOIN job_stage_claims c ON c.job_id = j.id AND c.stage = 'segment' WHERE j.id = $1",
      [s.jobId],
    )
  ).rows[0];
  assert.deepEqual(phase, {
    job: "segmenting",
    stage: "segmenting",
    done: "10",
  });

  // Forward-only transitions and the write-once call ID.
  await recordStageRun(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "segment",
    state: "running",
    module: MODULES.segment,
    callId: seg.callId,
  });
  const replay = await recordStageRun(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "segment",
    state: "running",
    module: MODULES.segment,
    callId: seg.callId,
  });
  assert.equal(replay.recorded, false);
  const back = await code(
    recordStageRun(s.deps, {
      jobId: s.jobId,
      owner: s.ctl,
      stage: "segment",
      state: "submitting",
      module: MODULES.segment,
    }),
  );
  assert.equal(back, "conflict");
  // The recorded call ID can never change (write-once; also bound to the claim).
  assert.ok(
    ["SAC01", "SAC04"].includes(
      await code(
        s.db.owner.query(
          "UPDATE job_stage_runs SET call_id = 'other-call' WHERE job_id = $1 AND stage = 'segment'",
          [s.jobId],
        ),
      ),
    ),
  );
  assert.equal(
    await code(
      s.db.owner.query(
        "UPDATE job_stage_runs SET state = 'pending' WHERE job_id = $1 AND stage = 'segment'",
        [s.jobId],
      ),
    ),
    "SAC04",
  );
  assert.equal(
    await code(
      s.db.owner.query("DELETE FROM job_stage_runs WHERE job_id = $1", [
        s.jobId,
      ]),
    ),
    "SAC01",
  );
  // A succeeded run needs a receipt naming completed outputs of this job.
  assert.equal(
    await code(
      recordStageRun(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "segment",
        state: "succeeded",
        module: MODULES.segment,
        receipt: receiptOf(s, "segment", [
          {
            fileId: randomUUID(),
            slot: "segments.json",
            role: "segments_json",
            size: 10,
            sha: "0".repeat(64),
            body: Buffer.alloc(0),
          },
        ]),
      }),
    ),
    "conflict",
  );
  // A conflicting call ID through the controller action is a double spawn:
  // refused, never masked.
  assert.equal(
    await code(
      recordStageRun(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "segment",
        state: "running",
        module: MODULES.segment,
        callId: "second-spawn-1",
      }),
    ),
    "conflict",
  );
  // A spawned stage cannot be recorded failed without proof its call ended
  // (a timed-out GPU call could otherwise keep running).
  const unproven = await code(
    recordStageRun(s.deps, {
      jobId: s.jobId,
      owner: s.ctl,
      stage: "segment",
      state: "failed",
      module: MODULES.segment,
      errorCode: "engine_timeout",
    }),
  );
  assert.equal(unproven, "conflict");
  // not_run is reachable only from nothing or pending.
  assert.equal(
    await code(
      recordStageRun(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "segment",
        state: "not_run",
        module: MODULES.segment,
        errorCode: "skipped",
      }),
    ),
    "conflict",
  );
  // Stage proof names exactly that stage's call; it is not the job's
  // evidence while later stages can still run.
  assert.equal(
    await code(
      recordExecutionEvidence(s.deps, {
        jobId: s.jobId,
        recordedBy: "controller-test",
        evidence: { kind: "local_child_reaped", executionRef: "no-such-call" },
      }),
    ),
    "conflict",
  );
  const proof = await recordExecutionEvidence(s.deps, {
    jobId: s.jobId,
    recordedBy: "controller-test",
    evidence: { kind: "local_child_reaped", executionRef: seg.callId },
  });
  assert.deepEqual(proof, { recorded: true, slotReleased: false });
  assert.equal(
    (
      await s.db.owner.query(
        "SELECT count(*)::int AS n FROM job_execution_evidence WHERE job_id = $1",
        [s.jobId],
      )
    ).rows[0].n,
    0,
  );
  await recordStageRun(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "segment",
    state: "failed",
    module: MODULES.segment,
    errorCode: "engine_timeout",
  });
  // The finished stage's capability is over: its heartbeat is refused.
  assert.equal(
    await code(
      recordStageHeartbeat(s.deps, {
        jobId: s.jobId,
        stage: "segment",
        invocationNonce: seg.nonce,
        phase: "uploading",
      }),
    ),
    "forbidden",
  );
  const cap = await claimed(s, "caption");
  assert.notEqual(cap.nonce, seg.nonce);
  // A phase of another stage is a malformed heartbeat, not a server error.
  assert.equal(
    await code(
      recordStageHeartbeat(s.deps, {
        jobId: s.jobId,
        stage: "caption",
        invocationNonce: cap.nonce,
        phase: "segmenting",
      }),
    ),
    "invalid_request",
  );
  // Slot release needs proof for EVERY spawned stage: job evidence naming the
  // latest (caption) call is refused while caption has no stage proof, and
  // naming the earlier segment call is refused too.
  assert.equal(
    await code(
      s.db.owner.query(
        "INSERT INTO job_execution_evidence (job_id, kind, execution_ref, recorded_by) VALUES ($1, 'local_child_reaped', $2, 'test')",
        [s.jobId, cap.callId],
      ),
    ),
    "SAC04",
  );
  assert.equal(
    await code(
      s.db.owner.query(
        "INSERT INTO job_execution_evidence (job_id, kind, execution_ref, recorded_by) VALUES ($1, 'local_child_reaped', $2, 'test')",
        [s.jobId, seg.callId],
      ),
    ),
    "SAC04",
  );
  // A caption stage reads only segments_json outputs of the same job.
  assert.equal(
    await code(
      readStageOutput(s.deps, {
        jobId: s.jobId,
        fileId: randomUUID(),
        stage: "segment",
      }),
    ),
    "forbidden",
  );
  assert.equal(
    await code(
      readStageOutput(s.deps, {
        jobId: s.jobId,
        fileId: randomUUID(),
        stage: "caption",
      }),
    ),
    "not_found",
  );
  const dag = await getDagRun(s.deps, s.jobId);
  assert.deepEqual(
    dag.stages.map((n) => [n.stage, n.state, n.errorCode, n.callId]),
    [
      ["segment", "failed", "engine_timeout", seg.callId],
      ["caption", "pending", null, null],
      ["hand_pose", "pending", null, null],
    ],
  );
  evidence.claims = { dag: dag.stages };
});

test("0-clip annotation-only recipe result is accepted with its counts", async () => {
  const s = await recipeJob();
  const r = await runRecipe(s);
  await seal(s, r);
  const ack = await advanceResult(s.accept, s.jobId);
  assert.equal(ack?.candidateStatus, "accepted");
  const facts = await jobFacts(s);
  assert.deepEqual(facts, {
    state: "succeeded",
    error_code: null,
    segment_count: 3,
    failed_window_count: 1,
    caption_count: 2,
    caption_failed_count: 1,
    recording: "reviewable",
    clips: 0,
    holder: null,
  });
  const dag = await getDagRun(s.deps, s.jobId);
  assert.equal(validateValue("http.dag-run.v1", dag).valid, true);
  assert.deepEqual(
    dag.stages.map((n) => [n.stage, n.state, n.receiptSha256 !== null]),
    [
      ["segment", "succeeded", true],
      ["caption", "succeeded", true],
      ["hand_pose", "succeeded", true],
    ],
  );
  // The diagnostic blob is stored but is never a clip file (the customer
  // broker serves only clip thumbnail/viewer files).
  const diag = (
    await s.db.owner.query(
      "SELECT count(*)::int AS n FROM clips c JOIN files f ON f.id IN (c.thumbnail_file_id, c.viewer_rrd_file_id) WHERE f.role = 'diagnostic_blob'",
    )
  ).rows[0].n;
  assert.equal(diag, 0);
  evidence.zeroClip = { facts, dag };
});

test("a caption row for an unknown segment is rejected and the job fails", async () => {
  const s = await recipeJob();
  // A well-formed segment ID (uuid5) that the accepted segments do not contain.
  const stranger = segmentId(
    s.sourceManifestSha256,
    MODULES.segment,
    "0".repeat(64),
    "999999",
    null,
  );
  const r = await runRecipe(s, (captions) => {
    captions.rows[1].segment_id = stranger;
  });
  await seal(s, r);
  const ack = await advanceResult(s.accept, s.jobId);
  assert.equal(ack?.candidateStatus, "rejected");
  assert.equal(ack?.reasonCode, "caption_unknown_segment");
  const facts = await jobFacts(s);
  assert.equal(facts.state, "failed");
  assert.equal(facts.segment_count, null);
  evidence.unknownSegment = facts;
});

test("clip path unchanged: a single-claim clip result is accepted; annotation roles are refused there", async () => {
  const db = await acceptanceDatabase();
  open.push(db);
  const { transport, accept } = await acceptanceDeps(db);
  const job = await runningJob(db);
  const clip = await uploadClip(transport, job, 0);
  const bytes = await manifestFor(db, job, [clip]);
  const manifest = await uploadOutput(
    transport,
    job,
    "result-manifest.json",
    "result_manifest",
    bytes,
  );
  const closure = await closeOutputs(accept, {
    jobId: job.jobId,
    invocationNonce: job.nonce,
    outcome: "succeeded",
  });
  assert.equal(closure.clipCount, 1);
  await submitCandidate(
    accept,
    candidateBody(job, manifest, JSON.parse(bytes.toString())),
  );
  const ref = (
    await db.owner.query("SELECT execution_call_id FROM jobs WHERE id = $1", [
      job.jobId,
    ])
  ).rows[0].execution_call_id as string;
  await recordExecutionEvidence(
    { pool: db.app },
    {
      jobId: job.jobId,
      recordedBy: "controller-test",
      evidence: { kind: "local_child_reaped", executionRef: ref },
    },
  );
  const ack = await advanceResult(accept, job.jobId);
  assert.equal(ack?.candidateStatus, "accepted");

  // A job without a recipe can never close with recording-level roles.
  const legacy = await runningJob(db);
  await uploadOutput(
    transport,
    legacy,
    "segments.json",
    "segments_json",
    Buffer.from("{}"),
  );
  await uploadOutput(
    transport,
    legacy,
    "result-manifest.json",
    "result_manifest",
    Buffer.from("{}"),
  );
  assert.equal(
    await code(
      closeOutputs(accept, {
        jobId: legacy.jobId,
        invocationNonce: legacy.nonce,
        outcome: "failed",
      }),
    ),
    "conflict",
  );
  // A wrong slot for a role is refused by the slot policy.
  assert.deepEqual(
    {
      ...(
        await db.owner.query(
          "SELECT job_output_slot_role_ok('diagnostics/segment/..', 'diagnostic_blob') AS a, job_output_slot_role_ok('segments.json', 'captions_json') AS b, job_output_slot_role_ok('diagnostics/caption/log.txt', 'diagnostic_blob') AS c",
        )
      ).rows[0],
    },
    { a: false, b: false, c: true },
  );
});

test("files CHECK caps diagnostic blobs at 64 MiB", async () => {
  const db = await acceptanceDatabase();
  open.push(db);
  const r = (
    await db.owner.query(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'files_diagnostic_blob_size_check'",
    )
  ).rows[0];
  assert.match(r.def, /67108864/);
  const sql = readFileSync(
    new URL("../migrations/011_stage_runs.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /files_role_v2_check/);
});

test("submit_unknown keeps its reason, then the claim resolves it; not_run is refused after submission", async () => {
  const s = await recipeJob();
  const issued = await issueStageClaim(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "segment",
  });
  assert.equal(issued.state, "recorded");
  if (issued.state !== "recorded") throw new Error("unreachable");
  for (const state of ["pending", "submitting", "submit_unknown"] as const)
    await recordStageRun(s.deps, {
      jobId: s.jobId,
      owner: s.ctl,
      stage: "segment",
      state,
      module: MODULES.segment,
    });
  const unknown = (
    await s.db.owner.query(
      "SELECT state, unknown_reason, error_code FROM job_stage_runs WHERE job_id = $1",
      [s.jobId],
    )
  ).rows[0];
  assert.deepEqual(
    { ...unknown },
    {
      state: "submit_unknown",
      unknown_reason: "submit_outcome_unknown",
      error_code: null,
    },
  );
  assert.equal(
    await code(
      recordStageRun(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "segment",
        state: "not_run",
        module: MODULES.segment,
        errorCode: "skipped",
      }),
    ),
    "conflict",
  );
  // The call is lost (submit_unknown): the stage can be neither failed
  // without proof nor released; it waits for the operator path.
  assert.equal(
    await code(
      recordStageRun(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "segment",
        state: "failed",
        module: MODULES.segment,
        errorCode: "spawn_lost",
      }),
    ),
    "conflict",
  );
  assert.equal(
    await code(
      s.db.owner.query(
        "INSERT INTO job_execution_evidence (job_id, kind, execution_ref, recorded_by) VALUES ($1, 'local_child_reaped', 'guess-1', 'test')",
        [s.jobId],
      ),
    ),
    "SAC04",
  );
  // A recipe job with no stage proof cannot be released at all.
  assert.equal(
    await code(
      recordExecutionEvidence(s.deps, {
        jobId: s.jobId,
        recordedBy: "controller-test",
        evidence: { kind: "pre_submission_rejected" },
      }),
    ),
    "conflict",
  );
  // Defense in depth: the job itself is claimed only with a claimed stage's
  // exact nonce and capability (the single-claim path cannot run it).
  assert.equal(
    await code(
      s.db.owner.query(
        `UPDATE jobs SET state = 'running', claimed_at = now(), invocation_nonce = $2,
           execution_call_id = 'single-claim-1', capability_token_sha256 = repeat('a', 64)
         WHERE id = $1`,
        [s.jobId, nonce()],
      ),
    ),
    "SAC04",
  );
  const callId = `stage-segment-${randomUUID()}`;
  await claimStage(s.deps, {
    jobId: s.jobId,
    bootstrapToken: issued.bootstrapToken,
    invocationNonce: nonce(),
    executor: { kind: "local", localExecutionRef: callId },
  });
  await recordStageRun(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "segment",
    state: "running",
    module: MODULES.segment,
    callId,
  });
  const after = (
    await s.db.owner.query(
      "SELECT state, unknown_reason, call_id FROM job_stage_runs WHERE job_id = $1",
      [s.jobId],
    )
  ).rows[0];
  assert.deepEqual(
    { ...after },
    {
      state: "running",
      unknown_reason: "submit_outcome_unknown",
      call_id: callId,
    },
  );

  // Operator path: once the exact call is known, its proof lets the stage end.
  await recordExecutionEvidence(s.deps, {
    jobId: s.jobId,
    recordedBy: "operator-test",
    evidence: { kind: "local_child_reaped", executionRef: callId },
  });
  await recordStageRun(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "segment",
    state: "failed",
    module: MODULES.segment,
    errorCode: "spawn_lost",
  });
});

test("an issued claim whose call was never learned cannot be failed, not_run or released", async () => {
  const s = await recipeJob();
  const issued = await issueStageClaim(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "segment",
  });
  assert.equal(issued.state, "recorded");
  for (const [state, errorCode] of [
    ["failed", "spawn_lost"],
    ["cancelled", "cancelled_by_controller"],
    ["not_run", "skipped"],
  ] as const)
    assert.equal(
      await code(
        recordStageRun(s.deps, {
          jobId: s.jobId,
          owner: s.ctl,
          stage: "segment",
          state,
          module: MODULES.segment,
          errorCode,
        }),
      ),
      "conflict",
      `${state} without proof`,
    );
  // The next stage cannot start, and the slot cannot be released.
  assert.equal(
    await code(
      issueStageClaim(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "caption",
      }),
    ),
    "conflict",
  );
  for (const evidence of [
    { kind: "local_child_reaped" as const, executionRef: "guess-1" },
    { kind: "pre_submission_rejected" as const },
  ])
    assert.equal(
      await code(
        recordExecutionEvidence(s.deps, {
          jobId: s.jobId,
          recordedBy: "controller-test",
          evidence,
        }),
      ),
      "conflict",
    );
  const held = (
    await s.db.owner.query(
      "SELECT job_id FROM dispatch_admission WHERE slot = 1",
    )
  ).rows[0].job_id;
  assert.equal(held, s.jobId);
});

// ------------------------------------------------------- SA-91 stage files

test("SA-91 prior-stages: every completed file of segment and caption by slot, never a seal file, contract-valid", async () => {
  const s = await recipeJob();
  const r = await runRecipe(s, () => {}, { orphan: true });
  const prior = await getPriorStages(s.deps, s.jobId);
  assert.equal(validateValue("jobs.prior-stages.v1", prior).valid, true);
  const slots = Object.fromEntries(
    prior.stages.map((p) => [
      p.stage,
      p.outputs.map((o) => [o.slot, o.fileId]),
    ]),
  );
  // The orphan diagnostic (no receipt names it) still belongs to segment; hand_pose files,
  // recording.mp4, hand-presence.json and the manifest belong to no earlier stage.
  assert.deepEqual(slots, {
    segment: [
      ["diagnostics/segment/log.txt", r.orphan!.fileId],
      ["diagnostics/segment/windows.jsonl", r.diag.fileId],
      ["segments.json", r.segFile.fileId],
    ],
    caption: [["captions.json", r.capFile.fileId]],
  });
  const seg = prior.stages[0]!;
  assert.deepEqual(
    [seg.state, seg.errorCode, seg.counts.segments],
    ["succeeded", null, 3],
  );
  assert.deepEqual(
    seg.outputs.find((o) => o.slot === "segments.json"),
    {
      fileId: r.segFile.fileId,
      role: "segments_json",
      slot: "segments.json",
      sizeBytes: String(r.segFile.size),
      sha256: r.segFile.sha,
    },
  );
  evidence.priorStages = prior;
});

test("SA-91 acceptance: a stage owns its orphan file by slot, so the seal is accepted", async () => {
  const s = await recipeJob();
  const r = await runRecipe(s, () => {}, { orphan: true });
  await seal(s, r as never);
  const ack = await advanceResult(s.accept, s.jobId);
  assert.equal(ack?.candidateStatus, "accepted");
  assert.equal((await jobFacts(s)).state, "succeeded");
});

for (const [name, mutate] of [
  [
    "a segment file listed by the caption node",
    (d: Record<string, any>, ids: Record<string, string>) => {
      d.nodes[0].outputs = d.nodes[0].outputs.filter(
        (f: string) => f !== ids.diag,
      );
      d.nodes[1].outputs.push(ids.diag);
    },
  ],
  [
    "a segment file left out of the segment node and claimed by hand_pose",
    (d: Record<string, any>, ids: Record<string, string>) => {
      d.nodes[0].outputs = d.nodes[0].outputs.filter(
        (f: string) => f !== ids.diag,
      );
      d.nodes[2].outputs.push(ids.diag);
    },
  ],
] as const)
  test(`SA-91 acceptance rejects ${name} (exact slot attribution)`, async () => {
    const s = await recipeJob();
    const r = await runRecipe(s, () => {}, { mutateDoc: mutate });
    await seal(s, r as never);
    const ack = await advanceResult(s.accept, s.jobId);
    assert.equal(ack?.candidateStatus, "rejected");
    assert.equal(ack?.reasonCode, "manifest_node_mismatch");
    assert.equal((await jobFacts(s)).state, "failed");
  });

test("SA-91 acceptance: a recipe job's v2 failure report is accepted and the job fails truthfully", async () => {
  const s = await recipeJob();
  const r = await runRecipe(s, () => {}, { noManifest: true });
  const bytes = await manifestFor(s.db, r.hand.job, [], (d) => {
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
  const failure = await uploadOutput(
    s.transport,
    r.hand.job,
    "result-manifest.json",
    "result_manifest",
    bytes,
  );
  await closeOutputs(s.accept, {
    jobId: s.jobId,
    invocationNonce: r.hand.nonce,
    outcome: "failed",
  });
  await submitCandidate(s.accept, {
    schemaVersion: 1,
    jobId: s.jobId,
    invocationNonce: r.hand.nonce,
    manifestFileId: failure.fileId,
    manifestSha256: failure.sha,
    summary: {
      outcome: "failed",
      clipCount: 0,
      checks: { pass: 0, warn: 0, fail: 1, measured: 0, notEvaluated: 0 },
      errorCode: "worker_failed",
    },
  } as never);
  // The seal stage itself failed: proof for its call, then its failed row.
  await recordStageRun(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "hand_pose",
    state: "running",
    module: MODULES.hand_pose,
    callId: r.hand.callId,
  });
  await recordExecutionEvidence(s.deps, {
    jobId: s.jobId,
    recordedBy: "controller-test",
    evidence: { kind: "local_child_reaped", executionRef: r.hand.callId },
  });
  await recordStageRun(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "hand_pose",
    state: "failed",
    module: MODULES.hand_pose,
    callId: r.hand.callId,
    errorCode: "worker_failed",
  });
  await advanceResult(s.accept, s.jobId);
  const ack = await advanceResult(s.accept, s.jobId);
  assert.equal(ack?.candidateStatus, "accepted");
  const facts = await jobFacts(s);
  assert.equal(facts.state, "failed");
  assert.equal(facts.error_code, "worker_failed");
  assert.equal(facts.holder, null);
});
