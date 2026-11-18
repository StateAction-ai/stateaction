import { fixtureAcceptResult } from "../src/jobs/fixtures.js";
import { ownerPoolFor } from "./harness.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  getPipelineDetail,
  listPipelineRecordings,
  pipelineActionsFor,
} from "../src/pipeline/queries.js";
import { parsePipelineQuery } from "../src/pipeline/model.js";
import {
  closeOwnerPools,
  createActors,
  freshDatabase,
  processedRecording,
  type Actors,
  type Processed,
  type TestDb,
} from "./harness.js";

/**
 * SA-34 Pipeline reads on real PostgreSQL rows, as the restricted app role:
 * list/filter/search, detail stages, review-clips capability and role guard.
 */
let db: TestDb;
let actors: Actors;
let processing: Processed;
let completed: Processed;
let failed: Processed;
const query = (over: Record<string, string> = {}) => parsePipelineQuery(over);

before(async () => {
  db = await freshDatabase();
  actors = await createActors(db.owner);
  await db.owner.query(
    `UPDATE "user" SET name = 'Maya Collector' WHERE id = $1`,
    [actors.collector],
  );
  completed = await processedRecording(db.app, actors, 2);
  await fixtureAcceptResult(ownerPoolFor(db.app), db.app, {
    jobId: completed.jobId,
    manifestFileId: completed.manifestFileId,
    manifestSha256: completed.manifestSha256,
    clips: completed.clips,
  });
  failed = await processedRecording(db.app, actors, 1);
  await db.app.query(
    `UPDATE jobs SET state = 'failed', error_code = 'source_checksum_mismatch',
       error_message = 'bad bytes at /srv/objects/jobs/x/outputs/y.bin', finished_at = now()
     WHERE id = $1`,
    [failed.jobId],
  );
  // Seed the in-flight job last so a later fixture cannot retire it.
  processing = await processedRecording(db.app, actors, 1); // result_pending
});
after(async () => {
  await closeOwnerPools();
  await db.close();
});

test("non-staff roles read nothing, even by direct call", async () => {
  for (const user of [actors.customer, actors.collector, "nobody"]) {
    const list = await listPipelineRecordings(db.app, user, query());
    assert.equal(list.items.length, 0);
    assert.equal(
      await getPipelineDetail(db.app, user, completed.recordingId),
      null,
    );
  }
});

test("staff list classifies real recordings and filters by status", async () => {
  const all = await listPipelineRecordings(db.app, actors.staff, query());
  assert.equal(all.items.length, 3);
  const byId = new Map(all.items.map((i) => [i.id, i]));
  assert.equal(byId.get(processing.recordingId)?.status, "processing");
  assert.equal(byId.get(completed.recordingId)?.status, "completed");
  assert.equal(byId.get(completed.recordingId)?.note, "2 clips");
  assert.equal(byId.get(failed.recordingId)?.status, "failed");
  assert.equal(byId.get(failed.recordingId)?.collector, "Maya Collector");
  assert.match(byId.get(failed.recordingId)?.source ?? "", /MCAP/);
  assert.equal(all.counts.completed, 1);
  assert.equal(all.counts.failed, 1);
  const onlyFailed = await listPipelineRecordings(
    db.app,
    actors.staff,
    query({ status: "failed" }),
  );
  assert.deepEqual(
    onlyFailed.items.map((i) => i.id),
    [failed.recordingId],
  );
});

test("search matches the collector and treats wildcards literally", async () => {
  const hit = await listPipelineRecordings(
    db.app,
    actors.staff,
    query({ q: "maya" }),
  );
  assert.equal(hit.items.length, 3);
  for (const q of ["no-such-person", "%", "_", "\\"]) {
    const miss = await listPipelineRecordings(
      db.app,
      actors.staff,
      query({ q }),
    );
    assert.equal(miss.items.length, 0, q);
  }
});

test("list rows expose no ids chips, owner ids, emails or paths", async () => {
  const all = await listPipelineRecordings(db.app, actors.staff, query());
  const text = JSON.stringify(all.items.map(({ id: _id, ...rest }) => rest));
  assert.doesNotMatch(
    text,
    /@example\.test|ba_|recordings\/|jobs\/|[0-9a-f]{8}-[0-9a-f]{4}-/,
  );
});

test("detail: completed recording offers Review clips for the current job", async () => {
  const detail = await getPipelineDetail(
    db.app,
    actors.staff,
    completed.recordingId,
  );
  assert.ok(detail);
  assert.equal(detail.status, "completed");
  assert.deepEqual(
    detail.stages.map((s) => s.state),
    ["done", "done", "done", "done", "done"],
  );
  const actions = await pipelineActionsFor(detail);
  assert.equal(
    actions.reviewClipsHref,
    `/data-browser?recordingId=${completed.recordingId}`,
  );
  assert.deepEqual(actions.control, []);
});

test("detail: in-flight recording keeps quality checks unknown", async () => {
  const detail = await getPipelineDetail(
    db.app,
    actors.staff,
    processing.recordingId,
  );
  assert.ok(detail);
  assert.equal(detail.status, "processing");
  assert.equal(detail.stages[3]?.state, "unknown");
  assert.equal((await pipelineActionsFor(detail)).reviewClipsHref, null);
});

test("a succeeded historical job supplies neither status evidence nor Review clips", async () => {
  await db.owner.query(
    "UPDATE recordings SET current_job_id = NULL WHERE id = $1",
    [completed.recordingId],
  );
  try {
    const detail = await getPipelineDetail(
      db.app,
      actors.staff,
      completed.recordingId,
    );
    assert.ok(detail);
    assert.equal(detail.status, "needs_attention");
    assert.equal(detail.jobId, null);
    assert.equal(detail.jobState, null);
    assert.equal(detail.clipCount, null);
    assert.deepEqual(
      detail.stages.map((stage) => stage.state),
      ["done", "active", "not_started", "not_started", "not_started"],
    );
    assert.equal((await pipelineActionsFor(detail)).reviewClipsHref, null);
    const filtered = await listPipelineRecordings(
      db.app,
      actors.staff,
      query({ status: "completed" }),
    );
    assert.equal(filtered.counts.completed, 0);
    assert.equal(filtered.items.length, 0);
  } finally {
    await db.owner.query(
      "UPDATE recordings SET current_job_id = $2 WHERE id = $1",
      [completed.recordingId, completed.jobId],
    );
  }
});

test("detail: a known failure shows a curated error and no review link", async () => {
  const detail = await getPipelineDetail(
    db.app,
    actors.staff,
    failed.recordingId,
  );
  assert.ok(detail);
  assert.equal(detail.status, "failed");
  assert.deepEqual(detail.error, { summary: "Source checksum mismatch" });
  assert.doesNotMatch(JSON.stringify(detail), /bad bytes|\/srv\//);
  assert.equal(detail.stages[2]?.state, "failed");
  assert.equal((await pipelineActionsFor(detail)).reviewClipsHref, null);
});

test("unknown worker error codes and messages are absent from list and detail", async () => {
  const unrecognized = await processedRecording(db.app, actors, 1);
  await db.app.query(
    `UPDATE jobs SET state = 'failed', error_code = $2, error_message = $3,
       finished_at = now() WHERE id = $1`,
    [
      unrecognized.jobId,
      "confidential_fixture_code",
      "Confidential fixture message",
    ],
  );
  const detail = await getPipelineDetail(
    db.app,
    actors.staff,
    unrecognized.recordingId,
  );
  assert.ok(detail);
  assert.deepEqual(detail.error, {
    summary: "Failure details are unavailable",
  });
  const list = await listPipelineRecordings(
    db.app,
    actors.staff,
    query({ status: "failed" }),
  );
  const item = list.items.find(
    (recording) => recording.id === unrecognized.recordingId,
  );
  assert.equal(item?.note, "Failure details are unavailable");
  assert.doesNotMatch(JSON.stringify({ detail, item }), /confidential/i);
});

test("detail: unknown recording is null", async () => {
  assert.equal(
    await getPipelineDetail(db.app, actors.staff, randomUUID()),
    null,
  );
});
