import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { advanceResult } from "../src/acceptance/service.js";
import {
  listReviewRecordings,
  loadRecordingAnnotations,
  loadReviewExtras,
} from "../src/annotations/annotations.js";
import { recordingAnnotationRoutes } from "../src/annotations/http.js";
import type { ReadSigner } from "../src/datasets/broker.js";
import type { DatasetAuthenticate } from "../src/datasets/http.js";
import { createDatasetRecord } from "../src/datasets/mutations.js";
import {
  clearReviewClips,
  grantDatasetAccess,
  recordSharingPermission,
} from "../src/datasets/operator.js";
import { listReviewDatasetClips } from "../src/datasets/review-queries.js";
import { materializeReviewClipVideo } from "../src/datasets/review-video-backfill.js";
import { issueReviewClipVideo } from "../src/datasets/review-video.js";
import { closeOwnerPools, expectCode } from "./harness.js";
import { recipeJob, runRecipe, seal, type Scenario } from "./recipe-harness.js";
import { realS3, s3Config } from "./transport-harness.js";

/**
 * SA-98 annotations reader, staff routes and the recording_mp4 broker role on
 * real PostgreSQL rows (restricted application role) and real object storage:
 * a recipe job runs through the real services (segment, caption, hand_pose seal
 * with one clip), its documents are uploaded and read back through the bounded
 * storage reader, and nothing is visible before the job is accepted.
 */
const CLIP = { sourceStartNs: "8000000000", sourceEndNs: "16000000000" };
let s: Scenario;
let run: Awaited<ReturnType<typeof runRecipe>>;
const signed: { key: string; expiresInSeconds: number; contentType: string }[] =
  [];
const signer: ReadSigner = {
  presignRead: async (request) => {
    signed.push(request);
    return `https://objects.test/${encodeURIComponent(request.key)}?sig=1`;
  },
};
const authenticate: DatasetAuthenticate = async (request, need) => {
  assert.equal(need, "staff");
  const userId = request.headers.get("x-test-user");
  if (!userId)
    return {
      ok: false,
      response: Response.json(
        { error: { code: "unauthenticated" } },
        { status: 401 },
      ),
    };
  const { rows } = await s.db.owner.query(
    "SELECT 1 FROM access WHERE user_id = $1 AND enabled AND role = 'staff'",
    [userId],
  );
  if (!rows.length)
    return {
      ok: false,
      response: Response.json(
        { error: { code: "forbidden" } },
        { status: 403 },
      ),
    };
  return { ok: true, principal: { userId } };
};
const routes = (maxBytes?: number) =>
  recordingAnnotationRoutes({
    pool: s.db.app,
    reader: s.accept.reader,
    signer,
    authenticate,
    ...(maxBytes ? { recordingMp4MaxBytes: maxBytes } : {}),
  });
const get = (user: string | null, id: string, query = "") =>
  routes().annotations(
    new Request(`http://x/api/v1/recordings/${id}/annotations${query}`, {
      headers: user ? { "x-test-user": user } : {},
    }),
    id,
  );
const mp4 = (user: string | null, id: string, body: unknown, max?: number) =>
  routes(max).read(
    new Request(`http://x/api/v1/recordings/${id}/reads`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(user ? { "x-test-user": user } : {}),
      },
      body: JSON.stringify(body),
    }),
    id,
  );
const staff = () => s.db.actors.staff;

before(async () => {
  s = await recipeJob();
  run = await runRecipe(s, () => {}, { clip: CLIP });
});
after(async () => {
  await closeOwnerPools();
  await s.db.close();
});

test("nothing is visible before the job is accepted", async () => {
  assert.equal(
    await loadRecordingAnnotations(
      { pool: s.db.app, reader: s.accept.reader },
      staff(),
      s.recordingId,
    ),
    null,
  );
  assert.equal((await get(staff(), s.recordingId)).status, 404);
  assert.equal(
    (await mp4(staff(), s.recordingId, { role: "recording_mp4" })).status,
    404,
  );
  assert.deepEqual(await listReviewRecordings(s.db.app, staff()), []);
  assert.equal(
    await loadReviewExtras(s.db.app, staff(), s.recordingId, s.jobId),
    null,
  );
  await seal(s, run);
  const ack = await advanceResult(s.accept, s.jobId);
  assert.equal(ack?.candidateStatus, "accepted");
});

test("the accepted job's documents come back validated, with its recipe run", async () => {
  const doc = await loadRecordingAnnotations(
    { pool: s.db.app, reader: s.accept.reader },
    staff(),
    s.recordingId,
  );
  assert.ok(doc);
  assert.equal(doc.schema, "stateaction.recording-annotations.v1");
  assert.equal(doc.job_id, s.jobId);
  assert.equal(doc.recording_id, s.recordingId);
  assert.equal(doc.segments?.job_id, s.jobId);
  assert.ok(doc.segments && doc.segments.rows.length > 0);
  assert.ok(doc.captions?.rows.some((r) => r.status === "failed"));
  assert.ok(doc.hand_presence?.lanes.left.length);
  assert.deepEqual(
    doc.dag_run?.stages.map((n) => [n.stage, n.state]),
    [
      ["segment", "succeeded"],
      ["caption", "succeeded"],
      ["hand_pose", "succeeded"],
    ],
  );
});

test("GET annotations: staff envelope, identical download attachment, denials", async () => {
  const ok = await get(staff(), s.recordingId);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("cache-control")!, /no-store/);
  const { data, requestId } = await ok.json();
  assert.ok(requestId);
  assert.equal(data.job_id, s.jobId);

  const dl = await get(staff(), s.recordingId, "?download=1");
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("content-type"), "application/json");
  assert.equal(
    dl.headers.get("content-disposition"),
    `attachment; filename="annotations-${s.recordingId}.json"`,
  );
  const body = await dl.json();
  assert.ok(!("data" in body), "the download is the document, not an envelope");
  // Same document except the recipe run's render time.
  const strip = (d: any) => ({
    ...d,
    dag_run: { ...d.dag_run, renderedAt: "" },
  });
  assert.deepEqual(strip(body), strip(data));

  const { actors } = s.db;
  for (const [res, status] of [
    [await get(actors.customer, s.recordingId), 403],
    [await get(actors.collector, s.recordingId), 403],
    [await get(null, s.recordingId), 401],
    [await get(staff(), "99999999-9999-4999-8999-999999999999"), 404],
    [await get(staff(), "not-a-uuid"), 404],
  ] as const)
    assert.equal(res.status, status);
});

test("review list and extras: the accepted recording, its clip and its video", async () => {
  const list = await listReviewRecordings(s.db.app, staff());
  assert.deepEqual(
    list.map((r) => r.recordingId),
    [s.recordingId],
  );
  assert.deepEqual(
    await listReviewRecordings(s.db.app, s.db.actors.customer),
    [],
  );
  const extras = await loadReviewExtras(
    s.db.app,
    staff(),
    s.recordingId,
    s.jobId,
  );
  assert.equal(extras?.hasVideo, true);
  assert.deepEqual(
    extras?.clips.map((c) => [c.startNs, c.endNs]),
    [[CLIP.sourceStartNs, CLIP.sourceEndNs]],
  );
  assert.equal(
    await loadReviewExtras(
      s.db.app,
      s.db.actors.customer,
      s.recordingId,
      s.jobId,
    ),
    null,
  );
  // Extras of another job than the one the annotations came from are refused.
  assert.equal(
    await loadReviewExtras(
      s.db.app,
      staff(),
      s.recordingId,
      "99999999-9999-4999-8999-999999999999",
    ),
    null,
  );
});

test("recording_mp4 read: staff, video/mp4, 60 s, bounded, accepted job's file only", async () => {
  signed.length = 0;
  const ok = await mp4(staff(), s.recordingId, { role: "recording_mp4" });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("cache-control")!, /no-store/);
  const { data } = await ok.json();
  assert.equal(data.role, "recording_mp4");
  assert.equal(data.contentType, "video/mp4");
  assert.equal(data.ttlSeconds, 60);
  const key = (
    await s.db.owner.query<{ object_key: string }>(
      "SELECT object_key FROM files WHERE id = $1",
      [run.mp4.fileId],
    )
  ).rows[0]!.object_key;
  assert.deepEqual(signed, [
    { key, expiresInSeconds: 60, contentType: "video/mp4" },
  ]);

  const before = signed.length;
  const { actors } = s.db;
  const bad: [string, Response, number][] = [
    [
      "customer",
      await mp4(actors.customer, s.recordingId, { role: "recording_mp4" }),
      403,
    ],
    [
      "no session",
      await mp4(null, s.recordingId, { role: "recording_mp4" }),
      401,
    ],
    [
      "unknown recording",
      await mp4(staff(), "99999999-9999-4999-8999-999999999999", {
        role: "recording_mp4",
      }),
      404,
    ],
    [
      "clip role",
      await mp4(staff(), s.recordingId, { role: "viewer_rrd" }),
      400,
    ],
    ["no role", await mp4(staff(), s.recordingId, {}), 400],
    [
      "above the limit",
      await mp4(staff(), s.recordingId, { role: "recording_mp4" }, 5),
      409,
    ],
  ];
  for (const [name, res, status] of bad) assert.equal(res.status, status, name);
  assert.equal(signed.length, before, "nothing was signed for a refused read");
});

test("an approved legacy whole-recording clip plays the selected verified MP4", async () => {
  const datasetId = randomUUID();
  const { pool } = s.accept;
  const clipId = s.recordingId;
  const {
    rows: [selected],
  } = await pool.query<{
    manifest: string;
    seq: number;
    key: string;
  }>(
    `SELECT j.result_manifest_sha256 AS manifest, sel.seq, f.object_key AS key
       FROM review_clips c
       JOIN clip_plans p ON p.recording_id = c.recording_id AND p.version = c.plan_version
       JOIN jobs j ON j.id = c.selected_job_id
       JOIN clip_result_selections sel ON sel.clip_id = c.id AND sel.job_id = j.id
       JOIN files f ON f.job_id = j.id AND f.role = 'recording_mp4'
       WHERE c.id = $1 AND j.id = $2 AND j.kind = 'process_recording'
         AND c.start_ordinal IS NULL AND p.plan_job_id IS NULL
         AND f.id = $3 AND f.state = 'verified'`,
    [clipId, s.jobId, run.mp4.fileId],
  );
  assert.ok(selected);
  await createDatasetRecord(pool, {
    actorUserId: staff(),
    datasetId,
    name: "Legacy playback",
  });
  await pool.query(
    `INSERT INTO review_clip_decisions
       (id, clip_id, job_id, result_manifest_sha256, selection_revision, revision,
        reviewer_user_id, decision, task_label)
     VALUES ($1, $2, $3, $4, $5, 1, $6, 'approved', 'Review test')`,
    [randomUUID(), clipId, s.jobId, selected.manifest, selected.seq, staff()],
  );
  await pool.query(
    `INSERT INTO dataset_review_clips
       (dataset_id, clip_id, job_id, result_manifest_sha256, selection_revision, added_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [datasetId, clipId, s.jobId, selected.manifest, selected.seq, staff()],
  );

  const input = {
    viewerUserId: staff(),
    datasetId,
    clipId,
    expectedSelection: {
      jobId: s.jobId,
      resultManifestSha256: selected.manifest,
      selectionRevision: selected.seq,
    },
  };
  const listed = await listReviewDatasetClips(pool, input);
  assert.equal(listed.items[0]?.hasVideo, true);
  signed.length = 0;
  const broker = { pool, signer };
  const video = await issueReviewClipVideo(broker, input);
  assert.equal(video.role, "clip_mp4");
  assert.equal(video.sizeBytes, String(run.mp4.size));
  await expectCode(
    issueReviewClipVideo(broker, {
      ...input,
      viewerUserId: s.db.actors.customer,
    }),
    "not_found",
  );
  await expectCode(
    issueReviewClipVideo(broker, {
      ...input,
      expectedSelection: {
        ...input.expectedSelection,
        selectionRevision: selected.seq + 1,
      },
    }),
    "not_found",
  );
  const permissionRef = "legacy-playback-test";
  await recordSharingPermission(s.db.owner, {
    permissionRef,
    datasetId,
    recipientUserId: s.db.actors.customer,
    evidenceRef: "test:legacy-playback",
    recordedBy: "test",
  });
  await clearReviewClips(s.db.owner, {
    permissionRef,
    allCurrentMembers: true,
    clearedBy: "test",
  });
  await grantDatasetAccess(s.db.owner, { permissionRef, actorUserId: staff() });
  const customer = { ...input, viewerUserId: s.db.actors.customer };
  assert.equal(
    (await listReviewDatasetClips(pool, customer)).items[0]?.hasVideo,
    true,
  );
  assert.equal((await issueReviewClipVideo(broker, customer)).url, video.url);
  assert.deepEqual(signed, [
    { key: selected.key, expiresInSeconds: 60, contentType: "video/mp4" },
    { key: selected.key, expiresInSeconds: 60, contentType: "video/mp4" },
  ]);

  assert.deepEqual(
    await materializeReviewClipVideo(
      {
        pool: s.db.owner,
        client: realS3(),
        bucket: s3Config().bucket,
        python: "/unused/python",
      },
      s.jobId,
    ),
    { jobId: s.jobId, sha256: run.mp4.sha, alreadyAvailable: true },
  );
});

test("a deleted recording disappears from every review read", async () => {
  await s.db.owner.query(
    "UPDATE recordings SET deleted_at = now() WHERE id = $1",
    [s.recordingId],
  );
  assert.equal((await get(staff(), s.recordingId)).status, 404);
  assert.equal(
    (await mp4(staff(), s.recordingId, { role: "recording_mp4" })).status,
    404,
  );
  assert.deepEqual(await listReviewRecordings(s.db.app, staff()), []);
});
