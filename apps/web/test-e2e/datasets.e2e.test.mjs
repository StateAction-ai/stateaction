// REAL DATASET API E2E (SA-35 x SA-15 x SA-13): the production `next build`
// output served by `next start`, real Better Auth sessions/cookies and catalog
// access rows, a throwaway Postgres migrated and seeded by the published
// migrator (Next connects ONLY as the restricted `stateaction_app` role) and
// an S3-compatible bucket for the brokered thumbnail/viewer reads. Operator
// actions (sharing evidence, revocation) use the migration-owner credential.
// Fixture media bytes are synthetic placeholders. Not Google, hosted R2 or
// physical-device qualification.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { browserHeaders, call, signIn, startStack } from "./harness.mjs";

const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const serverRequire = createRequire(join(serverDir, "package.json"));
const pg = serverRequire("pg");
const { S3Client, CreateBucketCommand, PutObjectCommand } =
  serverRequire("@aws-sdk/client-s3");
const dist = (p) => import(new URL(`dist/${p}`, `file://${serverDir}`).href);
const { SEED } = await dist("catalog/seed.js");
const { revokeSharingPermission } = await dist("datasets/operator.js");

let stack, owner, s3;
const jars = {};
before(async () => {
  stack = await startStack({ storage: true });
  s3 = new S3Client({
    endpoint: stack.s3.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: stack.s3.accessKeyId,
      secretAccessKey: stack.s3.secretAccessKey,
    },
  });
  if (!stack.s3.bucket)
    await s3.send(new CreateBucketCommand({ Bucket: stack.env.S3_BUCKET }));
  owner = new pg.Pool({ connectionString: stack.db.ownerUrl, max: 2 });
  for (const label of ["staff", "customer", "outsider", "collector"])
    jars[label] = await signIn(stack, label);
});
after(async () => {
  await owner?.end();
  s3?.destroy();
  await stack?.stop();
});

const get = (jar, path) => call(stack.origin, path, { jar });
const body = (res) => JSON.parse(res.text);
const send = (jar, path, method, payload, extra = {}) =>
  call(stack.origin, path, {
    method,
    jar,
    body: payload === undefined ? undefined : JSON.stringify(payload),
    headers: browserHeaders(stack.origin, extra),
  });

describe("dataset routes through real sessions", () => {
  test("authentication, roles, private headers and the customer catalog boundary", async () => {
    const anonymous = await call(stack.origin, "/api/v1/datasets");
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers["cache-control"], /no-store/);
    assert.equal((await get(jars.collector, "/api/v1/datasets")).status, 403);

    const staff = await get(jars.staff, "/api/v1/datasets");
    assert.equal(staff.status, 200);
    assert.match(staff.headers["cache-control"], /no-store/);
    assert.equal(body(staff).data.datasets.length, 2);

    const customer = await get(jars.customer, "/api/v1/datasets");
    assert.deepEqual(
      body(customer).data.datasets.map((d) => [d.datasetId, d.clipCount]),
      [[SEED.datasets.shared.id, 2]],
    );
    assert.equal("revision" in body(customer).data.datasets[0], false);
    assert.deepEqual(
      body(await get(jars.outsider, "/api/v1/datasets")).data.datasets,
      [],
    );

    // No All clips / recording-wide catalog for customers; private ungranted
    // datasets are indistinguishable from missing ones.
    assert.equal((await get(jars.customer, "/api/v1/clips")).status, 403);
    assert.equal(
      (
        await get(
          jars.customer,
          `/api/v1/datasets/${SEED.datasets.internal.id}`,
        )
      ).status,
      404,
    );
    assert.equal(
      (await get(jars.customer, `/api/v1/clips/${SEED.clips.private}`)).status,
      404,
    );
    assert.equal((await get(jars.staff, "/api/v1/clips")).status, 200);

    const members = await get(
      jars.customer,
      `/api/v1/datasets/${SEED.datasets.shared.id}/clips`,
    );
    const clips = body(members).data.clips;
    assert.deepEqual(
      clips.map((c) => c.clipId).sort(),
      [SEED.clips.shared, SEED.clips.both].sort(),
    );
    for (const secret of [
      "recordingId",
      "jobId",
      "objectKey",
      "sha256",
      "seed-collector-1",
    ])
      assert.equal(members.text.includes(secret), false, secret);
    assert.equal(
      (
        await get(
          jars.customer,
          `/api/v1/datasets/${SEED.datasets.shared.id}/clips?filter=x`,
        )
      ).status,
      422,
    );
  });

  test("mutations need the browser checks, staff role and bounded bodies", async () => {
    const datasetId = "00000000-0000-4000-8000-0000000000e1";
    const create = { datasetId, name: "E2E dataset" };
    assert.equal(
      (
        await call(stack.origin, "/api/v1/datasets", {
          method: "POST",
          jar: jars.staff,
          body: JSON.stringify(create),
          headers: { "content-type": "application/json" },
        })
      ).status,
      403,
      "client header required",
    );
    assert.equal(
      (
        await send(jars.staff, "/api/v1/datasets", "POST", create, {
          "sec-fetch-site": "cross-site",
        })
      ).status,
      403,
    );
    assert.equal(
      (await send(jars.customer, "/api/v1/datasets", "POST", create)).status,
      403,
    );
    assert.equal(
      (
        await send(jars.staff, "/api/v1/datasets", "POST", create, {
          authorization: "Bearer x",
        })
      ).status,
      401,
    );
    const created = await send(jars.staff, "/api/v1/datasets", "POST", create);
    assert.equal(created.status, 201);
    assert.equal(
      (await send(jars.staff, "/api/v1/datasets", "POST", create)).status,
      200,
    );
    const big = await send(jars.staff, "/api/v1/datasets", "POST", {
      ...create,
      name: "x".repeat(70000),
    });
    assert.equal(big.status, 413);
    assert.equal(body(big).error.code, "payload_too_large");

    // Forged additions: a rejected/pending seed clip can never join.
    for (const clipId of [SEED.clips.pending, SEED.clips.rejected]) {
      const res = await send(
        jars.staff,
        `/api/v1/datasets/${datasetId}/clips`,
        "POST",
        {
          clipIds: [clipId],
          expectedRevision: 1,
        },
      );
      assert.equal(res.status, 409);
      assert.equal(res.text.includes("stack"), false);
    }
    const added = await send(
      jars.staff,
      `/api/v1/datasets/${datasetId}/clips`,
      "POST",
      {
        clipIds: [SEED.clips.private],
        expectedRevision: 1,
      },
    );
    assert.deepEqual(body(added).data, { added: 1, revision: 2 });
    // Customers cannot add to datasets even if granted elsewhere.
    assert.equal(
      (
        await send(
          jars.customer,
          `/api/v1/datasets/${datasetId}/clips`,
          "POST",
          { clipIds: [SEED.clips.shared], expectedRevision: 2 },
        )
      ).status,
      403,
    );
  });

  test("brokered reads: signed fetch, role whitelist, denial and revocation", async () => {
    const files = await owner.query(
      `SELECT f.id, f.role, f.object_key FROM clips c
       JOIN files f ON f.id IN (c.thumbnail_file_id, c.viewer_rrd_file_id)
       WHERE c.id = $1`,
      [SEED.clips.shared],
    );
    const thumbnail = Buffer.from("synthetic-thumbnail");
    const rrd = Buffer.from("synthetic-viewer");
    for (const f of files.rows)
      await s3.send(
        new PutObjectCommand({
          Bucket: stack.env.S3_BUCKET,
          Key: f.object_key,
          Body: f.role === "thumbnail_jpeg" ? thumbnail : rrd,
        }),
      );
    const read = (jar, path, role) => send(jar, path, "POST", { role });
    const direct = `/api/v1/clips/${SEED.clips.shared}/reads`;
    const scoped = `/api/v1/datasets/${SEED.datasets.shared.id}/clips/${SEED.clips.shared}/reads`;

    const issued = await read(jars.customer, scoped, "thumbnail_jpeg");
    assert.equal(issued.status, 200);
    assert.match(issued.headers["cache-control"], /no-store/);
    const grant = body(issued).data;
    assert.equal(grant.ttlSeconds, 60);
    const fetched = await fetch(grant.url);
    assert.equal(fetched.status, 200);
    assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), thumbnail);
    const viewer = body(await read(jars.customer, direct, "viewer_rrd")).data;
    assert.deepEqual(
      Buffer.from(await (await fetch(viewer.url)).arrayBuffer()),
      rrd,
    );

    assert.equal((await read(jars.customer, direct, "clip_mp4")).status, 422);
    assert.equal(
      (await read(jars.customer, direct, "source_mcap")).status,
      422,
    );
    assert.equal((await read(jars.outsider, direct, "viewer_rrd")).status, 404);
    assert.equal(
      (
        await read(
          jars.customer,
          `/api/v1/clips/${SEED.clips.private}/reads`,
          "viewer_rrd",
        )
      ).status,
      404,
    );
    assert.equal(
      (await read(jars.collector, direct, "viewer_rrd")).status,
      403,
    );

    // Operator revokes the recipient-sharing evidence: the next request is denied.
    await revokeSharingPermission(owner, {
      permissionRef: "local-seed-share-1",
      revokedBy: "e2e-operator",
      reason: "e2e revocation",
    });
    assert.equal((await read(jars.customer, direct, "viewer_rrd")).status, 404);
    assert.equal(
      (await get(jars.customer, `/api/v1/datasets/${SEED.datasets.shared.id}`))
        .status,
      404,
    );
    assert.deepEqual(
      body(await get(jars.customer, "/api/v1/datasets")).data.datasets,
      [],
    );
    // Staff still read accepted derived files.
    assert.equal(
      (await read(jars.staff, direct, "thumbnail_jpeg")).status,
      200,
    );
  });
});
