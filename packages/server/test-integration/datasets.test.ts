import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import {
  acceptProcessingResult,
  appendReview,
} from "../src/catalog/catalog.js";
import { issueRead, type ReadSigner } from "../src/datasets/broker.js";
import {
  addDatasetMembers,
  createDatasetRecord,
  removeDatasetMember,
  renameDatasetRecord,
} from "../src/datasets/mutations.js";
import {
  clearClips,
  disableDatasetAccess,
  grantDatasetAccess,
  recordSharingPermission,
  revokeSharingPermission,
} from "../src/datasets/operator.js";
import {
  getClip,
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
  type Processed,
  type TestDb,
} from "./harness.js";

let db: TestDb;
let actors: Actors;
before(async () => {
  db = await freshDatabase();
  actors = await createActors(db.owner);
});
after(() => db.close());

const accepted = async (clipCount: number): Promise<Processed> => {
  const p = await processedRecording(db.app, actors, clipCount);
  await acceptProcessingResult(db.app, {
    jobId: p.jobId,
    manifestFileId: p.manifestFileId,
    manifestSha256: p.manifestSha256,
    clips: p.clips,
  });
  return p;
};
const review = (
  p: Processed,
  clipId: string,
  expectedRevision: number,
  decision: "approved" | "rejected" = "approved",
) =>
  appendReview(db.app, {
    reviewId: randomUUID(),
    clipId,
    jobId: p.jobId,
    resultManifestSha256: p.manifestSha256,
    reviewerUserId: actors.staff,
    expectedRevision,
    decision,
    ...(decision === "approved" ? { taskLabel: "grasp" } : {}),
  });
const newDataset = async (name = "Dataset") => {
  const datasetId = randomUUID();
  await createDatasetRecord(db.app, {
    datasetId,
    name,
    actorUserId: actors.staff,
  });
  return datasetId;
};
const add = (datasetId: string, clipIds: string[], expectedRevision: number) =>
  addDatasetMembers(db.app, {
    datasetId,
    clipIds,
    expectedRevision,
    actorUserId: actors.staff,
  });
/** Operator setup: evidence, clearance of all current members, then grant. */
const share = async (datasetId: string, user: string) => {
  const permissionRef = `ref-${randomUUID().slice(0, 12)}`;
  await recordSharingPermission(db.owner, {
    permissionRef,
    datasetId,
    recipientUserId: user,
    evidenceRef: "doc:inspection-1",
    recordedBy: "operator",
  });
  await clearClips(db.owner, {
    permissionRef,
    allCurrentMembers: true,
    clearedBy: "operator",
  });
  await grantDatasetAccess(db.owner, {
    permissionRef,
    actorUserId: actors.staff,
  });
  return permissionRef;
};
/** Visible member IDs; an invisible dataset is "not found" (no signal). */
const visible = async (user: string, datasetId: string) => {
  try {
    return (
      await listDatasetClips(db.app, { viewerUserId: user, datasetId })
    ).items.map((c) => c.clipId);
  } catch (error) {
    if ((error as { code?: string }).code === "not_found") return [];
    throw error;
  }
};

describe("approved-only membership", () => {
  test("pending and rejected clips fail at the API and at the database", async () => {
    const p = await accepted(3);
    const [approved, rejected, pending] = p.clips.map((c) => c.clipId) as [
      string,
      string,
      string,
    ];
    await review(p, approved, 0);
    await review(p, rejected, 0, "rejected");
    const d = await newDataset();
    await expectCode(add(d, [pending], 1), "conflict");
    await expectCode(add(d, [rejected], 1), "conflict");
    await expectCode(add(d, [approved, pending], 1), "conflict");
    assert.deepEqual(await add(d, [approved], 1), { added: 1, revision: 2 });
    // Forged direct insert as the restricted web role (no API checks).
    for (const clip of [pending, rejected])
      await expectCode(
        db.app.query(
          "INSERT INTO dataset_clips (dataset_id, clip_id, added_by) VALUES ($1, $2, $3)",
          [d, clip, actors.staff],
        ),
        "SAC02",
      );
    // A non-staff actor cannot add even an approved clip.
    await expectCode(
      addDatasetMembers(db.app, {
        datasetId: d,
        clipIds: [approved],
        expectedRevision: 2,
        actorUserId: actors.customer,
      }),
      "forbidden",
    );
    // Stale revisions conflict; replaying an add is a no-op.
    await expectCode(add(d, [approved], 1), "conflict");
    assert.deepEqual(await add(d, [approved], 2), { added: 0, revision: 2 });
  });

  test("a later rejection removes the member; a forged rejection with a member fails", async () => {
    const p = await accepted(2);
    const [clip, forged] = p.clips.map((c) => c.clipId) as [string, string];
    await review(p, clip, 0);
    await review(p, forged, 0);
    const d = await newDataset();
    await add(d, [clip, forged], 1);
    assert.equal(await visibleCount(d), 2);
    // The review transaction removes memberships before appending.
    await review(p, clip, 1, "rejected");
    assert.equal(await visibleCount(d), 1);
    await expectCode(add(d, [clip], 3), "conflict");
    // A direct rejection insert that leaves a membership behind is refused.
    await expectCode(
      db.app.query(
        `INSERT INTO reviews (id, clip_id, job_id, result_manifest_sha256, revision, reviewer_user_id, decision)
         VALUES (gen_random_uuid(), $1, $2, $3, 2, $4, 'rejected')`,
        [forged, p.jobId, p.manifestSha256, actors.staff],
      ),
      "SAC02",
    );
    assert.equal(await visibleCount(d), 1);
  });
});
const visibleCount = async (datasetId: string) =>
  (await getDataset(db.app, { viewerUserId: actors.staff, datasetId }))
    .clipCount;

describe("counts, multiple datasets and paging", () => {
  test("distinct counts match the paged members; clips can be multi-dataset or unassigned", async () => {
    const p = await accepted(8);
    const ids = p.clips.map((c) => c.clipId);
    for (const id of ids.slice(0, 7)) await review(p, id, 0);
    const a = await newDataset("A");
    const b = await newDataset("B");
    await add(a, ids.slice(0, 5), 1);
    await add(b, ids.slice(3, 6), 1);
    const staff = actors.staff;
    const paged = async (datasetId: string, limit: number) => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await listDatasetClips(db.app, {
          viewerUserId: staff,
          datasetId,
          cursor,
          limit,
        });
        seen.push(...page.items.map((c) => c.clipId));
        cursor = page.nextCursor ?? undefined;
        pages++;
      } while (cursor);
      return { seen, pages };
    };
    const pageA = await paged(a, 2);
    assert.equal(pageA.pages, 3);
    assert.equal(new Set(pageA.seen).size, 5, "no duplicates across pages");
    assert.equal(
      (await getDataset(db.app, { viewerUserId: staff, datasetId: a }))
        .clipCount,
      5,
    );
    assert.equal((await paged(b, 100)).seen.length, 3);
    // Durations are summed over distinct visible members.
    const view = await getDataset(db.app, {
      viewerUserId: staff,
      datasetId: a,
    });
    assert.equal(view.durationNs, String(5 * 900));
    // Clips 3 and 4 are in both datasets; clip 5 only in B; clip 6 is approved
    // but unassigned; clip 7 is still pending (unassigned too).
    const all = await listStaffClips(db.app, {
      viewerUserId: staff,
      limit: 100,
    });
    const byId = new Map(all.items.map((c) => [c.clipId, c]));
    assert.equal(byId.get(ids[3]!)!.datasetCount, 2);
    assert.equal(byId.get(ids[4]!)!.datasetCount, 2);
    assert.equal(byId.get(ids[5]!)!.datasetCount, 1);
    assert.equal(byId.get(ids[6]!)!.reviewStatus, "approved");
    assert.equal(byId.get(ids[7]!)!.reviewStatus, "pending");
    const unassigned = ids.filter((id) => byId.get(id)!.datasetCount === 0);
    assert.equal(unassigned.length, 2);
    // The dataset list pages with the same counts.
    const first = await listDatasets(db.app, { viewerUserId: staff, limit: 1 });
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    // Bounds.
    await expectCode(
      listDatasetClips(db.app, {
        viewerUserId: staff,
        datasetId: a,
        limit: 101,
      }),
      "invalid_request",
    );
    await expectCode(
      listDatasetClips(db.app, {
        viewerUserId: staff,
        datasetId: a,
        cursor: "x",
      }),
      "invalid_request",
    );
  });

  test("renaming advances the revision and stale revisions conflict", async () => {
    const d = await newDataset("Old");
    assert.deepEqual(
      await renameDatasetRecord(db.app, {
        datasetId: d,
        name: "New",
        expectedRevision: 1,
        actorUserId: actors.staff,
      }),
      { revision: 2 },
    );
    await expectCode(
      renameDatasetRecord(db.app, {
        datasetId: d,
        name: "Again",
        expectedRevision: 1,
        actorUserId: actors.staff,
      }),
      "conflict",
    );
    await expectCode(
      renameDatasetRecord(db.app, {
        datasetId: d,
        name: "Customer",
        expectedRevision: 2,
        actorUserId: actors.customer,
      }),
      "forbidden",
    );
  });
});

describe("recipient sharing evidence", () => {
  test("a grant needs operator-recorded evidence and cleared members; the web role cannot grant", async () => {
    const p = await accepted(2);
    const [x, y] = p.clips.map((c) => c.clipId) as [string, string];
    await review(p, x, 0);
    await review(p, y, 0);
    const d = await newDataset("Shared");
    await add(d, [x], 1);
    // No evidence: both the routine and a direct write are refused.
    await expectCode(
      db.owner.query(
        "SELECT catalog_set_dataset_access($1, $2, true, $3, 'nope')",
        [d, actors.customer, actors.staff],
      ),
      "SAC05",
    );
    await expectCode(
      db.owner.query(
        `INSERT INTO dataset_access (dataset_id, user_id, granted_by, permission_evidence_ref)
         VALUES ($1, $2, $3, 'ui-checkbox')`,
        [d, actors.customer, actors.staff],
      ),
      "SAC05",
    );
    // The restricted web role has no path to grants or evidence at all.
    for (const sql of [
      "SELECT catalog_set_dataset_access(gen_random_uuid(), 'x', true, 'x', 'x')",
      `INSERT INTO dataset_sharing_permissions (id, permission_ref, dataset_id, recipient_user_id,
         covers_external_inspection, evidence_ref, recorded_by)
       VALUES (gen_random_uuid(), 'web', gen_random_uuid(), 'x', true, 'x', 'x')`,
      "INSERT INTO dataset_sharing_clearances (permission_id, clip_id, cleared_by) VALUES (gen_random_uuid(), gen_random_uuid(), 'x')",
      "UPDATE dataset_sharing_permissions SET status = 'revoked'",
      "INSERT INTO dataset_access (dataset_id, user_id, granted_by, permission_evidence_ref) VALUES (gen_random_uuid(), 'x', 'x', 'x')",
    ])
      await expectCode(db.app.query(sql), "42501");

    const permissionRef = `ref-${randomUUID().slice(0, 12)}`;
    await recordSharingPermission(db.owner, {
      permissionRef,
      datasetId: d,
      recipientUserId: actors.customer,
      evidenceRef: "doc:1",
      recordedBy: "operator",
    });
    // Evidence alone is not enough: the current approved member is not cleared.
    await expectCode(
      grantDatasetAccess(db.owner, {
        permissionRef,
        actorUserId: actors.staff,
      }),
      "forbidden",
    );
    // Only approved clips can be cleared; a recipient must be a customer.
    await expectCode(
      clearClips(db.owner, {
        permissionRef,
        clipIds: [randomUUID()],
        clearedBy: "op",
      }),
      "conflict",
    );
    await expectCode(
      recordSharingPermission(db.owner, {
        permissionRef: `ref-${randomUUID().slice(0, 12)}`,
        datasetId: d,
        recipientUserId: actors.collector,
        evidenceRef: "doc:1",
        recordedBy: "operator",
      }),
      "forbidden",
    );
    assert.deepEqual(
      await clearClips(db.owner, {
        permissionRef,
        allCurrentMembers: true,
        clearedBy: "op",
      }),
      { cleared: 1 },
    );
    assert.deepEqual(
      await clearClips(db.owner, {
        permissionRef,
        allCurrentMembers: true,
        clearedBy: "op",
      }),
      { cleared: 0 },
    );
    assert.deepEqual(await visible(actors.customer, d), [], "no grant yet");
    await grantDatasetAccess(db.owner, {
      permissionRef,
      actorUserId: actors.staff,
    });
    assert.deepEqual(await visible(actors.customer, d), [x]);
    assert.deepEqual(
      await visible(actors.outsider, d),
      [],
      "other customer sees nothing",
    );
    await expectCode(
      getDataset(db.app, { viewerUserId: actors.outsider, datasetId: d }),
      "not_found",
    );
    await expectCode(
      listDatasetClips(db.app, { viewerUserId: actors.outsider, datasetId: d }),
      "not_found",
    );
    await expectCode(
      getClip(db.app, { viewerUserId: actors.outsider, clipId: x }),
      "not_found",
    );

    // Later additions to the shared dataset need that clip cleared first.
    await expectCode(add(d, [y], 2), "forbidden");
    assert.deepEqual(await visible(actors.customer, d), [x]);
    await clearClips(db.owner, {
      permissionRef,
      clipIds: [y],
      clearedBy: "op",
    });
    await add(d, [y], 2);
    assert.deepEqual((await visible(actors.customer, d)).sort(), [x, y].sort());
    const customerView = await listDatasets(db.app, {
      viewerUserId: actors.customer,
    });
    assert.deepEqual(
      customerView.items.map((v) => [v.datasetId, v.clipCount]),
      [[d, 2]],
    );
    assert.equal("revision" in customerView.items[0]!, false);

    // A second recipient needs their own evidence and clearance for every
    // clip; adding is refused while any enabled recipient lacks it.
    const second = await accepted(1);
    const z = second.clips[0]!.clipId;
    await review(second, z, 0);
    await clearClips(db.owner, {
      permissionRef,
      clipIds: [z],
      clearedBy: "op",
    });
    const otherRef = `ref-${randomUUID().slice(0, 12)}`;
    await recordSharingPermission(db.owner, {
      permissionRef: otherRef,
      datasetId: d,
      recipientUserId: actors.outsider,
      evidenceRef: "doc:2",
      recordedBy: "operator",
    });
    await expectCode(
      grantDatasetAccess(db.owner, {
        permissionRef: otherRef,
        actorUserId: actors.staff,
      }),
      "forbidden",
    );
    await clearClips(db.owner, {
      permissionRef: otherRef,
      allCurrentMembers: true,
      clearedBy: "op",
    });
    await grantDatasetAccess(db.owner, {
      permissionRef: otherRef,
      actorUserId: actors.staff,
    });
    await expectCode(add(d, [z], 3), "forbidden");
    await clearClips(db.owner, {
      permissionRef: otherRef,
      clipIds: [z],
      clearedBy: "op",
    });
    await add(d, [z], 3);
    assert.equal((await visible(actors.outsider, d)).length, 3);
  });

  test("revocation, disablement, role changes and later rejection remove visibility on the next request", async () => {
    const p = await accepted(1);
    const clip = p.clips[0]!.clipId;
    await review(p, clip, 0);
    const d = await newDataset("Revocable");
    await add(d, [clip], 1);
    const ref = await share(d, actors.customer);
    assert.deepEqual(await visible(actors.customer, d), [clip]);

    // Revoking the evidence disables the grant and hides the member.
    await revokeSharingPermission(db.owner, {
      permissionRef: ref,
      revokedBy: "operator",
      reason: "withdrawn",
    });
    assert.deepEqual(await visible(actors.customer, d), []);
    const row = await db.owner.query(
      "SELECT enabled FROM dataset_access WHERE dataset_id = $1",
      [d],
    );
    assert.equal(row.rows[0].enabled, false);
    // A revoked reference cannot be reused or re-enabled.
    await expectCode(
      grantDatasetAccess(db.owner, {
        permissionRef: ref,
        actorUserId: actors.staff,
      }),
      "forbidden",
    );
    await expectCode(
      db.owner.query(
        "UPDATE dataset_sharing_permissions SET status = 'active' WHERE permission_ref = $1",
        [ref],
      ),
      "SAC04",
    );
    await expectCode(
      db.owner.query(
        "DELETE FROM dataset_sharing_permissions WHERE permission_ref = $1",
        [ref],
      ),
      "SAC01",
    );

    // Renewed approval is new evidence and needs fresh clearance.
    const second = await share(d, actors.customer);
    assert.deepEqual(await visible(actors.customer, d), [clip]);
    // Evidence revoked behind the grant's back (trigger bypassed) still hides
    // data: every read joins the evidence row.
    await db.owner.query(
      "ALTER TABLE dataset_sharing_permissions DISABLE TRIGGER dataset_sharing_permissions_revoked",
    );
    try {
      await revokeSharingPermission(db.owner, {
        permissionRef: second,
        revokedBy: "operator",
        reason: "direct",
      });
    } finally {
      await db.owner.query(
        "ALTER TABLE dataset_sharing_permissions ENABLE TRIGGER dataset_sharing_permissions_revoked",
      );
    }
    const stale = await db.owner.query(
      "SELECT enabled FROM dataset_access WHERE dataset_id = $1",
      [d],
    );
    assert.equal(stale.rows[0].enabled, true);
    assert.deepEqual(await visible(actors.customer, d), []);
    const renewed = await share(d, actors.customer);
    assert.notEqual(renewed, second);
    assert.deepEqual(await visible(actors.customer, d), [clip]);
    // Operator disables the grant explicitly.
    await disableDatasetAccess(db.owner, {
      datasetId: d,
      userId: actors.customer,
      actorUserId: actors.staff,
    });
    assert.deepEqual(await visible(actors.customer, d), []);
    await revokeSharingPermission(db.owner, {
      permissionRef: renewed,
      revokedBy: "operator",
      reason: "cycle",
    });
    await share(d, actors.customer);
    assert.deepEqual(await visible(actors.customer, d), [clip]);

    // Disabling the customer role hides it; so does a rejection.
    await db.owner.query(
      "UPDATE access SET enabled = false WHERE user_id = $1 AND role = 'customer'",
      [actors.customer],
    );
    assert.deepEqual(await visible(actors.customer, d), []);
    await db.owner.query(
      "UPDATE access SET enabled = true WHERE user_id = $1 AND role = 'customer'",
      [actors.customer],
    );
    assert.deepEqual(await visible(actors.customer, d), [clip]);
    await removeDatasetMember(db.app, {
      datasetId: d,
      clipId: clip,
      expectedRevision: 2,
      actorUserId: actors.staff,
    });
    assert.deepEqual(await visible(actors.customer, d), []);
  });

  test("direct clip links authorize through any granted dataset; customers have no catalog", async () => {
    const p = await accepted(2);
    const [granted, hidden] = p.clips.map((c) => c.clipId) as [string, string];
    await review(p, granted, 0);
    await review(p, hidden, 0);
    const d = await newDataset("Direct");
    const other = await newDataset("Other");
    await add(d, [granted], 1);
    await add(other, [hidden], 1);
    await share(d, actors.customer);
    const ok = await getClip(db.app, {
      viewerUserId: actors.customer,
      clipId: granted,
    });
    assert.equal(ok.clipId, granted);
    assert.deepEqual(
      Object.keys(ok).sort(),
      [
        "clipId",
        "durationNs",
        "frameCount",
        "media",
        "raster",
        "simulation",
        "taskLabel",
        "title",
      ].sort(),
    );
    assert.equal(ok.simulation, null);
    await expectCode(
      getClip(db.app, { viewerUserId: actors.customer, clipId: hidden }),
      "not_found",
    );
    // A wrong dataset context for a granted clip is refused too.
    await expectCode(
      getClip(db.app, {
        viewerUserId: actors.customer,
        clipId: granted,
        datasetId: other,
      }),
      "not_found",
    );
    assert.equal(
      (
        await getClip(db.app, {
          viewerUserId: actors.customer,
          clipId: granted,
          datasetId: d,
        })
      ).datasetId,
      d,
    );
    // Customers never reach the staff catalog.
    await expectCode(
      listStaffClips(db.app, { viewerUserId: actors.customer }),
      "forbidden",
    );
    // Staff see internal fields; a customer payload never has them.
    const staffView = await getClip(db.app, {
      viewerUserId: actors.staff,
      clipId: granted,
    });
    assert.equal(staffView.recordingId, p.recordingId);
    for (const forbidden of [
      "recordingId",
      "jobId",
      "notes",
      "objectKey",
      "sha256",
    ])
      assert.equal(forbidden in ok, false, forbidden);
  });

  test("stale or deleted results are not visible", async () => {
    const p = await accepted(1);
    const clip = p.clips[0]!.clipId;
    await review(p, clip, 0);
    const d = await newDataset("Stale");
    await add(d, [clip], 1);
    await share(d, actors.customer);
    assert.equal((await visible(actors.customer, d)).length, 1);
    await db.owner.query(
      "UPDATE recordings SET deleted_at = now() WHERE id = $1",
      [p.recordingId],
    );
    assert.equal((await visible(actors.customer, d)).length, 0);
    assert.equal(await visibleCount(d), 0, "counts follow the same gate");
    await db.owner.query(
      "UPDATE recordings SET deleted_at = NULL WHERE id = $1",
      [p.recordingId],
    );
    assert.equal((await visible(actors.customer, d)).length, 1);
  });
});

describe("concurrency", () => {
  test("a rejection racing an addition never leaves a visible non-approved member", async () => {
    for (let i = 0; i < 5; i++) {
      const p = await accepted(1);
      const clip = p.clips[0]!.clipId;
      await review(p, clip, 0);
      const d = await newDataset();
      const results = await Promise.allSettled([
        add(d, [clip], 1),
        review(p, clip, 1, "rejected"),
      ]);
      void results;
      const members = await db.owner.query(
        `SELECT count(*)::int AS n FROM dataset_clips dc
         WHERE dc.dataset_id = $1 AND catalog_latest_decision(dc.clip_id) <> 'approved'`,
        [d],
      );
      assert.equal(members.rows[0].n, 0);
    }
  });

  test("evidence revocation racing an addition leaves no visible member", async () => {
    for (let i = 0; i < 5; i++) {
      const p = await accepted(2);
      const [x, y] = p.clips.map((c) => c.clipId) as [string, string];
      await review(p, x, 0);
      await review(p, y, 0);
      const d = await newDataset();
      await add(d, [x], 1);
      const ref = await share(d, actors.customer);
      await clearClips(db.owner, {
        permissionRef: ref,
        clipIds: [y],
        clearedBy: "op",
      });
      await Promise.allSettled([
        add(d, [y], 2),
        revokeSharingPermission(db.owner, {
          permissionRef: ref,
          revokedBy: "operator",
          reason: "race",
        }),
      ]);
      assert.deepEqual(await visible(actors.customer, d), []);
    }
  });
});

describe("read broker", () => {
  const signer = () => {
    const calls: {
      key: string;
      expiresInSeconds: number;
      contentType: string;
    }[] = [];
    const impl: ReadSigner = {
      async presignRead(request) {
        calls.push(request);
        return `https://objects.test/${encodeURIComponent(request.key)}?X-Amz-Expires=${request.expiresInSeconds}`;
      },
    };
    return { impl, calls };
  };
  const key = async (fileId: string) =>
    (
      await db.owner.query<{ object_key: string }>(
        "SELECT object_key FROM files WHERE id = $1",
        [fileId],
      )
    ).rows[0]!.object_key;

  test("issues only thumbnail and viewer reads for currently authorized viewers", async () => {
    const p = await accepted(1);
    const clip = p.clips[0]!;
    await review(p, clip.clipId, 0);
    const d = await newDataset("Reads");
    await add(d, [clip.clipId], 1);
    const { impl, calls } = signer();
    const deps = {
      pool: db.app,
      signer: impl,
      now: () => new Date("2026-11-02T00:00:00Z"),
    };

    await expectCode(
      issueRead(deps, {
        viewerUserId: actors.customer,
        clipId: clip.clipId,
        role: "thumbnail_jpeg",
        datasetId: d,
      }),
      "not_found",
    );
    await share(d, actors.customer);
    const thumb = await issueRead(deps, {
      viewerUserId: actors.customer,
      clipId: clip.clipId,
      role: "thumbnail_jpeg",
      datasetId: d,
    });
    assert.equal(calls[0]!.key, await key(clip.files.thumbnailJpeg));
    assert.equal(thumb.ttlSeconds, 60);
    assert.equal(thumb.expiresAt, "2026-11-02T00:01:00.000Z");
    assert.equal(thumb.contentType, "image/jpeg");
    const viewer = await issueRead(deps, {
      viewerUserId: actors.customer,
      clipId: clip.clipId,
      role: "viewer_rrd",
    });
    assert.equal(calls[1]!.key, await key(clip.files.viewerRrd));
    assert.equal(viewer.sizeBytes, "100");

    // Injected TTLs outside 1..60 whole seconds are rejected, never clamped.
    for (const ttlSeconds of [0, -1, 61, 1.5, Number.NaN, Infinity])
      await expectCode(
        issueRead(
          { ...deps, ttlSeconds },
          {
            viewerUserId: actors.customer,
            clipId: clip.clipId,
            role: "viewer_rrd",
          },
        ),
        "invalid_request",
      );
    // Roles outside the two derived outputs have no path, even for staff.
    for (const role of [
      "clip_mp4",
      "hand_arrays_npz",
      "source_mcap",
      "result_manifest",
    ])
      await expectCode(
        issueRead(deps, {
          viewerUserId: actors.staff,
          clipId: clip.clipId,
          role: role as never,
        }),
        "invalid_request",
      );
    // Cross-customer and wrong dataset context are denied.
    await expectCode(
      issueRead(deps, {
        viewerUserId: actors.outsider,
        clipId: clip.clipId,
        role: "viewer_rrd",
      }),
      "not_found",
    );
    await expectCode(
      issueRead(deps, {
        viewerUserId: actors.customer,
        clipId: clip.clipId,
        role: "viewer_rrd",
        datasetId: randomUUID(),
      }),
      "not_found",
    );
    assert.equal(calls.length, 2, "denials never reach the signer");

    // An ineligible file (not completed, wrong role) is never signed.
    await db.owner.query("ALTER TABLE files DISABLE TRIGGER files_guard");
    try {
      await db.owner.query("UPDATE files SET state = 'failed' WHERE id = $1", [
        clip.files.viewerRrd,
      ]);
      await expectCode(
        issueRead(deps, {
          viewerUserId: actors.staff,
          clipId: clip.clipId,
          role: "viewer_rrd",
        }),
        "not_found",
      );
      await db.owner.query(
        "UPDATE files SET state = 'verified' WHERE id = $1",
        [clip.files.viewerRrd],
      );
      await db.owner.query(
        "UPDATE files SET size_bytes = 134217729, observed_size_bytes = 134217729 WHERE id = $1",
        [clip.files.viewerRrd],
      );
      await expectCode(
        issueRead(deps, {
          viewerUserId: actors.staff,
          clipId: clip.clipId,
          role: "viewer_rrd",
        }),
        "conflict",
      );
    } finally {
      await db.owner.query("ALTER TABLE files ENABLE TRIGGER files_guard");
    }

    // The next request after revocation, rejection or role loss is denied.
    const refs = await db.owner.query<{ permission_ref: string }>(
      "SELECT permission_ref FROM dataset_sharing_permissions WHERE dataset_id = $1",
      [d],
    );
    await revokeSharingPermission(db.owner, {
      permissionRef: refs.rows[0]!.permission_ref,
      revokedBy: "operator",
      reason: "done",
    });
    await expectCode(
      issueRead(deps, {
        viewerUserId: actors.customer,
        clipId: clip.clipId,
        role: "thumbnail_jpeg",
      }),
      "not_found",
    );
  });

  test("a superseded job's files and a staff-only pending clip", async () => {
    const p = await accepted(1);
    const clip = p.clips[0]!;
    const { impl, calls } = signer();
    const deps = { pool: db.app, signer: impl };
    // Staff may read a pending accepted clip; customers never can.
    await issueRead(deps, {
      viewerUserId: actors.staff,
      clipId: clip.clipId,
      role: "thumbnail_jpeg",
    });
    assert.equal(calls.length, 1);
    await expectCode(
      issueRead(deps, {
        viewerUserId: actors.customer,
        clipId: clip.clipId,
        role: "thumbnail_jpeg",
      }),
      "not_found",
    );
    // A superseded result is not readable by anyone.
    await db.owner.query(
      "UPDATE recordings SET current_job_id = NULL WHERE id = $1",
      [p.recordingId],
    );
    await expectCode(
      issueRead(deps, {
        viewerUserId: actors.staff,
        clipId: clip.clipId,
        role: "thumbnail_jpeg",
      }),
      "not_found",
    );
  });
});
