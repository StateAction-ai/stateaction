import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { requestSha256 } from "@stateaction/contracts";
import pg from "pg";
import { grantHostedReader } from "../../../scripts/platform/provision-hosted-reader.mjs";
import { advanceResult } from "../src/acceptance/service.js";
import {
  CAPTURE_SOURCES,
  captureRecipeDefinition,
} from "../src/admission/capture-profiles.js";
import {
  loadBoundClipAnnotations,
  loadRecordingAnnotations,
  loadReviewExtras,
} from "../src/annotations/annotations.js";
import { inTransaction } from "../src/catalog/catalog.js";
import {
  getAuthorizedReviewClip,
  listReviewDatasetClips,
  listReviewDatasets,
} from "../src/datasets/review-queries.js";
import { getClipReviewStateV2 } from "../src/datasets/review.js";
import { ensureAppRole } from "../src/migrations.js";
import { parsePipelineQuery } from "../src/pipeline/model.js";
import { listPipelineRecordings } from "../src/pipeline/queries.js";
import {
  getClipOperations,
  getRecordingOperations,
} from "../src/pipeline/recording-operations.js";
import {
  getRecipeDefinition,
  listRecipeCatalog,
} from "../src/pipeline/recipe-catalog.js";
import { claimRole, expectRole } from "./fixture-ledger.js";
import {
  captionsDoc,
  recipeJob,
  runRecipe,
  seal,
  segmentsDoc,
} from "./recipe-harness.js";

test("the provisioned hosted reader can browse and review with staff access", async (t) => {
  const s = await recipeJob({}, (db) => t.after(() => db.close()));
  const { owner, ownerUrl, actors } = s.db;
  const run = await runRecipe(s, () => {}, {
    clip: { sourceStartNs: "8000000000", sourceEndNs: "16000000000" },
  });
  await seal(s, run);
  assert.equal(
    (await advanceResult(s.accept, s.jobId))?.candidateStatus,
    "accepted",
  );

  const capture = CAPTURE_SOURCES[0];
  const recipeId = capture.defaultRecipeId;
  const recipe = captureRecipeDefinition(recipeId);
  assert.ok(recipe);
  await owner.query(
    `INSERT INTO recording_capture_profiles
       (recording_id, source_manifest_sha256, state, capture_source_id,
        allowed_recipe_ids, recipe_id, recipe_sha256, recipe, evidence)
     VALUES ($1, $2, 'selected', $3, $4, $5, $6, $7, '{"device":{"model":"fixture phone"}}')`,
    [
      s.recordingId,
      s.sourceManifestSha256,
      capture.id,
      [recipeId],
      recipeId,
      requestSha256(recipe),
      recipe,
    ],
  );

  // Cluster-global logins use a unique name so parallel fixture runs remain isolated.
  const role = "sa_hosted_reader_" + randomBytes(6).toString("hex");
  const password = randomBytes(32).toString("base64url");
  expectRole(role);
  await inTransaction(owner, async (tx) => {
    await ensureAppRole(tx, password, role);
    await claimRole(tx, role);
    await grantHostedReader(tx, role);
  });
  const readerUrl = new URL(ownerUrl);
  readerUrl.username = role;
  readerUrl.password = password;
  const reader = new pg.Pool({
    connectionString: readerUrl.toString(),
    max: 2,
  });
  t.after(() => reader.end());
  assert.deepEqual(
    (
      await reader.query(
        "SELECT current_user, current_setting('transaction_read_only') AS read_only",
      )
    ).rows,
    [{ current_user: role, read_only: "on" }],
  );

  const { staff, customer } = actors;
  const datasetId = "pending-review";
  assert.ok(
    (await listReviewDatasets(reader, { viewerUserId: staff })).some(
      (dataset) => dataset.datasetId === datasetId,
    ),
  );
  const browse = { datasetId, viewerUserId: staff };
  const caption = captionsDoc(s, segmentsDoc(s), run.segFile.sha).rows[0];
  assert.ok(caption?.text);
  const results = await listReviewDatasetClips(reader, {
    ...browse,
    q: caption.text,
  });
  assert.equal(results.items[0]?.clipId, s.recordingId);
  assert.equal(results.items[0]?.captionMatch?.segmentId, caption.segment_id);
  const binding = await getAuthorizedReviewClip(reader, {
    ...browse,
    clipId: s.recordingId,
  });
  assert.ok(binding);
  assert.equal(binding.jobId, s.jobId);
  const state = await getClipReviewStateV2(reader, {
    viewerUserId: staff,
    clipId: binding.clipId,
    selectionRevision: binding.selectionRevision,
  });
  assert.equal(state.review.revision, 0);
  assert.equal(
    await getAuthorizedReviewClip(reader, {
      ...browse,
      viewerUserId: customer,
      clipId: s.recordingId,
    }),
    null,
  );

  const query = parsePipelineQuery({});
  const list = await listPipelineRecordings(reader, staff, query, true);
  assert.equal(list.items[0]?.id, s.recordingId);
  const recording = await getRecordingOperations(
    reader,
    staff,
    s.recordingId,
    true,
  );
  assert.equal(
    recording?.captureProfile?.evidence.device.model,
    "fixture phone",
  );
  assert.equal(recording?.clips[0]?.selectedJobId, s.jobId);
  const clip = await getClipOperations(
    reader,
    staff,
    s.recordingId,
    s.recordingId,
  );
  assert.equal(clip?.clip.selectedJobId, s.jobId);
  assert.equal(
    await getRecordingOperations(reader, customer, s.recordingId, true),
    null,
  );

  const catalog = await listRecipeCatalog(reader, staff);
  assert.equal(
    catalog.recipes.find((entry) => entry.id === recipeId)?.recordingCount,
    1,
  );
  const definition = await getRecipeDefinition(reader, staff, recipeId);
  assert.equal(definition?.recordings[0]?.recordingId, s.recordingId);
  assert.equal(await getRecipeDefinition(reader, customer, recipeId), null);

  const deps = { pool: reader, reader: s.accept.reader };
  const annotations = await loadRecordingAnnotations(
    deps,
    staff,
    s.recordingId,
  );
  assert.equal(annotations?.dag_run?.jobId, s.jobId);
  assert.ok(annotations?.captions?.rows.length);
  assert.equal(
    (await loadBoundClipAnnotations(deps, binding))?.job_id,
    s.jobId,
  );
  assert.ok(await loadReviewExtras(reader, staff, s.recordingId, s.jobId));
  assert.equal(
    await loadRecordingAnnotations(deps, customer, s.recordingId),
    null,
  );

  const writable = await reader.connect();
  try {
    await writable.query("BEGIN READ WRITE");
    await assert.rejects(
      writable.query(
        "UPDATE recording_capture_profiles SET evidence = evidence WHERE false",
      ),
      { code: "42501" },
    );
    await writable.query("ROLLBACK");
    await assert.rejects(
      writable.query("SELECT cleared_by FROM dataset_review_clip_clearances"),
      { code: "42501" },
    );
    await assert.rejects(writable.query("SELECT task_input FROM job_inputs"), {
      code: "42501",
    });
    await assert.rejects(
      writable.query("SELECT source_sha256 FROM review_clip_video_backfills"),
      { code: "42501" },
    );
    await assert.rejects(
      writable.query("SELECT ingest_permission_ok(NULL, NULL, true)"),
      { code: "42501" },
    );
  } finally {
    await writable.query("ROLLBACK");
    writable.release();
  }
});
