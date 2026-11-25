import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { advanceResult } from "../src/acceptance/service.js";
import {
  commitCaptionCorrection,
  getCaptionCorrectionHistory,
  listEffectiveCaptionOverrides,
  storedCaptionSegments,
  type CaptionCorrectionCommandV2,
} from "../src/datasets/corrections.js";
import { createDatasetRecord } from "../src/datasets/mutations.js";
import {
  clearReviewClips,
  grantDatasetAccess,
  revokeSharingPermission,
  recordSharingPermission,
} from "../src/datasets/operator.js";
import {
  commitClipReview,
  commitClipReviewV2,
  getClipReviewState,
  getClipReviewStateV2,
  type ClipReviewCommandV2,
} from "../src/datasets/review.js";
import {
  getAuthorizedReviewClip,
  issueReviewClipPoster,
} from "../src/datasets/review-scope.js";
import { issueReviewClipVideo } from "../src/datasets/review-video.js";
import { selectReviewClipResult } from "../src/datasets/select-review-result.js";
import { expectCode, type TestDb } from "./harness.js";
import { recipeJob, runRecipe, seal, segmentsDoc } from "./recipe-harness.js";

async function picked(db: TestDb, jobId: string) {
  const {
    rows: [row],
  } = await db.app.query<{
    clipId: string;
    jobId: string;
    resultManifestSha256: string;
    selectionRevision: number;
  }>(
    'SELECT c.id AS "clipId", j.id AS "jobId", j.result_manifest_sha256 AS "resultManifestSha256", ' +
      '(SELECT max(seq) FROM clip_result_selections WHERE clip_id = c.id) AS "selectionRevision" ' +
      "FROM review_clips c JOIN jobs j ON j.id = c.selected_job_id WHERE j.id = $1",
    [jobId],
  );
  assert.ok(row);
  return row;
}

async function advanceSelection(
  db: TestDb,
  pin: Awaited<ReturnType<typeof picked>>,
  staff: string,
) {
  await db.app.query(
    "INSERT INTO clip_result_selections (clip_id, seq, job_id, selected_by, reason, kind) VALUES ($1,$2,$3,$4,'test reselection','manual')",
    [pin.clipId, pin.selectionRevision + 1, pin.jobId, staff],
  );
}

test("review adds, removes, rejects, undoes and restores with selected-result fencing", async (t) => {
  const { s, selected } = await acceptedRecipe(t);
  const { db } = s;
  const { actors } = db;
  const { clipId, ...pin } = selected;
  const choose = (
    viewerUserId: string,
    jobId: string,
    expectedSelectionSeq = pin.selectionRevision,
  ) =>
    selectReviewClipResult(db.app, {
      viewerUserId,
      clipId,
      jobId,
      expectedSelectionSeq,
      reason: "Verify the accepted output",
    });
  await expectCode(choose(actors.customer, pin.jobId), "forbidden");
  await expectCode(choose(actors.staff, randomUUID()), "not_found");
  await expectCode(
    choose(actors.staff, pin.jobId, pin.selectionRevision + 1),
    "conflict",
  );
  assert.deepEqual(await choose(actors.staff, pin.jobId), {
    jobId: pin.jobId,
    selectionRevision: pin.selectionRevision,
  });
  const a = randomUUID();
  const b = randomUUID();
  for (const id of [a, b])
    await createDatasetRecord(db.app, {
      datasetId: id,
      name: id,
      actorUserId: actors.staff,
    });
  const send = (command: ClipReviewCommandV2, reviewerUserId = actors.staff) =>
    commitClipReviewV2(db.app, { clipId, reviewerUserId, command });
  const fields = (expectedReviewRevision: number) => ({
    ...pin,
    commandId: randomUUID(),
    expectedReviewRevision,
  });
  const add: ClipReviewCommandV2 = {
    ...fields(0),
    action: "add",
    taskLabel: " cup ",
    datasetRevisions: { [a]: 1, [b]: 1 },
  };
  await expectCode(send(add, actors.customer), "forbidden");
  await expectCode(
    send({ ...add, datasetRevisions: { [a]: 1, [b]: 2 } }),
    "conflict",
  );
  const initial = await send(add);
  assert.deepEqual(initial.added, [a, b].sort());
  assert.deepEqual(initial.datasetRevisions, { [a]: 2, [b]: 2 });
  assert.equal(initial.review?.taskLabel, "cup");
  assert.equal((await send(add)).replayed, true);
  await expectCode(
    send({ ...add, taskLabel: "different" }),
    "idempotency_conflict",
  );

  const removed = await send({
    ...fields(1),
    action: "remove",
    datasetId: a,
    expectedDatasetRevision: 2,
  });
  assert.equal(removed.reviewRevision, 1);
  assert.deepEqual(removed.removed, [a]);
  const reject: ClipReviewCommandV2 = {
    ...fields(1),
    action: "reject",
    reason: "blurred",
  };
  const rejected = await send(reject);
  assert.deepEqual(rejected.removed, [b]);
  assert.equal(rejected.review?.notes, "blurred");
  assert.deepEqual(
    (
      await send({
        ...fields(2),
        action: "undo",
        targetCommandId: reject.commandId,
      })
    ).added,
    [b],
  );
  await send({ ...fields(3), action: "reject", reason: "still blurred" });
  const reopened = await send({ ...fields(4), action: "restore" });
  assert.equal(reopened.review?.decision, "reopened");
  const stateInput = {
    clipId,
    viewerUserId: actors.staff,
    selectionRevision: pin.selectionRevision,
  };
  assert.equal(
    (await getClipReviewStateV2(db.app, stateInput)).review.decision,
    "reopened",
  );
  assert.equal(
    (await getClipReviewState(db.app, stateInput)).review.decision,
    null,
  );

  const addAgain: ClipReviewCommandV2 = {
    ...fields(5),
    action: "add",
    taskLabel: "cup",
    datasetRevisions: { [b]: 5 },
  };
  const restoredMembership = await send(addAgain);
  const permissionRef = "approved-test-dataset";
  const otherRef = "second-recipient";
  for (const [ref, recipientUserId] of [
    [permissionRef, actors.customer],
    [otherRef, actors.outsider],
  ] as const)
    await recordSharingPermission(db.owner, {
      permissionRef: ref,
      datasetId: b,
      recipientUserId,
      evidenceRef: "Synthetic integration fixture",
      recordedBy: "Test operator",
    });
  const grant = (ref = permissionRef) =>
    grantDatasetAccess(db.owner, {
      permissionRef: ref,
      actorUserId: actors.staff,
    });
  const clear = (ref = permissionRef) =>
    clearReviewClips(db.owner, {
      permissionRef: ref,
      allCurrentMembers: true,
      clearedBy: "Test operator",
    });
  const viewer = { clipId, datasetId: b, viewerUserId: actors.customer };
  const read = () => getAuthorizedReviewClip(db.app, viewer);
  const members = async () =>
    (
      await db.app.query(
        "SELECT *, added_at::text FROM dataset_review_clips WHERE dataset_id = $1 AND clip_id = $2 ORDER BY selection_revision",
        [b, clipId],
      )
    ).rows;
  const saved = await members();
  await expectCode(grant(), "forbidden");
  await expectCode(
    db.app.query(
      `INSERT INTO dataset_review_clip_clearances
         (permission_id, clip_id, job_id, result_manifest_sha256, selection_revision, cleared_by)
       VALUES ($1, $2, $3, $4, $5, 'forged')`,
      [
        randomUUID(),
        clipId,
        pin.jobId,
        pin.resultManifestSha256,
        pin.selectionRevision,
      ],
    ),
    "42501",
  );
  // Model a pre-existing grant recorded without review clip evidence.
  await db.owner.query(
    "ALTER TABLE dataset_access DISABLE TRIGGER dataset_access_review_clip_guard",
  );
  try {
    await grant();
    assert.equal(await read(), null);
    const broker = {
      pool: db.app,
      signer: {
        async presignRead(): Promise<string> {
          assert.fail("Must not sign media without clip clearance");
        },
      },
    };
    await expectCode(issueReviewClipPoster(broker, viewer), "not_found");
    await expectCode(issueReviewClipVideo(broker, viewer), "not_found");
  } finally {
    await db.owner.query(
      "ALTER TABLE dataset_access ENABLE TRIGGER dataset_access_review_clip_guard",
    );
  }
  assert.deepEqual(await clear(), { cleared: 1 });
  assert.deepEqual(await clear(), { cleared: 0 });
  await grant();
  assert.equal((await read())?.selectionRevision, pin.selectionRevision);
  await expectCode(grant(otherRef), "forbidden");
  await clear(otherRef);
  await grant(otherRef);

  await advanceSelection(db, selected, actors.staff);
  const newPin = { ...selected, selectionRevision: pin.selectionRevision + 1 };
  const clearResult = (ref: string, result = newPin) =>
    clearReviewClips(db.owner, {
      permissionRef: ref,
      results: [result],
      clearedBy: "Test operator",
    });
  await expectCode(
    send({ ...fields(6), action: "reject", reason: "old tab" }),
    "conflict",
  );
  await expectCode(clearResult(permissionRef, selected), "conflict");
  await expectCode(clearResult(permissionRef), "conflict");
  await expectCode(grant(), "forbidden");
  assert.equal(await read(), null);

  const reapproval: ClipReviewCommandV2 = {
    ...fields(6),
    selectionRevision: newPin.selectionRevision,
    action: "add",
    taskLabel: "cup from the new result",
    datasetRevisions: restoredMembership.datasetRevisions,
  };
  await expectCode(send(reapproval), "forbidden");
  assert.deepEqual(await members(), saved);
  await send({
    ...reapproval,
    commandId: randomUUID(),
    datasetRevisions: removed.datasetRevisions,
  });
  await expectCode(
    clearResult(permissionRef, {
      ...newPin,
      resultManifestSha256: "1".repeat(64),
    }),
    "conflict",
  );
  await clearResult(permissionRef);
  const replace = { ...reapproval, expectedReviewRevision: 7 };
  await expectCode(send(replace), "forbidden");
  assert.deepEqual(await members(), saved);
  await clearResult(otherRef);
  const competing = { ...replace, commandId: randomUUID() };
  const both = await Promise.allSettled([send(replace), send(competing)]);
  const applied = both.find((result) => result.status === "fulfilled");
  assert.ok(applied);
  const winner = both[0].status === "fulfilled" ? replace : competing;
  assert.equal((await send(winner)).replayed, true);
  const refused = both.find((result) => result.status === "rejected");
  assert.equal(refused?.reason.code, "conflict");
  assert.deepEqual(applied.value.added, [b]);
  assert.deepEqual(
    (await members()).map((m) => m.selection_revision),
    [newPin.selectionRevision],
  );
  assert.equal((await read())?.selectionRevision, newPin.selectionRevision);
  assert.deepEqual(
    (
      await db.app.query(
        "SELECT revision FROM review_clip_decisions WHERE clip_id = $1 ORDER BY revision",
        [clipId],
      )
    ).rows.map((r) => r.revision),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );

  const undo: ClipReviewCommandV2 = {
    ...fields(8),
    selectionRevision: newPin.selectionRevision,
    action: "undo",
    targetCommandId: winner.commandId,
  };
  const undone = await send(undo);
  assert.equal(undone.review?.decision, "approved");
  assert.deepEqual(undone.removed, [b]);
  assert.equal((await send(undo)).replayed, true);
  assert.deepEqual(await members(), saved);
  assert.equal(await read(), null);
  await expectCode(grant(), "forbidden");
  const reapplied = await commitClipReview(db.app, {
    clipId,
    reviewerUserId: actors.staff,
    selectionRevision: newPin.selectionRevision,
    command: {
      reviewId: randomUUID(),
      expectedReviewRevision: 9,
      jobId: newPin.jobId,
      resultManifestSha256: newPin.resultManifestSha256,
      decision: "approved",
      taskLabel: replace.taskLabel,
      datasetSelection: {
        datasetIds: [a, b].sort(),
        expectedRevisions: {
          [a]: removed.datasetRevisions[a]! + 1,
          ...undone.datasetRevisions,
        },
      },
    },
  });
  assert.equal(reapplied.review.revision, 10);
  assert.deepEqual(
    (await members()).map((m) => m.selection_revision),
    [newPin.selectionRevision],
  );
  assert.equal((await read())?.selectionRevision, newPin.selectionRevision);
  await revokeSharingPermission(db.owner, {
    permissionRef,
    revokedBy: "Test operator",
    reason: "Test revocation",
  });
  assert.equal(await read(), null);
  assert.equal(
    (
      await getAuthorizedReviewClip(db.app, {
        ...viewer,
        viewerUserId: actors.outsider,
      })
    )?.selectionRevision,
    newPin.selectionRevision,
  );

  await advanceSelection(db, newPin, actors.staff);
  const cleaned = await send({
    ...fields(10),
    selectionRevision: newPin.selectionRevision + 1,
    action: "remove",
    datasetId: b,
    expectedDatasetRevision: undone.datasetRevisions[b]! + 1,
  });
  assert.deepEqual(cleaned.removed, [b]);
  assert.deepEqual(await members(), []);
  await grant(otherRef);
});

async function acceptedRecipe(t: TestContext) {
  const s = await recipeJob({}, (db) => t.after(() => db.close()));
  const run = await runRecipe(s);
  await seal(s, run);
  assert.equal(
    (await advanceResult(s.accept, s.jobId))?.candidateStatus,
    "accepted",
  );
  const selected = await picked(s.db, s.jobId);
  return { s, run, selected };
}

test("caption edits commit their marks, support replay and undo, and protect result identity", async (t) => {
  const { s, run, selected } = await acceptedRecipe(t);
  const { clipId, ...pin } = selected;
  const segmentId = segmentsDoc(s).rows[0]!.segment_id;
  const segmentsSha256 = run.files.find((f) => f.role === "segments_json")!.sha;
  const reviewerUserId = s.db.actors.staff;
  const original = storedCaptionSegments({
    pool: s.db.app,
    reader: s.accept.reader,
  });
  const send = (command: CaptionCorrectionCommandV2, source = original) =>
    commitCaptionCorrection(s.db.app, source, {
      clipId,
      segmentId,
      reviewerUserId,
      command,
    });
  const fields = (expectedRevision: number) => ({
    ...pin,
    segmentsSha256,
    correctionId: randomUUID(),
    expectedRevision,
    expectedMarkRevision: expectedRevision,
  });

  await expectCode(
    send({ ...fields(0), action: "edit", text: "   " }),
    "invalid_request",
  );
  const cmd: CaptionCorrectionCommandV2 = {
    ...fields(0),
    action: "edit",
    text: "  Lift the cup. ",
  };
  const same = await Promise.all([send(cmd), send(cmd)]);
  assert.deepEqual(same.map((r) => r.replayed).sort(), [false, true]);
  await expectCode(
    send({ ...cmd, text: "Moved the lid." }),
    "idempotency_conflict",
  );
  const mark = () =>
    s.db.app
      .query(
        "SELECT verdict, issue_type FROM segment_marks WHERE job_id = $1 AND segment_id = $2 ORDER BY revision DESC LIMIT 1",
        [pin.jobId, segmentId],
      )
      .then(({ rows }) => rows[0]);
  assert.deepEqual(await mark(), { verdict: "issue", issue_type: "caption" });
  await expectCode(
    send({ ...fields(1), action: "edit", text: "Lift the cup." }),
    "invalid_request",
  );
  const effective = () => listEffectiveCaptionOverrides(s.db.app, selected);
  assert.deepEqual(await effective(), [{ segmentId, text: "Lift the cup." }]);
  await send({ ...fields(1), action: "omit" });
  assert.deepEqual(await effective(), [{ segmentId, text: null }]);
  assert.equal(
    (await send({ ...fields(2), action: "undo" })).correction.undoRevision,
    1,
  );
  assert.deepEqual(await effective(), [{ segmentId, text: "Lift the cup." }]);
  assert.equal(
    (await send({ ...fields(3), action: "undo" })).correction.undoRevision,
    0,
  );
  assert.deepEqual(await effective(), []);
  assert.deepEqual(
    (
      await getCaptionCorrectionHistory(s.db.app, {
        ...selected,
        viewerUserId: reviewerUserId,
        segmentId,
      })
    ).map((c) => c.revision),
    [4, 3, 2, 1],
  );
  assert.deepEqual(
    await getCaptionCorrectionHistory(s.db.app, {
      ...selected,
      viewerUserId: s.db.actors.customer,
      segmentId,
    }),
    [],
  );
  await expectCode(
    s.db.owner.query("DELETE FROM caption_corrections WHERE id = $1", [
      cmd.correctionId,
    ]),
    "SAC01",
  );

  // The selected revision moves after the source read has started.
  await expectCode(
    send(
      { ...fields(4), action: "edit", text: "A stale edit." },
      async (input) => {
        const verified = await original(input);
        await advanceSelection(s.db, selected, reviewerUserId);
        return verified;
      },
    ),
    "conflict",
  );
  assert.equal(
    (
      await s.db.app.query("SELECT 1 FROM segment_marks WHERE job_id = $1", [
        pin.jobId,
      ])
    ).rowCount,
    4,
  );
});
