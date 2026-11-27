import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { requestSha256, type CompiledGraph } from "@stateaction/contracts";
import { sealGraphRecipe } from "../src/acceptance/service.js";
import { ObjectHashError } from "../src/acceptance/storage.js";
import { hashServiceToken } from "../src/auth/service.js";
import { inTransaction } from "../src/catalog/catalog.js";
import {
  CPU_CANARY_RECIPE_REF,
  publishedRecipe,
} from "../src/jobs/recipe-release.js";
import type { GraphReleaseBinding } from "../src/jobs/graph-admission.js";
import { applyGraphAction, claimGraphNode } from "../src/jobs/graph-run.js";
import { jobHandlers } from "../src/jobs/http.js";
import { BootstrapCapabilityStore } from "../src/jobs/credentials.js";
import {
  admitNextJob,
  claimControllerLease,
  claimWorker,
  recordWorkerSubmissionIntent,
} from "../src/jobs/service.js";
import { acceptanceDeps, uploadOutput } from "./acceptance-harness.js";
import {
  depsFor,
  jobsDatabase,
  nonce,
  queuedJob,
  slotHolder,
  type JobsTestDb,
} from "./jobs-harness.js";

async function queueCpuPlan(db: JobsTestDb, graph: CompiledGraph) {
  const { jobId, recordingId } = await queuedJob(db, "clip_plan");
  await db.app.query(
    `INSERT INTO recording_capture_profiles (recording_id, source_manifest_sha256,
         state, capture_source_id, allowed_recipe_ids, recipe_id, recipe_sha256, recipe, evidence)
     SELECT id, source_manifest_sha256, 'selected', 'stateaction_mobile@1', ARRAY[$2], $2, $3, $4, '{}'::jsonb
     FROM recordings WHERE id = $1`,
    [recordingId, graph.recipe, graph.recipeSha256, graph],
  );
  return jobId;
}

test("the reconciler refuses an unbound graph before starting a workflow", async (t) => {
  const db = await jobsDatabase();
  t.after(() => db.close());
  const jobId = await queueCpuPlan(db, publishedRecipe(CPU_CANARY_RECIPE_REF)!);
  let calls = 0;
  const handlers = jobHandlers(() => ({
    ...depsFor(db),
    graphBindings: new Map(),
    taskStarter: {
      async start() {
        calls++;
        throw new Error("An unbound graph cannot be sent");
      },
    },
  }));
  const response = await handlers.reconcile(
    new Request("http://127.0.0.1/reconcile", { method: "POST" }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    (
      await db.app.query(
        "SELECT state, error_code, error_message FROM jobs WHERE id = $1",
        [jobId],
      )
    ).rows,
    [
      {
        state: "cancelled",
        error_code: "task_input_invalid",
        error_message: "deployment_binding_unavailable",
      },
    ],
  );
  assert.equal(
    (await db.app.query("SELECT 1 FROM job_recipe_node_claims")).rowCount,
    0,
  );
  assert.equal(calls, 0);
});

async function admitCpuPlan(db: JobsTestDb) {
  const graph = publishedRecipe(CPU_CANARY_RECIPE_REF)!;
  const jobId = await queueCpuPlan(db, graph);
  const codeRevision = "a".repeat(40);
  const bindings = new Map<string, GraphReleaseBinding>(
    Object.values(graph.nodes).map((node) => [
      node.module,
      {
        definitionFormat: "local",
        mode: "local_cpu",
        gpu: null,
        maxContainers: 1,
        maxBilledSeconds: 120,
        microUsdPerCpuSecond: 0,
        microUsdPerGpuSecond: 0,
        codeRevision,
        paramsSha256: requestSha256(node.params),
        imageSha256: "8".repeat(64),
        definitionSha256: "9".repeat(64),
        moduleLockSha256: node.moduleLockSha256,
      },
    ]),
  );
  const deps = depsFor(db);
  const admitted = await admitNextJob({
    ...deps,
    config: { ...deps.config, codeRevision },
    graphBindings: bindings,
  });
  assert.equal(admitted.state, "admitted");
  const owner = "graph-controller";
  assert.equal(
    (
      await claimControllerLease(deps, {
        jobId,
        runRef: "local-render-run",
        owner,
      })
    ).granted,
    true,
  );
  return { jobId, graph, deps, owner, bindings };
}

test("graph claims bind admitted nodes and preserve the exact submit and cancellation boundary", async (t) => {
  const db = await jobsDatabase();
  t.after(() => db.close());
  const {
    jobId,
    graph,
    deps,
    owner: leaseOwner,
    bindings,
  } = await admitCpuPlan(db);
  assert.deepEqual(
    (
      await db.app.query(
        "SELECT recipe_ref, recipe_sha256, graph FROM job_recipe_graphs WHERE job_id = $1",
        [jobId],
      )
    ).rows,
    [{ recipe_ref: graph.recipe, recipe_sha256: graph.recipeSha256, graph }],
  );
  const handler = jobHandlers(() => deps);
  const read = await handler.graphRun(
    new Request("http://127.0.0.1/graph"),
    jobId,
  );
  assert.equal(read.status, 200);
  const document = (await read.json()).data;
  assert.equal(document.task.recipeSha256, graph.recipeSha256);
  assert.deepEqual(Object.keys(document.nodes).sort(), [
    "original_video",
    "source_span",
  ]);
  assert.equal(document.nodes.source_span.state, "pending");
  const noLegacyIntent = () =>
    recordWorkerSubmissionIntent(deps, { jobId, owner: leaseOwner });
  await assert.rejects(noLegacyIntent(), { code: "conflict" });
  const claim = (
    nodeId: string,
    owner: string,
    binding: unknown,
    sha: string,
  ) =>
    db.app.query("SELECT * FROM job_graph_issue_claim($1,$2,$3,$4,$5,30)", [
      jobId,
      nodeId,
      owner,
      binding,
      sha.repeat(64),
    ]);
  const begin = (nodeId: string) =>
    db.app.query("SELECT job_graph_begin_submission($1,$2,$3) AS outcome", [
      jobId,
      nodeId,
      leaseOwner,
    ]);
  const plan = bindings.get("clip_filter_passthrough@1")!;
  const video = bindings.get("recording_mp4_remux@1")!;
  await assert.rejects(claim("track_hands", leaseOwner, plan, "1"), {
    code: "SAC04",
  });
  await assert.rejects(claim("source_span", "stale-owner", plan, "1"), {
    code: "SAC04",
  });
  await assert.rejects(claim("source_span", leaseOwner, video, "1"), {
    code: "SAC04",
  });
  const issued = await handler.graphControl(
    new Request("http://127.0.0.1/graph", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "issue_node_claim",
        nodeId: "source_span",
        owner: leaseOwner,
        bindingSha256: requestSha256(plan),
      }),
    }),
    jobId,
  );
  assert.equal(issued.status, 200);
  const issue = (await issued.json()).data;
  assert.equal(issue.state, "issued");
  assert.equal(
    await new BootstrapCapabilityStore(db.app).findByTokenSha256(
      hashServiceToken(issue.bootstrapToken),
    ),
    null,
  );
  await assert.rejects(noLegacyIntent(), { code: "conflict" });
  await assert.rejects(
    claimWorker(deps, {
      jobId,
      bootstrapToken: issue.bootstrapToken,
      invocationNonce: nonce(),
      executor: { kind: "local", localExecutionRef: "local-example" },
    }),
    { code: "conflict" },
  );
  assert.deepEqual(db.signed, []);
  assert.equal(
    (await claim("source_span", leaseOwner, plan, "2")).rows[0].issued,
    false,
  );
  await assert.rejects(claim("original_video", leaseOwner, video, "2"), {
    code: "SAC04",
  });
  await assert.rejects(
    db.app.query(
      `INSERT INTO job_execution_evidence (job_id, kind, execution_ref, detail, recorded_by)
       VALUES ($1, 'pre_submission_rejected', NULL, '{}', 'fixture-repair')`,
      [jobId],
    ),
    { code: "SAC04" },
  );
  assert.equal(
    (await db.app.query("SELECT job_graph_settled($1) AS settled", [jobId]))
      .rows[0].settled,
    false,
  );
  assert.deepEqual((await begin("source_span")).rows, [{ outcome: "started" }]);
  assert.deepEqual((await begin("source_span")).rows, [
    { outcome: "already_started" },
  ]);
  await db.app.query(
    "SELECT job_graph_bind_call($1,'source_span',$2,'local-example')",
    [jobId, leaseOwner],
  );
  await assert.rejects(
    db.app.query(
      "SELECT job_graph_bind_call($1,'source_span',$2,'local-other')",
      [jobId, leaseOwner],
    ),
    { code: "SAC04" },
  );
  const terminal = (ref: string) =>
    db.app.query(
      "SELECT job_graph_record_terminal($1,'source_span',$2,'local_child_reaped',$3,$4)",
      [jobId, leaseOwner, ref, { reason: "test_exit" }],
    );
  await assert.rejects(terminal("local-other"), { code: "SAC04" });
  await terminal("local-example");
  assert.equal(
    (await claim("original_video", leaseOwner, video, "2")).rows[0].issued,
    true,
  );
  await db.app.query(
    "UPDATE jobs SET state = 'cancel_requested' WHERE id = $1",
    [jobId],
  );
  assert.deepEqual((await begin("original_video")).rows, [
    { outcome: "never_submitted" },
  ]);
  const { rows } = await db.app.query(
    `SELECT node_id, kind, execution_ref FROM job_recipe_node_evidence WHERE job_id = $1 ORDER BY node_id`,
    [jobId],
  );
  assert.deepEqual(rows, [
    { node_id: "original_video", kind: "never_submitted", execution_ref: null },
    {
      node_id: "source_span",
      kind: "local_child_reaped",
      execution_ref: "local-example",
    },
  ]);
  await assert.rejects(db.app.query("DELETE FROM job_recipe_node_evidence"), {
    code: "42501",
  });
});

for (const [state, reason] of [
  ["submitting", "graph_worker_unclaimed"],
  ["submit_unknown", "submission_unconfirmed"],
  ["needs_attention", "execution_needs_attention"],
] as const) {
  test(`a settled graph releases the admission slot from ${state}`, async (t) => {
    const db = await jobsDatabase();
    t.after(() => db.close());
    const { jobId, deps, owner, bindings } = await admitCpuPlan(db);
    const { accept, transport } = await acceptanceDeps(db);
    const nodeId = "source_span";
    const control = (action: Parameters<typeof applyGraphAction>[2]) =>
      applyGraphAction(deps, jobId, action);
    await control({
      action: "issue_node_claim",
      owner,
      nodeId,
      bindingSha256: requestSha256(bindings.get("clip_filter_passthrough@1")!),
    });
    await control({ action: "begin_node_submission", owner, nodeId });
    await control({
      action: "record_node_call",
      owner,
      nodeId,
      executionRef: "local-no-claim",
    });
    assert.equal(await slotHolder(db), jobId);
    const skipUnstarted = () =>
      control({
        action: "record_node_result",
        owner,
        nodeId: "original_video",
        state: "skipped",
        errorCode: reason,
        receipt: null,
        files: [],
      });
    if (state === "submit_unknown") {
      await db.app.query("UPDATE jobs SET state = $2 WHERE id = $1", [
        jobId,
        state,
      ]);
      await assert.rejects(skipUnstarted(), {
        message:
          "an unresolved submission does not authorize skipping other nodes",
      });
    }
    await control({
      action: "record_node_terminal",
      owner,
      nodeId,
      executionRef: "local-no-claim",
      kind: "local_child_reaped",
      observed: { exitCode: 1 },
    });
    await control({
      action: "record_node_result",
      owner,
      nodeId,
      state: "failed",
      errorCode: "node_receipt_unavailable",
      receipt: null,
      files: [],
    });
    if (state === "needs_attention") {
      await control({
        action: "issue_node_claim",
        owner,
        nodeId: "original_video",
        bindingSha256: requestSha256(bindings.get("recording_mp4_remux@1")!),
      });
      await assert.rejects(skipUnstarted(), {
        message: "a live or started claim cannot be skipped",
      });
    }
    await db.app.query("UPDATE jobs SET state = $2 WHERE id = $1", [
      jobId,
      state,
    ]);
    await skipUnstarted();
    if (state === "needs_attention") {
      assert.deepEqual(
        (
          await db.app.query(
            "SELECT kind,execution_ref FROM job_recipe_node_evidence WHERE job_id = $1 AND node_id = 'original_video'",
            [jobId],
          )
        ).rows,
        [{ kind: "never_submitted", execution_ref: null }],
      );
    }
    assert.equal(await sealGraphRecipe(accept, transport, jobId, owner), true);
    assert.equal(await slotHolder(db), null);
    assert.deepEqual(
      (
        await db.app.query(
          `SELECT j.state, j.error_code, j.claimed_at, e.kind, e.detail
       FROM jobs j JOIN job_execution_evidence e ON e.job_id = j.id WHERE j.id = $1`,
          [jobId],
        )
      ).rows,
      [
        {
          state: "failed",
          error_code: reason,
          claimed_at: null,
          kind: "graph_nodes_terminal",
          detail: { reason },
        },
      ],
    );
  });
}

async function proveGraphOutput(
  t: TestContext,
  expireBeforeSettlement: boolean,
) {
  const db = await jobsDatabase();
  t.after(() => db.close());
  const { jobId, graph, deps, owner, bindings } = await admitCpuPlan(db);
  const { accept, transport } = await acceptanceDeps(db);
  const nodeId = "original_video";
  const bindingSha256 = requestSha256(bindings.get("recording_mp4_remux@1")!);
  const issued = await applyGraphAction(deps, jobId, {
    action: "issue_node_claim",
    owner,
    nodeId,
    bindingSha256,
  });
  assert.equal(issued.state, "issued");
  assert.ok("bootstrapToken" in issued);
  const invocationNonce = nonce();
  const executionRef = "local-video";
  await applyGraphAction(deps, jobId, {
    action: "begin_node_submission",
    owner,
    nodeId,
  });
  await applyGraphAction(deps, jobId, {
    action: "record_node_call",
    owner,
    nodeId,
    executionRef,
  });
  const grant = await claimGraphNode(
    deps,
    jobId,
    {
      nodeId,
      invocationNonce,
      executionRef,
      backend: "local",
      bindingSha256,
    },
    issued.bootstrapToken,
  );
  assert.equal(db.signed.length, 1);
  const { targetId: recordingId, sourceManifestSha256 } = grant.task;
  assert.ok(typeof recordingId === "string");
  const video = await uploadOutput(
    transport,
    {
      jobId,
      recordingId,
      nonce: invocationNonce,
      authority: { kind: "job", jobId, nodeId },
    },
    "nodes/original_video/video.mp4",
    "recording_mp4",
    Buffer.from("synthetic bytes for digest verification"),
  );
  await applyGraphAction(deps, jobId, {
    action: "record_node_terminal",
    owner,
    nodeId,
    executionRef,
    kind: "local_child_reaped",
    observed: { exitCode: 0 },
  });
  const receipt = JSON.stringify({
    schema: "stateaction.recipe-node-receipt/v2",
    jobId,
    nodeId,
    recordingId,
    recipeRef: graph.recipe,
    recipeSha256: graph.recipeSha256,
    module: "recording_mp4_remux@1",
    sourceManifestSha256,
    sourceFileId: grant.source.fileId,
    sourceSha256: grant.source.sha256,
    claimRef: invocationNonce,
    executionRef,
    binding: grant.binding,
    requestSha256: "a".repeat(64),
    status: "succeeded",
    counts: {},
    outputs: {
      video: {
        kind: "review_video@1",
        files: {
          video: {
            name: "video.mp4",
            sha256: video.sha,
            sizeBytes: video.size,
          },
        },
      },
    },
  });
  let elapsed = 0;
  let hashes = 0;
  let transient = true;
  const now = Date.now.bind(Date);
  t.mock.method(Date, "now", () => now() + elapsed);
  const slow = {
    ...deps,
    acceptance: {
      ...accept,
      hasher: {
        async hash(key: string, bytes: number, boundMs: number) {
          if (transient) {
            transient = false;
            throw new ObjectHashError(
              "object_read_failed",
              "fixture connection lost",
            );
          }
          hashes++;
          assert.ok(boundMs > 26_000);
          const result = await accept.hasher.hash(key, bytes, boundMs);
          elapsed += 26_000;
          return result;
        },
      },
    },
  };
  const result = () =>
    applyGraphAction(slow, jobId, {
      action: "record_node_result",
      nodeId,
      owner,
      state: "succeeded",
      errorCode: null,
      receipt,
      files: [
        {
          port: "video",
          logicalFile: "video",
          name: "video.mp4",
          fileId: video.fileId,
        },
      ],
    });
  await assert.rejects(
    db.app.query("DELETE FROM job_graph_file_verifications"),
    { code: "42501" },
  );
  await assert.rejects(
    db.app.query(
      "SELECT job_graph_record_result($1,$2,$3,'succeeded',NULL,$4,$5,$6)",
      [
        jobId,
        nodeId,
        owner,
        receipt,
        JSON.stringify([
          {
            port: "video",
            logicalFile: "video",
            name: "video.mp4",
            fileId: video.fileId,
            artifactType: "review_video@1",
            sha256: video.sha,
            sizeBytes: String(video.size),
          },
        ]),
        "a".repeat(64),
      ],
    ),
    { code: "SAC04" },
  );
  assert.deepEqual(await result(), { state: "verifying" });
  assert.equal(
    (
      await db.app.query(
        "SELECT 1 FROM job_recipe_node_results WHERE job_id = $1 AND node_id = $2",
        [jobId, nodeId],
      )
    ).rowCount,
    0,
  );
  assert.deepEqual(await result(), { state: "verifying" });
  assert.equal(
    (
      await db.app.query(
        "SELECT 1 FROM job_graph_file_verifications WHERE file_id = $1",
        [video.fileId],
      )
    ).rowCount,
    1,
  );
  assert.equal(
    (
      await db.app.query(
        "SELECT 1 FROM job_recipe_node_outputs WHERE file_id = $1",
        [video.fileId],
      )
    ).rowCount,
    0,
  );
  if (expireBeforeSettlement) {
    await inTransaction(db.owner, async (fixture) => {
      await fixture.query(
        "ALTER TABLE jobs DISABLE TRIGGER jobs_orchestration_guard",
      );
      await fixture.query(
        `UPDATE jobs SET start_deadline = clock_timestamp() - interval '2 seconds',
           execution_deadline = clock_timestamp() - interval '1 second' WHERE id = $1`,
        [jobId],
      );
      await fixture.query(
        "ALTER TABLE jobs ENABLE TRIGGER jobs_orchestration_guard",
      );
    });
    assert.deepEqual(await result(), { state: "recorded" });
    assert.deepEqual(await result(), { state: "recorded" });
    assert.equal(hashes, 1);
    assert.deepEqual(
      (
        await db.app.query(
          `SELECT state,error_code,(SELECT count(*)::int FROM job_recipe_node_outputs o
         WHERE o.job_id = r.job_id) AS outputs
       FROM job_recipe_node_results r WHERE r.job_id = $1 AND r.node_id = $2`,
          [jobId, nodeId],
        )
      ).rows,
      [{ state: "failed", error_code: "execution_deadline", outputs: 0 }],
    );
    return;
  }
  assert.deepEqual(await result(), { state: "recorded" });
  assert.deepEqual(await result(), { state: "recorded" });
  assert.equal(hashes, 1);
  assert.equal(
    (
      await db.app.query(
        "SELECT 1 FROM job_recipe_node_outputs WHERE file_id = $1",
        [video.fileId],
      )
    ).rowCount,
    1,
  );
}

test("a slow graph output streams under a bounded deadline and resumes from the saved digest", (t) =>
  proveGraphOutput(t, false));
test("a durable graph digest cannot publish outputs after the database execution deadline", (t) =>
  proveGraphOutput(t, true));
