import { fixtureAcceptResult } from "../src/jobs/fixtures.js";
import { ownerPoolFor } from "./harness.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { appendReview } from "../src/catalog/catalog.js";
import type { ReadSigner } from "../src/datasets/broker.js";
import {
  datasetRoutes,
  type DatasetAuthenticate,
} from "../src/datasets/http.js";
import {
  clearClips,
  grantDatasetAccess,
  recordSharingPermission,
} from "../src/datasets/operator.js";
import {
  createActors,
  freshDatabase,
  processedRecording,
  type Actors,
  type TestDb,
} from "./harness.js";

let db: TestDb;
let actors: Actors;
before(async () => {
  db = await freshDatabase();
  actors = await createActors(db.owner);
});
after(() => db.close());

/**
 * Test-only authentication boundary: the production one is the Better Auth
 * session guard (covered by the web route tests). It still reads live roles
 * from `access`, exactly like the guard, so role changes take effect per call.
 */
const authenticate: DatasetAuthenticate = async (request, need) => {
  const userId = request.headers.get("x-test-user");
  const deny = (status: number, code: string) => ({
    ok: false as const,
    response: Response.json({ error: { code } }, { status }),
  });
  if (!userId) return deny(401, "unauthenticated");
  const { rows } = await db.owner.query<{ role: string }>(
    "SELECT role FROM access WHERE user_id = $1 AND enabled",
    [userId],
  );
  const roles = rows.map((r) => r.role);
  if (need === "staff" ? !roles.includes("staff") : roles.length === 0)
    return deny(403, "forbidden");
  return { ok: true, principal: { userId } };
};
const signed: string[] = [];
const signer: ReadSigner = {
  async presignRead({ key }) {
    signed.push(key);
    return `https://objects.test/${encodeURIComponent(key)}?sig=1`;
  },
};
const routes = () => datasetRoutes({ pool: db.app, signer, authenticate });
const as = (user: string, init: RequestInit = {}, url = "http://x/y") =>
  new Request(url, {
    ...init,
    headers: {
      "x-test-user": user,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
const json = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
});

describe("dataset HTTP routes", () => {
  test("staff create/add/rename/remove, customer reads, private error envelopes", async () => {
    const p = await processedRecording(db.app, actors, 2);
    await fixtureAcceptResult(ownerPoolFor(db.app), db.app, {
      jobId: p.jobId,
      manifestFileId: p.manifestFileId,
      manifestSha256: p.manifestSha256,
      clips: p.clips,
    });
    const [a, b] = p.clips;
    for (const c of [a!, b!])
      await appendReview(db.app, {
        reviewId: randomUUID(),
        clipId: c.clipId,
        jobId: p.jobId,
        resultManifestSha256: p.manifestSha256,
        reviewerUserId: actors.staff,
        expectedRevision: 0,
        decision: "approved",
        taskLabel: "stir",
        notes: "internal QC remark",
      });
    const r = routes();
    const datasetId = randomUUID();

    // Create (201), replay (200), unknown field and body bounds.
    const created = await r.createDataset(
      as(actors.staff, json({ datasetId, name: "Kitchen" })),
    );
    assert.equal(created.status, 201);
    assert.match(created.headers.get("cache-control")!, /no-store/);
    assert.deepEqual((await created.json()).data, { datasetId, revision: 1 });
    assert.equal(
      (
        await r.createDataset(
          as(actors.staff, json({ datasetId, name: "Kitchen" })),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await r.createDataset(
          as(actors.staff, json({ datasetId, name: "Other" })),
        )
      ).status,
      409,
    );
    const unknown = await r.createDataset(
      as(actors.staff, json({ datasetId, name: "x", admin: true })),
    );
    assert.equal(unknown.status, 422);
    assert.equal((await unknown.json()).error.code, "invalid_request");
    const big = await r.createDataset(
      as(actors.staff, {
        method: "POST",
        body: JSON.stringify({ datasetId, name: "x".repeat(70000) }),
      }),
    );
    assert.equal(big.status, 413);
    assert.equal(
      (
        await r.createDataset(
          as(actors.staff, {
            method: "POST",
            body: "{",
            headers: { "content-type": "application/json" },
          }),
        )
      ).status,
      422,
    );
    assert.equal(
      (
        await r.createDataset(
          as(actors.staff, {
            method: "POST",
            body: "{}",
            headers: { "content-type": "text/plain" },
          }),
        )
      ).status,
      422,
    );

    // Members: bounded batch, expectedRevision, forged pending-style ids.
    const add = await r.addDatasetClips(
      as(
        actors.staff,
        json({ clipIds: [a!.clipId, b!.clipId], expectedRevision: 1 }),
      ),
      datasetId,
    );
    assert.deepEqual((await add.json()).data, { added: 2, revision: 2 });
    assert.equal(
      (
        await r.addDatasetClips(
          as(
            actors.staff,
            json({ clipIds: [randomUUID()], expectedRevision: 2 }),
          ),
          datasetId,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await r.addDatasetClips(
          as(actors.staff, json({ clipIds: [], expectedRevision: 2 })),
          datasetId,
        )
      ).status,
      422,
    );
    assert.equal(
      (await r.getDataset(as(actors.staff), "not-a-uuid")).status,
      422,
    );

    // Customers: nothing until the operator shares; staff routes are refused.
    const list = async (user: string) =>
      (await (await r.listDatasets(as(user))).json()).data.datasets;
    assert.deepEqual(await list(actors.customer), []);
    assert.equal(
      (
        await r.createDataset(
          as(actors.customer, json({ datasetId: randomUUID(), name: "x" })),
        )
      ).status,
      403,
    );
    assert.equal((await r.listClips(as(actors.customer))).status, 403);
    assert.equal(
      (
        await r.addDatasetClips(
          as(
            actors.customer,
            json({ clipIds: [a!.clipId], expectedRevision: 2 }),
          ),
          datasetId,
        )
      ).status,
      403,
    );
    assert.equal((await r.listDatasets(new Request("http://x/y"))).status, 401);

    const permissionRef = `http-${randomUUID().slice(0, 8)}`;
    await recordSharingPermission(db.owner, {
      permissionRef,
      datasetId,
      recipientUserId: actors.customer,
      evidenceRef: "doc:http",
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

    const datasets = await list(actors.customer);
    assert.deepEqual(datasets, [
      { datasetId, name: "Kitchen", clipCount: 2, durationNs: "1800" },
    ]);
    const grid = await r.listDatasetClips(
      as(actors.customer, {}, "http://x/y?limit=1"),
      datasetId,
    );
    const gridBody = await grid.json();
    assert.equal(gridBody.data.clips.length, 1);
    assert.ok(gridBody.data.nextCursor);
    const text = JSON.stringify(gridBody);
    for (const secret of [
      "recordingId",
      "jobId",
      "internal QC",
      "objectKey",
      "object_key",
      "sha256",
      actors.collector,
      actors.staff,
    ])
      assert.equal(
        text.includes(secret),
        false,
        `customer payload leaks ${secret}`,
      );
    assert.equal(
      (
        await r.listDatasetClips(
          as(actors.customer, {}, "http://x/y?filter=all"),
          datasetId,
        )
      ).status,
      422,
      "unknown query parameters are refused",
    );
    assert.equal(
      (await r.listDatasetClips(as(actors.outsider), datasetId)).status,
      404,
    );

    // Reads: dataset context, direct link, role whitelist, no-store.
    const read = await r.readDatasetClip(
      as(actors.customer, json({ role: "viewer_rrd" })),
      datasetId,
      a!.clipId,
    );
    assert.equal(read.status, 200);
    assert.match(read.headers.get("cache-control")!, /no-store/);
    const readBody = (await read.json()).data;
    assert.equal(readBody.role, "viewer_rrd");
    assert.equal(readBody.ttlSeconds, 60);
    assert.ok(readBody.url.startsWith("https://objects.test/"));
    assert.equal(
      (
        await r.readClip(
          as(actors.customer, json({ role: "thumbnail_jpeg" })),
          a!.clipId,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await r.readClip(
          as(actors.customer, json({ role: "clip_mp4" })),
          a!.clipId,
        )
      ).status,
      422,
    );
    assert.equal(
      (
        await r.readClip(
          as(actors.customer, json({ role: "viewer_rrd", extra: 1 })),
          a!.clipId,
        )
      ).status,
      422,
    );
    assert.equal(
      (
        await r.readClip(
          as(actors.outsider, json({ role: "viewer_rrd" })),
          a!.clipId,
        )
      ).status,
      404,
    );
    const signedBefore = signed.length;
    assert.equal(
      (
        await r.readClip(
          as(actors.outsider, json({ role: "viewer_rrd" })),
          b!.clipId,
        )
      ).status,
      404,
    );
    assert.equal(signed.length, signedBefore);

    // Rename and remove with revisions; the customer view follows.
    assert.equal(
      (
        await r.renameDataset(
          as(actors.staff, {
            method: "PATCH",
            body: JSON.stringify({ name: "Kitchen 2", expectedRevision: 2 }),
          }),
          datasetId,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await r.removeDatasetClip(
          as(actors.staff, { method: "DELETE" }),
          datasetId,
          a!.clipId,
        )
      ).status,
      422,
      "expectedRevision is required",
    );
    const removed = await r.removeDatasetClip(
      as(actors.staff, { method: "DELETE" }, "http://x/y?expectedRevision=3"),
      datasetId,
      a!.clipId,
    );
    assert.deepEqual((await removed.json()).data, {
      removed: true,
      revision: 4,
    });
    assert.equal((await list(actors.customer))[0].clipCount, 1);
    assert.equal(
      (
        await r.readClip(
          as(actors.customer, json({ role: "viewer_rrd" })),
          a!.clipId,
        )
      ).status,
      404,
    );

    // Staff catalog: All clips with review status, bounded.
    const all = await (
      await r.listClips(
        as(actors.staff, {}, "http://x/y?reviewStatus=approved&limit=100"),
      )
    ).json();
    assert.ok(all.data.clips.length >= 2);
    assert.equal(
      (await r.listClips(as(actors.staff, {}, "http://x/y?limit=1000"))).status,
      422,
    );
  });
});
