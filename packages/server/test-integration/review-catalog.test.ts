import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { indexAcceptedReviewAnnotations } from "../src/acceptance/review-search.js";
import { advanceResult } from "../src/acceptance/service.js";
import { inTransaction } from "../src/catalog/catalog.js";
import {
  commitCaptionCorrection,
  storedCaptionSegments,
} from "../src/datasets/corrections.js";
import { createDatasetRecord } from "../src/datasets/mutations.js";
import {
  clearReviewClips,
  grantDatasetAccess,
  recordSharingPermission,
  revokeSharingPermission,
} from "../src/datasets/operator.js";
import {
  getAuthorizedReviewClip,
  getDatasetReviewClip,
  issueReviewClipPoster,
  listReviewDatasetClips,
  listReviewDatasets,
} from "../src/datasets/review-queries.js";
import { exportReviewDatasetCaptions } from "../src/datasets/review-catalog.js";
import { searchReviewPickerDatasets } from "../src/datasets/review-picker.js";
import { commitClipReviewV2 } from "../src/datasets/review.js";
import { fixtureAcceptResult } from "../src/jobs/fixtures.js";
import {
  createActors,
  expectCode,
  freshDatabase,
  processedRecording,
} from "./harness.js";
import {
  captionsDoc,
  recipeJob,
  runRecipe,
  seal,
  segmentsDoc,
} from "./recipe-harness.js";

test("review browsing scopes selected results, search, membership and signed posters", async (t) => {
  const db = await freshDatabase();
  t.after(() => db.close());
  const actors = await createActors(db.owner);
  const p = await processedRecording(db.app, actors, 1);
  await fixtureAcceptResult(db.owner, db.app, {
    ...p,
    clips: p.clips,
  });
  await db.app.query("UPDATE files SET state = 'verified' WHERE id = $1", [
    p.clips[0]!.files.frameMapJson,
  ]);
  const {
    rows: [thumbnail],
  } = await db.app.query<{ object_key: string }>(
    "UPDATE files SET state = 'verified' WHERE id = $1 RETURNING object_key",
    [p.clips[0]!.files.thumbnailJpeg],
  );
  const selected = (
    await db.owner.query<{ job_id: string }>(
      "SELECT job_id FROM clip_result_selections WHERE clip_id = $1",
      [p.recordingId],
    )
  ).rows[0];
  if (!selected)
    await db.owner.query(
      `INSERT INTO recording_result_selections (recording_id, seq, job_id, reason, kind)
       VALUES ($1, 1, $2, 'Review search fixture', 'auto')`,
      [p.recordingId, p.jobId],
    );
  const segmentId = "0bcb141f-32c5-5a50-8157-a116982af851";
  await inTransaction(db.app, (tx) =>
    indexAcceptedReviewAnnotations(tx, p.jobId, p.manifestSha256, {
      segmentsSha256: "d".repeat(64),
      clockDomain: "test",
      noHandDetected: true,
      segments: [
        {
          segmentId,
          startTsNs: "100",
          text: "Pick up the red mug from the counter",
          label: "Pick red mug",
        },
      ],
    }),
  );
  const pending = await listReviewDatasetClips(db.app, {
    viewerUserId: actors.staff,
    datasetId: "pending-review",
    q: '"red mug" -blue',
    problems: ["no_hand"],
  });
  assert.equal(pending.totalCount, 1);
  assert.equal(pending.filteredCount, 1);
  assert.equal(pending.items[0]?.clipId, p.recordingId);
  assert.equal(pending.items[0]?.captionMatch?.segmentId, segmentId);
  assert.equal(pending.items[0]?.captionMatch?.startTsNs, "100");
  assert.equal(pending.items[0]?.captionMatch?.offsetNs, "100");
  assert.equal(pending.items[0]?.hasVideo, false);
  assert.ok(
    pending.items[0]?.captionMatch?.highlights.some((part) => part.highlighted),
  );
  assert.deepEqual(pending.facets.labels, []);
  assert.deepEqual(pending.facets.problems, [
    { value: "no_hand", label: "no_hand", count: 1 },
  ]);
  const query = { viewerUserId: actors.staff, datasetId: "pending-review" };
  assert.equal(
    (await listReviewDatasetClips(db.app, { ...query, q: 'mug -"red mug"' }))
      .filteredCount,
    0,
  );
  assert.equal(
    (await listReviewDatasetClips(db.app, { ...query, page: 2, limit: 1 }))
      .items.length,
    0,
  );
  await expectCode(
    listReviewDatasetClips(db.app, { ...query, viewerUserId: actors.customer }),
    "not_found",
  );
  const all = { datasetId: "all-clips", recordingIds: [p.recordingId] };
  assert.equal(
    (await listReviewDatasetClips(db.app, { ...query, ...all })).filteredCount,
    1,
  );
  await expectCode(
    listReviewDatasetClips(db.app, { ...all, viewerUserId: actors.customer }),
    "not_found",
  );

  const oldDataset = randomUUID();
  await db.app.query(
    `INSERT INTO datasets (id, name, created_by, updated_by, updated_at)
     VALUES ($1, 'Workshop', $2, $2, now() - interval '1 day')`,
    [oldDataset, actors.staff],
  );
  await db.app.query(
    `INSERT INTO datasets (id, name, created_by, updated_by)
     SELECT gen_random_uuid(), 'Workshop ' || n, $1, $1 FROM generate_series(1, 101) n`,
    [actors.staff],
  );
  const picker = { viewerUserId: actors.staff, clipId: p.recordingId };
  const lookup = await searchReviewPickerDatasets(db.app, {
    ...picker,
    q: "workSHOP",
    ids: [oldDataset],
  });
  assert.equal(lookup.exactMatch, true);
  assert.equal(lookup.matches.length, 50);
  assert.equal(lookup.matches[0]?.datasetId, oldDataset);
  assert.equal(lookup.saved[0]?.datasetId, oldDataset);
  assert.deepEqual(
    (await searchReviewPickerDatasets(db.app, { ...picker, q: "%", ids: [] }))
      .matches,
    [],
  );
  await expectCode(
    searchReviewPickerDatasets(db.app, {
      ...picker,
      viewerUserId: actors.customer,
      q: "Workshop",
      ids: [],
    }),
    "not_found",
  );

  const left = randomUUID();
  const right = randomUUID();
  for (const [datasetId, name] of [
    [left, "Private"],
    [right, "Shared"],
  ] as const)
    await createDatasetRecord(db.app, {
      actorUserId: actors.staff,
      datasetId,
      name,
    });
  await db.app.query(
    `INSERT INTO review_clip_decisions
       (id, clip_id, job_id, result_manifest_sha256, selection_revision, revision,
        reviewer_user_id, decision, task_label, notes)
     VALUES ($1, $2, $3, $4, 1, 1, $5, 'approved', 'Pick up mug', 'Staff-only note')`,
    [randomUUID(), p.recordingId, p.jobId, p.manifestSha256, actors.staff],
  );
  await db.app.query(
    `INSERT INTO dataset_review_clips
       (dataset_id, clip_id, job_id, result_manifest_sha256, selection_revision, added_by)
     SELECT d, $2, $3, $4, 1, $5 FROM unnest($1::uuid[]) d`,
    [[left, right], p.recordingId, p.jobId, p.manifestSha256, actors.staff],
  );
  const permissionRef = "sa150-review-catalog";
  await recordSharingPermission(db.owner, {
    permissionRef,
    datasetId: right,
    recipientUserId: actors.customer,
    evidenceRef: "test:review-catalog",
    recordedBy: "test",
  });
  await clearReviewClips(db.owner, {
    permissionRef,
    allCurrentMembers: true,
    clearedBy: "test",
  });
  await grantDatasetAccess(db.owner, {
    permissionRef,
    actorUserId: actors.staff,
  });
  const customerDatasets = await listReviewDatasets(db.app, {
    viewerUserId: actors.customer,
  });
  assert.deepEqual(
    customerDatasets.map((d) => d.datasetId),
    [right],
  );
  assert.ok(!Object.hasOwn(customerDatasets[0]!, "shareState"));
  const staffDatasets = await listReviewDatasets(db.app, {
    viewerUserId: actors.staff,
  });
  assert.equal(
    staffDatasets.find((d) => d.datasetId === left)?.shareState,
    "private",
  );
  assert.equal(
    staffDatasets.find((d) => d.datasetId === right)?.shareState,
    "shared",
  );
  assert.equal((await listReviewDatasetClips(db.app, query)).totalCount, 0);
  assert.equal(
    (await listReviewDatasetClips(db.app, { ...query, datasetId: left }))
      .totalCount,
    1,
  );

  const customer = {
    viewerUserId: actors.customer,
    datasetId: right,
    clipId: p.recordingId,
  };
  const result = await listReviewDatasetClips(db.app, {
    ...customer,
    labels: ["pick up mug"],
    q: '"red mug"',
  });
  assert.equal(result.totalCount, 1);
  assert.equal(result.filteredCount, 1);
  assert.equal(result.items[0]?.hasPoster, true);
  assert.ok(result.lastUpdatedAt);
  assert.equal(result.items[0]?.title, null);
  for (const q of ["emulator", p.recordingId.slice(0, 8)]) {
    assert.equal(
      (await listReviewDatasetClips(db.app, { ...customer, q })).filteredCount,
      0,
    );
    assert.equal(
      (
        await listReviewDatasetClips(db.app, {
          ...customer,
          q,
          viewerUserId: actors.staff,
        })
      ).filteredCount,
      1,
    );
  }
  await expectCode(
    exportReviewDatasetCaptions(
      db.app,
      {
        ...customer,
        datasetId: left,
      },
      () => assert.fail("Unauthorised export must not read storage"),
    ),
    "not_found",
  );
  const serialized = JSON.stringify(result);
  for (const privateText of [
    p.jobId,
    p.manifestSha256,
    actors.staff,
    "Staff-only note",
    "recordingId",
    "correctedCount",
    "proposedLabel",
    "shareState",
    "problems",
    "poster_key",
  ])
    assert.ok(!serialized.includes(privateText), privateText);
  assert.equal(
    await getDatasetReviewClip(db.app, { ...customer, datasetId: left }),
    null,
  );
  assert.equal(
    await getAuthorizedReviewClip(db.app, {
      viewerUserId: customer.viewerUserId,
      clipId: customer.clipId,
    }),
    null,
  );
  assert.equal(
    (await getAuthorizedReviewClip(db.app, customer))?.jobId,
    p.jobId,
  );

  let signed = 0;
  const broker = {
    pool: db.app,
    signer: {
      async presignRead(request: { key: string; contentType: string }) {
        signed++;
        assert.equal(request.key, thumbnail?.object_key);
        assert.equal(request.contentType, "image/jpeg");
        return "https://objects.invalid/poster";
      },
    },
  };
  assert.equal(
    (await issueReviewClipPoster(broker, customer)).url,
    "https://objects.invalid/poster",
  );
  await db.app.query(
    `INSERT INTO clip_result_selections (clip_id, seq, job_id, selected_by, reason, kind)
     VALUES ($1, 2, $2, $3, 'Fixture reselection', 'manual')`,
    [p.recordingId, p.jobId, actors.staff],
  );
  assert.equal(
    (await listReviewDatasetClips(db.app, { ...query, datasetId: right }))
      .shareState,
    "blocked",
  );
  await expectCode(listReviewDatasetClips(db.app, customer), "not_found");
  assert.equal(await getAuthorizedReviewClip(db.app, customer), null);
  assert.equal((await listReviewDatasetClips(db.app, query)).totalCount, 1);
  await revokeSharingPermission(db.owner, {
    permissionRef,
    revokedBy: "test",
    reason: "Test verification",
  });
  await expectCode(issueReviewClipPoster(broker, customer), "not_found");
  assert.equal(signed, 1);
});

test("accepted caption corrections match effective text only for customers", async (t) => {
  const s = await recipeJob({}, (db) => t.after(() => db.close()));
  const run = await runRecipe(s);
  await seal(s, run);
  assert.equal(
    (await advanceResult(s.accept, s.jobId))?.candidateStatus,
    "accepted",
  );
  const { app, owner, actors } = s.db;
  const clipId = s.recordingId;
  const {
    rows: [result],
  } = await app.query<{
    jobId: string;
    resultManifestSha256: string;
    selectionRevision: number;
  }>(
    `SELECT j.id AS "jobId", j.result_manifest_sha256 AS "resultManifestSha256", rs.seq AS "selectionRevision"
     FROM review_clips c JOIN jobs j ON j.id = c.selected_job_id
     JOIN clip_result_selections rs ON rs.clip_id = c.id AND rs.job_id = j.id
     WHERE c.id = $1 ORDER BY rs.seq DESC LIMIT 1`,
    [clipId],
  );
  assert.ok(result);
  const segments = segmentsDoc(s);
  const segmentsSha256 = run.files.find((f) => f.role === "segments_json")!.sha;
  const caption = captionsDoc(s, segments, segmentsSha256).rows[0]!;
  const segmentId = caption.segment_id;
  const originalQuery = '"' + caption.text.replaceAll('"', "") + '"';
  const pending = await listReviewDatasetClips(app, {
    viewerUserId: actors.staff,
    datasetId: "pending-review",
    q: originalQuery,
  });
  assert.equal(pending.items[0]?.captionMatch?.segmentId, segmentId);

  const datasetId = randomUUID();
  await createDatasetRecord(app, {
    datasetId,
    actorUserId: actors.staff,
    name: "Caption dataset",
  });
  await commitClipReviewV2(app, {
    clipId,
    reviewerUserId: actors.staff,
    command: {
      ...result,
      action: "add",
      commandId: randomUUID(),
      expectedReviewRevision: 0,
      taskLabel: "Demonstration",
      datasetRevisions: { [datasetId]: 1 },
    },
  });
  const permissionRef = "sa150-caption-catalog";
  await recordSharingPermission(owner, {
    permissionRef,
    datasetId,
    recipientUserId: actors.customer,
    evidenceRef: "test:caption-search",
    recordedBy: "test",
  });
  await clearReviewClips(owner, {
    permissionRef,
    allCurrentMembers: true,
    clearedBy: "test",
  });
  await grantDatasetAccess(owner, { permissionRef, actorUserId: actors.staff });
  const customer = { viewerUserId: actors.customer, datasetId };
  const original = await listReviewDatasetClips(app, {
    ...customer,
    q: originalQuery,
  });
  assert.equal(original.filteredCount, 1);
  const source = storedCaptionSegments({ pool: app, reader: s.accept.reader });
  const fields = (expectedRevision: number) => ({
    ...result,
    segmentsSha256,
    correctionId: randomUUID(),
    expectedRevision,
    expectedMarkRevision: expectedRevision,
  });
  const text = "Slide the turquoise tray.";
  await commitCaptionCorrection(app, source, {
    clipId,
    segmentId,
    reviewerUserId: actors.staff,
    command: { ...fields(0), action: "edit", text },
  });
  const corrected = await listReviewDatasetClips(app, {
    ...customer,
    q: "turquoise",
  });
  assert.equal(corrected.items[0]?.captionMatch?.text, text);
  assert.ok(!JSON.stringify(corrected).includes(caption.text));
  assert.ok(corrected.lastUpdatedAt! >= original.lastUpdatedAt!);
  assert.equal(
    (await listReviewDatasetClips(app, { ...customer, q: originalQuery }))
      .filteredCount,
    0,
  );
  const staff = await listReviewDatasetClips(app, {
    ...customer,
    viewerUserId: actors.staff,
    q: originalQuery,
  });
  assert.equal(staff.items[0]?.captionMatch?.alsoMatchesOriginal, true);
  assert.equal(staff.items[0]?.captionMatch?.text, text);
  const other = await processedRecording(app, actors, 1);
  await fixtureAcceptResult(owner, app, other);
  await owner.query(
    `INSERT INTO recording_result_selections (recording_id, seq, job_id, reason, kind)
     SELECT $1, 1, $2, 'Export fixture', 'auto' WHERE NOT EXISTS (
       SELECT 1 FROM recording_result_selections WHERE recording_id = $1)`,
    [other.recordingId, other.jobId],
  );
  const otherSegmentId = randomUUID();
  await inTransaction(app, (tx) =>
    indexAcceptedReviewAnnotations(tx, other.jobId, other.manifestSha256, {
      segmentsSha256,
      clockDomain: "test",
      noHandDetected: false,
      segments: [
        {
          segmentId: otherSegmentId,
          startTsNs: "100",
          text: "Move the second tray.",
          label: null,
        },
      ],
    }),
  );
  // Shared membership requires clearance. Add the second member before granting access again.
  await revokeSharingPermission(owner, {
    permissionRef,
    revokedBy: "test",
    reason: "Add fixture clip",
  });
  const datasetRevision = (
    await app.query<{ revision: number }>(
      "SELECT revision FROM datasets WHERE id = $1",
      [datasetId],
    )
  ).rows[0]!.revision;
  await commitClipReviewV2(app, {
    clipId: other.recordingId,
    reviewerUserId: actors.staff,
    command: {
      action: "add",
      commandId: randomUUID(),
      expectedReviewRevision: 0,
      selectionRevision: 1,
      jobId: other.jobId,
      resultManifestSha256: other.manifestSha256,
      taskLabel: "Demonstration",
      datasetRevisions: { [datasetId]: datasetRevision },
    },
  });
  const secondGrant = permissionRef + "-two-clips";
  await recordSharingPermission(owner, {
    permissionRef: secondGrant,
    datasetId,
    recipientUserId: actors.customer,
    evidenceRef: "test:caption-export",
    recordedBy: "test",
  });
  await clearReviewClips(owner, {
    permissionRef: secondGrant,
    allCurrentMembers: true,
    clearedBy: "test",
  });
  await grantDatasetAccess(owner, {
    permissionRef: secondGrant,
    actorUserId: actors.staff,
  });
  const exportOptions = {
    ...customer,
    labels: ["demonstration"],
    limit: 1,
    page: 2,
  };
  assert.equal(
    (await listReviewDatasetClips(app, exportOptions)).items.length,
    1,
  );
  const exportBody = async (viewerUserId: string, q?: string) =>
    JSON.parse(
      await exportReviewDatasetCaptions(
        app,
        { ...exportOptions, viewerUserId, ...(q ? { q } : {}) },
        () => assert.fail("Indexed results must not read storage"),
      ),
    );
  const beforeOmit = await exportBody(actors.customer, "turquoise");
  assert.equal(beforeOmit.clips.length, 1);
  assert.equal(
    beforeOmit.clips[0].segments.find(
      (segment: { segmentId: string }) => segment.segmentId === segmentId,
    )?.caption,
    text,
  );
  assert.ok(!JSON.stringify(beforeOmit).includes(caption.text));

  await commitCaptionCorrection(app, source, {
    clipId,
    segmentId,
    reviewerUserId: actors.staff,
    command: { ...fields(1), action: "omit" },
  });
  const exported = await exportBody(actors.customer);
  assert.equal(exported.clips.length, 2);
  const first = exported.clips.find(
    (clip: { clipId: string }) => clip.clipId === clipId,
  );
  const second = exported.clips.find(
    (clip: { clipId: string }) => clip.clipId === other.recordingId,
  );
  assert.deepEqual(
    first.segments.find(
      (segment: { segmentId: string }) => segment.segmentId === segmentId,
    ),
    {
      segmentId,
      startTsNs: segments.rows[0].start.timestamp_ns,
      caption: null,
      captionNotNeeded: true,
    },
  );
  assert.equal(second.segments[0].caption, "Move the second tray.");
  for (const privateValue of [
    "originalCaption",
    "recordingId",
    actors.staff,
    caption.text,
    text,
  ])
    assert.ok(!JSON.stringify(exported).includes(privateValue), privateValue);
  const exportedStaff = await exportBody(actors.staff);
  assert.ok(JSON.stringify(exportedStaff).includes(caption.text));

  assert.equal(
    (await listReviewDatasetClips(app, { ...customer, q: "turquoise" }))
      .filteredCount,
    0,
  );
  assert.equal(
    (await listReviewDatasetClips(app, { ...customer, q: originalQuery }))
      .filteredCount,
    0,
  );
  await app.query(
    `INSERT INTO review_caption_search
       (job_id, result_manifest_sha256, segments_sha256, segment_id, start_ts_ns, original_text)
     SELECT $1, $2, $3, gen_random_uuid(), n, 'Fixture caption'
     FROM generate_series(1, 5000) n`,
    [other.jobId, other.manifestSha256, segmentsSha256],
  );
  await expectCode(
    exportReviewDatasetCaptions(app, customer, () =>
      assert.fail("Oversize indexed export"),
    ),
    "invalid_request",
  );

  // Simulate a selected clip accepted before the annotation index was added.
  await owner.query("TRUNCATE review_caption_search, review_result_search");
  const legacy = JSON.parse(
    await exportReviewDatasetCaptions(app, customer, () => s.accept.reader),
  );
  const legacyClip = legacy.clips.find(
    (clip: { clipId: string }) => clip.clipId === clipId,
  );
  assert.deepEqual(
    legacyClip.segments.find(
      (segment: { segmentId: string }) => segment.segmentId === segmentId,
    ),
    {
      segmentId,
      startTsNs: segments.rows[0].start.timestamp_ns,
      caption: null,
      captionNotNeeded: true,
    },
  );
  assert.ok(!JSON.stringify(legacy).includes(caption.text));
});
