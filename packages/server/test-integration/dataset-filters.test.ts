import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { appendReview } from "../src/catalog/catalog.js";
import { fixtureAcceptResult } from "../src/jobs/fixtures.js";
import {
  addDatasetMembers,
  createDatasetRecord,
} from "../src/datasets/mutations.js";
import {
  clearClips,
  grantDatasetAccess,
  recordSharingPermission,
} from "../src/datasets/operator.js";
import {
  getDataset,
  listDatasetClips,
  listDatasets,
  listStaffClips,
} from "../src/datasets/queries.js";
import {
  createActors,
  expectCode,
  freshDatabase,
  processedRecording,
  type Actors,
  type TestDb,
} from "./harness.js";

let db: TestDb;
let actors: Actors;
let datasetId: string;
let approved: string;
let pending: string;
before(async () => {
  db = await freshDatabase();
  actors = await createActors(db.owner);
  const source = await processedRecording(db.app, actors, 3);
  source.clips[0]!.title = "Open 100%_box";
  source.clips[1]!.title = "Release object";
  source.clips[2]!.title = "Private pending motion";
  // Synthetic query fixture through the explicit owner-only helper; all
  // unconditional acceptance guards remain enabled.
  await fixtureAcceptResult(db.owner, db.app, {
    jobId: source.jobId,
    manifestFileId: source.manifestFileId,
    manifestSha256: source.manifestSha256,
    clips: source.clips,
  });
  approved = source.clips[0]!.clipId;
  pending = source.clips[2]!.clipId;
  for (const [clip, taskLabel] of [
    [source.clips[0]!, "grasp"],
    [source.clips[1]!, "release"],
  ] as const) {
    await appendReview(db.app, {
      reviewId: randomUUID(),
      clipId: clip.clipId,
      jobId: source.jobId,
      resultManifestSha256: source.manifestSha256,
      reviewerUserId: actors.staff,
      expectedRevision: 0,
      decision: "approved",
      taskLabel,
    });
  }
  datasetId = randomUUID();
  await createDatasetRecord(db.app, {
    datasetId,
    name: "Table 100%_grasp",
    actorUserId: actors.staff,
  });
  await createDatasetRecord(db.app, {
    datasetId: randomUUID(),
    name: "Table 100AAgrasp",
    actorUserId: actors.staff,
  });
  await addDatasetMembers(db.app, {
    datasetId,
    clipIds: [source.clips[0]!.clipId, source.clips[1]!.clipId],
    expectedRevision: 1,
    actorUserId: actors.staff,
  });
  await recordSharingPermission(db.owner, {
    permissionRef: "filter-share",
    datasetId,
    recipientUserId: actors.customer,
    evidenceRef: "local fixture",
    recordedBy: "test operator",
  });
  await clearClips(db.owner, {
    permissionRef: "filter-share",
    allCurrentMembers: true,
    clearedBy: "test operator",
  });
  await grantDatasetAccess(db.owner, {
    permissionRef: "filter-share",
    actorUserId: actors.staff,
  });
});
after(() => db.close());

test("search treats wildcard characters literally and keeps full dataset totals", async () => {
  const datasets = await listDatasets(db.app, {
    viewerUserId: actors.staff,
    q: "%_",
  });
  assert.deepEqual(
    datasets.items.map((d) => d.datasetId),
    [datasetId],
  );
  for (const viewerUserId of [actors.staff, actors.customer]) {
    const result = await listDatasetClips(db.app, {
      viewerUserId,
      datasetId,
      q: "100%_BOX",
      label: "GrAsP",
    });
    assert.deepEqual(
      result.items.map((c) => c.clipId),
      [approved],
    );
    assert.equal(
      (await getDataset(db.app, { viewerUserId, datasetId })).clipCount,
      2,
    );
    assert.deepEqual(
      (await listDatasetClips(db.app, { viewerUserId, datasetId, q: "absent" }))
        .items,
      [],
    );
  }
});

test("staff review filters compose; customer search cannot expose unapproved rows", async () => {
  assert.deepEqual(
    (
      await listStaffClips(db.app, {
        viewerUserId: actors.staff,
        reviewStatus: "pending",
        q: "motion",
      })
    ).items.map((c) => c.clipId),
    [pending],
  );
  assert.deepEqual(
    (
      await listStaffClips(db.app, {
        viewerUserId: actors.staff,
        reviewStatus: "pending",
        label: "grasp",
      })
    ).items,
    [],
  );
  assert.deepEqual(
    (
      await listDatasetClips(db.app, {
        viewerUserId: actors.customer,
        datasetId,
        q: "Private pending motion",
      })
    ).items,
    [],
  );
  await expectCode(
    listStaffClips(db.app, { viewerUserId: actors.customer, q: "motion" }),
    "forbidden",
  );
});

test("bounded filters and cursors cannot broaden inaccessible contexts", async () => {
  for (const q of ["x".repeat(161), "hidden\u0000motion"]) {
    await expectCode(
      listDatasets(db.app, { viewerUserId: actors.staff, q }),
      "invalid_request",
    );
    await expectCode(
      listDatasetClips(db.app, { viewerUserId: actors.customer, datasetId, q }),
      "invalid_request",
    );
  }
  await expectCode(
    listDatasetClips(db.app, {
      viewerUserId: actors.customer,
      datasetId: randomUUID(),
      q: "absent",
    }),
    "not_found",
  );
  const first = await listDatasetClips(db.app, {
    viewerUserId: actors.customer,
    datasetId,
    limit: 1,
  });
  assert.ok(first.nextCursor);
  const second = await listDatasetClips(db.app, {
    viewerUserId: actors.customer,
    datasetId,
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0]!.clipId, second.items[0]!.clipId);
});
