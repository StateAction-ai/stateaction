import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { appendReview, type ReviewInput } from "../src/catalog/catalog.js";
import { fixtureAcceptResult } from "../src/jobs/fixtures.js";
import { createDatasetRecord } from "../src/datasets/mutations.js";
import {
  clearClips,
  grantDatasetAccess,
  recordSharingPermission,
} from "../src/datasets/operator.js";
import { getClipReviewState } from "../src/datasets/review.js";
import {
  createActors,
  expectCode,
  freshDatabase,
  processedRecording,
  type Actors,
  type Processed,
  type TestDb,
} from "./harness.js";

/**
 * SA-36 atomic review + dataset assignment against a real, restricted-role
 * PostgreSQL (the application role, never the owner, runs every command).
 * Each case asserts before/after rows and revisions, not only return values.
 */
let db: TestDb;
let actors: Actors;
before(async () => {
  db = await freshDatabase();
  actors = await createActors(db.owner);
});
after(() => db.close());

const accepted = async (clipCount: number): Promise<Processed> => {
  const p = await processedRecording(db.app, actors, clipCount);
  // Labelled synthetic: the shared fixture follows the real candidate ->
  // verified -> evidence -> accept transitions; no policy flag is disabled.
  await fixtureAcceptResult(db.owner, db.app, {
    jobId: p.jobId,
    manifestFileId: p.manifestFileId,
    manifestSha256: p.manifestSha256,
    clips: p.clips,
  });
  return p;
};
const newDataset = async () => {
  const datasetId = randomUUID();
  await createDatasetRecord(db.app, {
    datasetId,
    name: `ds-${datasetId.slice(0, 6)}`,
    actorUserId: actors.staff,
  });
  return datasetId;
};
const command = (
  p: Processed,
  clipId: string,
  extra: Partial<ReviewInput> = {},
): ReviewInput => ({
  reviewId: randomUUID(),
  clipId,
  jobId: p.jobId,
  resultManifestSha256: p.manifestSha256,
  reviewerUserId: actors.staff,
  expectedRevision: 0,
  decision: "approved",
  taskLabel: "grasp",
  ...extra,
});
const select = (
  revisions: Record<string, number>,
  ids = Object.keys(revisions),
) => ({
  datasetIds: ids,
  expectedRevisions: revisions,
});
type Snapshot = {
  reviews: number;
  members: string[];
  revisions: Record<string, number>;
};
const snapshot = async (
  clipId: string,
  datasets: string[],
): Promise<Snapshot> => {
  const reviews = await db.owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM reviews WHERE clip_id = $1",
    [clipId],
  );
  const members = await db.owner.query<{ dataset_id: string }>(
    "SELECT dataset_id FROM dataset_clips WHERE clip_id = $1 ORDER BY dataset_id",
    [clipId],
  );
  const revs = await db.owner.query<{ id: string; revision: number }>(
    "SELECT id, revision FROM datasets WHERE id = ANY($1::uuid[])",
    [datasets],
  );
  return {
    reviews: Number(reviews.rows[0]?.n),
    members: members.rows.map((r) => r.dataset_id),
    revisions: Object.fromEntries(revs.rows.map((r) => [r.id, r.revision])),
  };
};
const revisionOf = async (id: string) =>
  (await snapshot(randomUUID(), [id])).revisions[id] as number;

describe("approve + selection", () => {
  test("one transaction appends the review and the memberships", async () => {
    const p = await accepted(1);
    const clip = p.clips[0]!.clipId;
    const [a, b] = [await newDataset(), await newDataset()];
    const out = await appendReview(
      db.app,
      command(p, clip, {
        datasetSelection: select({ [a]: 1, [b]: 1 }),
      }),
    );
    assert.equal(out.revision, 1);
    assert.equal(out.replayed, false);
    const after = await snapshot(clip, [a, b]);
    assert.deepEqual(after.members, [a, b].sort());
    assert.deepEqual(after.revisions, { [a]: 2, [b]: 2 });
    assert.equal(after.reviews, 1);
  });

  test("omitted selection preserves; explicit empty clears all", async () => {
    const p = await accepted(1);
    const clip = p.clips[0]!.clipId;
    const a = await newDataset();
    await appendReview(
      db.app,
      command(p, clip, { datasetSelection: select({ [a]: 1 }) }),
    );
    await appendReview(db.app, command(p, clip, { expectedRevision: 1 }));
    let s = await snapshot(clip, [a]);
    assert.deepEqual(s.members, [a], "omission preserves");
    assert.equal(s.revisions[a], 2, "no bump when nothing changed");
    await appendReview(
      db.app,
      command(p, clip, {
        expectedRevision: 2,
        datasetSelection: select({ [a]: 2 }, []),
      }),
    );
    s = await snapshot(clip, [a]);
    assert.deepEqual(s.members, [], "explicit [] clears every membership");
    assert.equal(s.revisions[a], 3);
    // Empty selection on a clip with no memberships is valid.
    const q = await accepted(1);
    await appendReview(
      db.app,
      command(q, q.clips[0]!.clipId, { datasetSelection: select({}, []) }),
    );
  });

  test("blank task label, stale revisions and unknown dataset change nothing", async () => {
    const p = await accepted(1);
    const clip = p.clips[0]!.clipId;
    const a = await newDataset();
    const before = await snapshot(clip, [a]);
    await expectCode(
      appendReview(
        db.app,
        command(p, clip, {
          taskLabel: "   ",
          datasetSelection: select({ [a]: 1 }),
        }),
      ),
      "invalid_request",
    );
    await expectCode(
      appendReview(
        db.app,
        command(p, clip, { datasetSelection: select({ [a]: 7 }) }),
      ),
      "conflict",
    );
    await expectCode(
      appendReview(db.app, command(p, clip, { expectedRevision: 3 })),
      "conflict",
    );
    await expectCode(
      appendReview(
        db.app,
        command(p, clip, { datasetSelection: select({ [randomUUID()]: 1 }) }),
      ),
      "not_found",
    );
    // expectedRevisions must cover exactly the affected datasets.
    await expectCode(
      appendReview(
        db.app,
        command(p, clip, {
          datasetSelection: {
            datasetIds: [a],
            expectedRevisions: { [a]: 1, [randomUUID()]: 1 },
          },
        }),
      ),
      "conflict",
    );
    assert.deepEqual(await snapshot(clip, [a]), before);
  });

  test("wrong job, wrong result hash, unknown clip and non-staff are refused", async () => {
    const p = await accepted(1);
    const clip = p.clips[0]!.clipId;
    const before = await snapshot(clip, []);
    await expectCode(
      appendReview(db.app, command(p, clip, { jobId: randomUUID() })),
      "conflict",
    );
    await expectCode(
      appendReview(
        db.app,
        command(p, clip, { resultManifestSha256: "0".repeat(64) }),
      ),
      "invalid_request",
    );
    await expectCode(
      appendReview(db.app, command(p, randomUUID())),
      "not_found",
    );
    for (const user of [actors.customer, actors.collector, actors.outsider])
      await expectCode(
        appendReview(db.app, command(p, clip, { reviewerUserId: user })),
        "forbidden",
      );
    assert.deepEqual(await snapshot(clip, []), before);
  });
});

describe("reject / withdraw", () => {
  test("removes ALL memberships, bumps each dataset once, reapproval never restores", async () => {
    const p = await accepted(1);
    const clip = p.clips[0]!.clipId;
    const ds = [await newDataset(), await newDataset(), await newDataset()];
    await appendReview(
      db.app,
      command(p, clip, {
        datasetSelection: select(Object.fromEntries(ds.map((d) => [d, 1]))),
      }),
    );
    const mid = await snapshot(clip, ds);
    assert.deepEqual(Object.values(mid.revisions), [2, 2, 2]);
    const out = await appendReview(
      db.app,
      command(p, clip, {
        expectedRevision: 1,
        decision: "rejected",
        taskLabel: undefined,
      }),
    );
    assert.deepEqual(out.removed.sort(), [...ds].sort());
    const after = await snapshot(clip, ds);
    assert.deepEqual(after.members, []);
    assert.deepEqual(Object.values(after.revisions), [3, 3, 3]);
    await appendReview(db.app, command(p, clip, { expectedRevision: 2 }));
    assert.deepEqual((await snapshot(clip, ds)).members, [], "no restore");
    await expectCode(
      appendReview(
        db.app,
        command(p, clip, {
          expectedRevision: 3,
          decision: "rejected",
          datasetSelection: select({}, []),
        }),
      ),
      "invalid_request",
    );
  });
});

describe("idempotency", () => {
  test("identical replay returns the stored review without a new revision", async () => {
    const p = await accepted(1);
    const clip = p.clips[0]!.clipId;
    const a = await newDataset();
    const cmd = command(p, clip, { datasetSelection: select({ [a]: 1 }) });
    const first = await appendReview(db.app, cmd);
    const again = await appendReview(db.app, cmd);
    assert.equal(again.replayed, true);
    assert.deepEqual(again.review, first.review);
    // Replay after a newer review still returns the original stored result.
    await appendReview(db.app, command(p, clip, { expectedRevision: 1 }));
    const late = await appendReview(db.app, cmd);
    assert.deepEqual(late.review, first.review);
    const s = await snapshot(clip, [a]);
    assert.equal(s.reviews, 2);
    assert.equal(s.revisions[a], 2, "replay never reapplies memberships");
  });

  test("changed body, other reviewer or other clip under the same id conflict", async () => {
    const p = await accepted(2);
    const [c1, c2] = [p.clips[0]!.clipId, p.clips[1]!.clipId];
    const a = await newDataset();
    const cmd = command(p, c1);
    await appendReview(db.app, cmd);
    for (const changed of [
      { ...cmd, taskLabel: "other" },
      { ...cmd, notes: "n" },
      { ...cmd, datasetSelection: select({ [a]: 1 }) },
      { ...cmd, datasetSelection: select({}, []) },
      { ...cmd, decision: "rejected" as const },
      { ...cmd, clipId: c2 },
    ])
      await expectCode(appendReview(db.app, changed), "idempotency_conflict");
    assert.equal((await snapshot(c2, [])).reviews, 0);
    // omitted vs explicit-empty selection are different requests.
    const e = command(p, c2, { datasetSelection: select({}, []) });
    await appendReview(db.app, e);
    await expectCode(
      appendReview(db.app, { ...e, datasetSelection: undefined }),
      "idempotency_conflict",
    );
  });
});

describe("sharing clearance", () => {
  test("a clearance failure on a shared dataset rolls back the whole command", async () => {
    const p = await accepted(3);
    const [cleared, other] = [p.clips[0]!.clipId, p.clips[1]!.clipId];
    const shared = await newDataset();
    const plain = await newDataset();
    await appendReview(
      db.app,
      command(p, cleared, { datasetSelection: select({ [shared]: 1 }) }),
    );
    const permissionRef = `ref-${randomUUID().slice(0, 12)}`;
    await recordSharingPermission(db.owner, {
      permissionRef,
      datasetId: shared,
      recipientUserId: actors.customer,
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
    // Clearance needs an approved clip: approve the others (no selection).
    const third = p.clips[2]!.clipId;
    for (const c of [other, third]) await appendReview(db.app, command(p, c));
    const before = await snapshot(other, [shared, plain]);
    const sharedRev = await revisionOf(shared);
    // `other` is not cleared for the recipient: nothing may change, even for
    // the unshared dataset in the same command.
    await expectCode(
      appendReview(
        db.app,
        command(p, other, {
          expectedRevision: 1,
          datasetSelection: select({ [shared]: sharedRev, [plain]: 1 }),
        }),
      ),
      "forbidden",
    );
    assert.deepEqual(await snapshot(other, [shared, plain]), before);
    // Positive control: once the operator clears this exact clip, the same
    // command commits atomically (membership in both datasets, one bump each).
    await clearClips(db.owner, {
      permissionRef,
      clipIds: [other],
      clearedBy: "operator",
    });
    await appendReview(
      db.app,
      command(p, other, {
        expectedRevision: 1,
        datasetSelection: select({ [shared]: sharedRev, [plain]: 1 }),
      }),
    );
    assert.deepEqual(
      (await snapshot(other, [shared, plain])).members,
      [plain, shared].sort(),
    );
    // Revoking the evidence disables the recipient's grant (008 trigger), so
    // the dataset has no enabled recipient and exposes nothing: an addition is
    // then an ordinary staff change. Customers lose visibility on revoke.
    await db.owner.query(
      "UPDATE dataset_sharing_permissions SET status='revoked', revoked_by='op', revoked_at=now() WHERE permission_ref=$1",
      [permissionRef],
    );
    const enabled = await db.owner.query(
      "SELECT count(*)::int AS n FROM dataset_access WHERE dataset_id=$1 AND enabled",
      [shared],
    );
    assert.equal(enabled.rows[0].n, 0);
    await appendReview(
      db.app,
      command(p, third, {
        expectedRevision: 1,
        datasetSelection: select({ [shared]: await revisionOf(shared) }),
      }),
    );
    assert.deepEqual((await snapshot(third, [shared])).members, [shared]);
  });
});

describe("concurrency", () => {
  test("dataset add racing a reject: exactly one serial outcome, never an orphan member", async () => {
    for (let i = 0; i < 5; i++) {
      const p = await accepted(1);
      const clip = p.clips[0]!.clipId;
      const [a, b] = [await newDataset(), await newDataset()];
      await appendReview(
        db.app,
        command(p, clip, { datasetSelection: select({ [a]: 1 }) }),
      );
      const { addDatasetMembers } = await import(
        "../src/datasets/mutations.js"
      );
      const results = await Promise.allSettled([
        appendReview(
          db.app,
          command(p, clip, {
            expectedRevision: 1,
            decision: "rejected",
            taskLabel: undefined,
          }),
        ),
        addDatasetMembers(db.app, {
          datasetId: b,
          clipIds: [clip],
          expectedRevision: 1,
          actorUserId: actors.staff,
        }),
      ]);
      const s = await snapshot(clip, [a, b]);
      const latest = await db.owner.query<{ decision: string }>(
        "SELECT decision FROM reviews WHERE clip_id=$1 ORDER BY revision DESC LIMIT 1",
        [clip],
      );
      assert.equal(latest.rows[0]?.decision, "rejected");
      assert.deepEqual(
        s.members,
        [],
        `no member survives a reject (${JSON.stringify(results.map((r) => r.status))})`,
      );
    }
  });

  test("simultaneous approve+selection commands: one wins, loser changes nothing", async () => {
    const p = await accepted(1);
    const clip = p.clips[0]!.clipId;
    const a = await newDataset();
    const attempts = await Promise.allSettled(
      [0, 1, 2, 3].map(() =>
        appendReview(
          db.app,
          command(p, clip, { datasetSelection: select({ [a]: 1 }) }),
        ),
      ),
    );
    assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of attempts)
      if (r.status === "rejected")
        assert.equal((r.reason as { code: string }).code, "conflict");
    const s = await snapshot(clip, [a]);
    assert.equal(s.reviews, 1);
    assert.equal(s.revisions[a], 2);
  });

  test("opposed dataset order across clips never deadlocks", async () => {
    const p = await accepted(2);
    const [c1, c2] = [p.clips[0]!.clipId, p.clips[1]!.clipId];
    const [a, b] = [await newDataset(), await newDataset()];
    const results = await Promise.all([
      appendReview(
        db.app,
        command(p, c1, {
          datasetSelection: select({ [a]: 1, [b]: 1 }, [a, b]),
        }),
      ),
      appendReview(
        db.app,
        command(p, c2, {
          datasetSelection: select({ [a]: 1, [b]: 1 }, [b, a]),
        }),
      ).catch((e: { code?: string }) => e),
    ]);
    assert.ok(results[0]);
    const revisions = (await snapshot(c1, [a, b])).revisions;
    assert.ok((revisions[a] ?? 0) >= 2);
  });

  test("a held dataset lock fails fast with a retryable conflict and changes nothing", async () => {
    const p = await accepted(1);
    const clip = p.clips[0]!.clipId;
    const a = await newDataset();
    const holder = await db.owner.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM datasets WHERE id=$1 FOR UPDATE", [a]);
      const before = await snapshot(clip, [a]);
      const started = Date.now();
      await expectCode(
        appendReview(
          db.app,
          command(p, clip, { datasetSelection: select({ [a]: 1 }) }),
        ),
        "conflict",
      );
      assert.ok(Date.now() - started < 15_000, "bounded by lock_timeout");
      await holder.query("ROLLBACK");
      assert.deepEqual(await snapshot(clip, [a]), before);
    } finally {
      holder.release();
    }
  });
});

describe("review state read model", () => {
  test("staff only; reflects decision, memberships and bounded datasets", async () => {
    const p = await accepted(1);
    const clip = p.clips[0]!.clipId;
    const a = await newDataset();
    await appendReview(
      db.app,
      command(p, clip, { notes: "ok", datasetSelection: select({ [a]: 1 }) }),
    );
    const state = await getClipReviewState(db.app, {
      viewerUserId: actors.staff,
      clipId: clip,
    });
    assert.equal(state.jobId, p.jobId);
    assert.equal(state.resultManifestSha256, p.manifestSha256);
    assert.equal(state.review.revision, 1);
    assert.equal(state.review.decision, "approved");
    assert.equal(state.capabilities.canReview, true);
    assert.deepEqual(
      state.memberships.map((m) => m.datasetId),
      [a],
    );
    assert.equal(state.memberships[0]?.revision, 2);
    assert.equal(state.membershipsTruncated, false);
    assert.ok(state.availableDatasets.find((d) => d.datasetId === a)?.member);
    for (const user of [actors.customer, actors.collector, actors.outsider])
      await expectCode(
        getClipReviewState(db.app, { viewerUserId: user, clipId: clip }),
        "forbidden",
      );
    await expectCode(
      getClipReviewState(db.app, {
        viewerUserId: actors.staff,
        clipId: randomUUID(),
      }),
      "not_found",
    );
  });
});

describe("quality checks projection", () => {
  test("allowlists safe fields and preserves measured / not_evaluated", async () => {
    const { projectQualityChecks } = await import("../src/datasets/review.js");
    assert.deepEqual(projectQualityChecks(null), {
      status: "not_evaluated",
      checks: [],
    });
    assert.deepEqual(projectQualityChecks([]), {
      status: "not_evaluated",
      checks: [],
    });
    const out = projectQualityChecks([
      {
        code: "hand_detection_summary",
        status: "measured",
        message: "/srv/secret/path",
        rule_revision: 1,
        measurements: { frames: "12", bad: "x", "Bad Key": "1" },
      },
      { code: "Bad Code", status: "pass" },
      { code: "other", status: "weird" },
    ]);
    assert.deepEqual(out, {
      status: "evaluated",
      checks: [
        {
          id: "hand_detection_summary",
          status: "measured",
          ruleRevision: 1,
          measurements: { frames: "12" },
        },
        { id: "other", status: "unknown" },
      ],
    });
    assert.equal(JSON.stringify(out).includes("secret"), false);
  });

  test("retains every contract-bounded check (a fail at position 33 survives)", async () => {
    const { projectQualityChecks } = await import("../src/datasets/review.js");
    const raw = Array.from({ length: 64 }, (_, i) => ({
      code: `check_${i}`,
      status: i === 32 ? "fail" : "pass",
      message: "m",
      rule_revision: 1,
    }));
    const out = projectQualityChecks(raw);
    assert.equal(out.checks.length, 64);
    assert.equal(out.checks[32]?.status, "fail");
  });
});
