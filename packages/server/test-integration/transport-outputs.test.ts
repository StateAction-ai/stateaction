import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { validateValue } from "@stateaction/contracts";
import {
  allocateJobOutput,
  getUploadPlan,
  journalReceipts,
  signParts,
  transportHandlers,
  TransportError,
  type Authority,
  type TransportDeps,
} from "../src/transport/index.js";
import {
  completeAndRead,
  depsFor,
  newRecording,
  openSession,
  putPart,
  realProvider,
  transportDatabase,
  uploadsAt,
} from "./transport-harness.js";
import {
  processedRecording,
  writeArtifact,
  type Actors,
  type TestDb,
} from "./harness.js";

let db: TestDb & { actors: Actors };
let deps: TransportDeps;
let job: Extract<Authority, { kind: "job" }>;
let recordingId: string;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const code = async (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) =>
      error instanceof TransportError
        ? error.code
        : `unexpected:${String(error)}`,
  );

async function runningJob() {
  const processed = await processedRecording(db.app, db.actors, 1);
  await db.owner.query("ALTER TABLE jobs DISABLE TRIGGER USER");
  await db.owner.query("UPDATE jobs SET state = 'running' WHERE id = $1", [
    processed.jobId,
  ]);
  await db.owner.query("ALTER TABLE jobs ENABLE TRIGGER USER");
  return processed;
}

before(async () => {
  db = await transportDatabase();
  deps = depsFor(db, await realProvider());
  const processed = await runningJob();
  job = { kind: "job", jobId: processed.jobId };
  recordingId = processed.recordingId;
});
after(async () => {
  await db.close();
});

const output = (slot: string, over: object = {}) => ({
  slot,
  role: "clip_mp4" as const,
  sizeBytes: "10",
  sha256: sha(slot),
  ...over,
});

test("worker outputs use multipart even when tiny, under server-chosen job keys", async () => {
  const plan = await allocateJobOutput(deps, job, output("clips/0001/rgb.mp4"));
  // Output plans are the published http.output-plan.v1 (output roles); the
  // source http.upload-plan.v1 stays source-role only and refuses them.
  assert.equal(validateValue("http.output-plan.v1", plan).valid, true);
  assert.equal(validateValue("http.upload-plan.v1", plan).valid, false);
  assert.equal(plan.role, "clip_mp4");
  assert.equal(plan.recordingId, recordingId);
  assert.equal(plan.partCount, 1);
  const row = await db.owner.query<{
    object_key: string;
    provider_upload_id: string;
    job_id: string;
    purpose: string;
  }>(
    "SELECT object_key, provider_upload_id, job_id, purpose FROM files WHERE id = $1",
    [plan.fileId],
  );
  assert.equal(
    row.rows[0]!.object_key,
    `jobs/${job.jobId}/outputs/${plan.fileId}/e1/clips/0001/rgb.mp4`,
  );
  assert.equal((await uploadsAt(row.rows[0]!.object_key)).length, 1);
  const [part] = (
    await signParts(deps, job, plan.fileId, {
      expectedTransportEpoch: 1,
      partNumbers: [1],
    })
  ).parts;
  const body = Buffer.from("0123456789");
  const put = await putPart(part!, body);
  const receipt = { partNumber: 1, etag: put.etag!, sizeBytes: "10" };
  assert.equal(
    (
      await journalReceipts(deps, job, plan.fileId, {
        expectedTransportEpoch: 1,
        receipts: [receipt],
      })
    ).journaled.length,
    1,
  );
  const bytes = await completeAndRead(
    row.rows[0]!.object_key,
    row.rows[0]!.provider_upload_id,
    [{ partNumber: 1, etag: put.etag! }],
  );
  assert.equal(bytes.toString(), "0123456789");
  // Idempotent per slot, same file; different content in the slot conflicts.
  const replay = await allocateJobOutput(
    deps,
    job,
    output("clips/0001/rgb.mp4"),
  );
  assert.equal(replay.fileId, plan.fileId);
  assert.equal(
    await code(
      allocateJobOutput(
        deps,
        job,
        output("clips/0001/rgb.mp4", { sizeBytes: "11" }),
      ),
    ),
    "conflict",
  );
  await writeArtifact("transport-output-evidence.json", {
    plan,
    key: row.rows[0]!.object_key,
  });
});

test("workers cannot choose keys, escape the job prefix or use bad roles", async () => {
  for (const slot of [
    "../x",
    "/abs",
    "a//b",
    "a/./b",
    "a/../b",
    "a b",
    "a\\b",
    "",
    "..",
  ])
    assert.equal(
      await code(allocateJobOutput(deps, job, output(slot))),
      "invalid_request",
      slot,
    );
  assert.equal(
    await code(
      allocateJobOutput(deps, job, output("ok", { role: "source_mcap" })),
    ),
    "invalid_request",
  );
  assert.equal(
    await code(allocateJobOutput(deps, job, output("ok", { sha256: "XYZ" }))),
    "invalid_request",
  );
  assert.equal(
    await code(
      allocateJobOutput(deps, job, output("ok", { sizeBytes: "34359738369" })),
    ),
    "invalid_request",
  );
  // The HTTP layer rejects client-supplied key/bucket/owner fields outright.
  const handlers = transportHandlers(deps);
  for (const extra of [
    { key: "x" },
    { objectKey: "x" },
    { bucket: "b" },
    { jobId: randomUUID() },
    { ownerUserId: "u" },
  ]) {
    const response = await handlers.createJobOutput(
      new Request("http://x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...output("fields/ok"), ...extra }),
      }),
      job,
    );
    assert.equal(response.status, 400, JSON.stringify(extra));
  }
  const keys = await db.owner.query<{ object_key: string }>(
    "SELECT object_key FROM files WHERE job_id = $1 AND purpose = 'output' AND object_key NOT LIKE $2",
    [job.jobId, `jobs/${job.jobId}/outputs/%`],
  );
  assert.equal(keys.rowCount, 0);
});

test("credentials are kind- and job-bound; finished or cancelled jobs lose authority", async () => {
  const plan = await allocateJobOutput(deps, job, output("scoped/a.bin"));
  const sign = (who: Authority) =>
    code(
      signParts(deps, who, plan.fileId, {
        expectedTransportEpoch: 1,
        partNumbers: [1],
      }),
    );
  assert.equal(await sign(job), "ok");
  // Another job's worker and a human owner can never touch this output.
  const other = await runningJob();
  assert.equal(await sign({ kind: "job", jobId: other.jobId }), "forbidden");
  const session = await openSession(db, db.actors.collector);
  assert.equal(
    await sign({
      kind: "owner",
      userId: db.actors.collector,
      sessionId: session,
    }),
    "forbidden",
  );
  assert.equal(await sign({ kind: "job", jobId: randomUUID() }), "forbidden");
  assert.equal(
    await code(
      getUploadPlan(deps, { kind: "job", jobId: other.jobId }, plan.fileId),
    ),
    "forbidden",
  );
  // Cancellation request or a past deadline revokes the right to mint URLs or write.
  await db.owner.query(
    "UPDATE jobs SET state = 'cancel_requested' WHERE id = $1",
    [job.jobId],
  );
  assert.equal(await sign(job), "forbidden");
  assert.equal(
    await code(allocateJobOutput(deps, job, output("scoped/b.bin"))),
    "forbidden",
  );
  await db.owner.query("UPDATE jobs SET state = 'running' WHERE id = $1", [
    job.jobId,
  ]);
  assert.equal(await sign(job), "ok");
  await db.owner.query(
    "UPDATE jobs SET execution_deadline = now() - interval '1 second' WHERE id = $1",
    [job.jobId],
  );
  assert.equal(await sign(job), "forbidden");
  await db.owner.query(
    "UPDATE jobs SET execution_deadline = NULL WHERE id = $1",
    [job.jobId],
  );
  // A stale worker (previous job) cannot reserve into a new job's prefix.
  assert.equal(
    await code(
      allocateJobOutput(
        deps,
        { kind: "job", jobId: randomUUID() },
        output("x/y"),
      ),
    ),
    "forbidden",
  );
});

test("per-file, per-job byte and file-count caps bound the output inventory", async () => {
  const processed = await runningJob();
  const worker: Authority = { kind: "job", jobId: processed.jobId };
  const GiB32 = "34359738368";
  await allocateJobOutput(
    deps,
    worker,
    output("big/1", { sizeBytes: GiB32, sha256: sha("1") }),
  );
  await allocateJobOutput(
    deps,
    worker,
    output("big/2", { sizeBytes: "34359737368", sha256: sha("2") }),
  );
  assert.equal(
    await code(
      allocateJobOutput(
        deps,
        worker,
        output("big/3", { sizeBytes: "2000", sha256: sha("3") }),
      ),
    ),
    "conflict",
  );
  // Count cap: fill to 512 live outputs directly, then one more is refused.
  const filler = await runningJob();
  await db.owner.query(
    `INSERT INTO files (id, recording_id, job_id, purpose, role, size_bytes, sha256, object_key, part_size_bytes, part_count)
     SELECT g.id, $2::uuid, $1::uuid, 'output', 'clip_mp4', 1, repeat('a', 64),
            'jobs/' || $1 || '/outputs/' || g.id || '/e1/filler', 67108864, 1
     FROM (SELECT gen_random_uuid() AS id FROM generate_series(1, 512)) g`,
    [filler.jobId, filler.recordingId],
  );
  const live = await db.owner.query(
    "SELECT count(*)::int AS n FROM files WHERE job_id = $1 AND purpose = 'output' AND state NOT IN ('cancelled','failed','expired')",
    [filler.jobId],
  );
  assert.ok(live.rows[0].n >= 512);
  assert.equal(
    await code(
      allocateJobOutput(
        deps,
        { kind: "job", jobId: filler.jobId },
        output("one/more"),
      ),
    ),
    "conflict",
  );
  assert.ok(recordingId);
  void newRecording;
});
