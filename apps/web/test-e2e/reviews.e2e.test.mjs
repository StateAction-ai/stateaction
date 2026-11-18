// REAL REVIEW COMMAND API E2E (SA-36 x SA-35 x SA-15): production `next build`
// served by `next start`, real Better Auth sessions/cookies and access rows, a
// throwaway Postgres migrated/seeded by the published migrator (Next connects
// only as the restricted application role). Covers authentication/role denial,
// browser mutation protections, bounded bodies, same-body idempotency, changed
// body conflict, and atomic review + dataset assignment. Synthetic seed data;
// not Google, hosted, or physical-device qualification.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
const dist = (p) => import(new URL(`dist/${p}`, `file://${serverDir}`).href);
const { SEED } = await dist("catalog/seed.js");

let stack, owner;
const jars = {};
before(async () => {
  stack = await startStack({ storage: true });
  owner = new pg.Pool({ connectionString: stack.db.ownerUrl, max: 2 });
  for (const label of ["staff", "customer", "outsider", "collector"])
    jars[label] = await signIn(stack, label);
});
after(async () => {
  await owner?.end();
  await stack?.stop();
});

const path = (clipId) => `/api/v1/clips/${clipId}/review`;
const get = (jar, p) => call(stack.origin, p, { jar });
const json = (res) => JSON.parse(res.text);
const send = (jar, p, payload, extra = {}, method = "POST") =>
  call(stack.origin, p, {
    method,
    jar,
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    headers: browserHeaders(stack.origin, extra),
  });
const datasetRevision = async (id) =>
  (await owner.query("SELECT revision FROM datasets WHERE id=$1", [id])).rows[0]
    .revision;
const members = async (clipId) =>
  (
    await owner.query(
      "SELECT dataset_id FROM dataset_clips WHERE clip_id=$1 ORDER BY 1",
      [clipId],
    )
  ).rows.map((r) => r.dataset_id);
const reviewCount = async (clipId) =>
  Number(
    (
      await owner.query("SELECT count(*) n FROM reviews WHERE clip_id=$1", [
        clipId,
      ])
    ).rows[0].n,
  );

describe("clip review API through real sessions", () => {
  test("anonymous, collector, customer and outsider cannot read or review", async () => {
    const clip = SEED.clips.pending;
    assert.equal((await call(stack.origin, path(clip))).status, 401);
    for (const who of ["collector", "customer", "outsider"]) {
      assert.equal((await get(jars[who], path(clip))).status, 403, who);
      const res = await send(jars[who], path(clip), {
        reviewId: randomUUID(),
        expectedReviewRevision: 0,
        jobId: randomUUID(),
        resultManifestSha256: "0".repeat(64),
        decision: "rejected",
      });
      assert.equal(res.status, 403, who);
    }
    assert.equal(await reviewCount(clip), 0);
    const staff = await get(jars.staff, path(clip));
    assert.equal(staff.status, 200);
    assert.match(staff.headers["cache-control"], /no-store/);
    assert.equal(json(staff).data.review.decision, null);
  });

  test("browser protections and bounded bodies", async () => {
    const clip = SEED.clips.pending;
    const state = json(await get(jars.staff, path(clip))).data;
    const cmd = {
      reviewId: randomUUID(),
      expectedReviewRevision: state.review.revision,
      jobId: state.jobId,
      resultManifestSha256: state.resultManifestSha256,
      decision: "approved",
      taskLabel: "grasp",
    };
    const noClient = await call(stack.origin, path(clip), {
      method: "POST",
      jar: jars.staff,
      body: JSON.stringify(cmd),
      headers: { "content-type": "application/json" },
    });
    assert.equal(noClient.status, 403, "client header required");
    assert.equal(
      (
        await send(jars.staff, path(clip), cmd, {
          "sec-fetch-site": "cross-site",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await send(jars.staff, path(clip), cmd, {
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (await send(jars.staff, path(clip), cmd, { authorization: "Bearer x" }))
        .status,
      401,
    );
    const big = await send(jars.staff, path(clip), {
      ...cmd,
      notes: "x".repeat(70000),
    });
    assert.equal(big.status, 413);
    for (const bad of [
      { ...cmd, extra: 1 },
      { ...cmd, taskLabel: "x".repeat(201) },
      { ...cmd, decision: "withdrawn" },
      { ...cmd, reviewId: "nope" },
    ])
      assert.equal((await send(jars.staff, path(clip), bad)).status, 422);
    assert.equal(await reviewCount(clip), 0, "refused requests change nothing");
  });

  test("atomic approve + selection, replay, conflict, reject clears all", async () => {
    const clip = SEED.clips.pending;
    const datasets = [randomUUID(), randomUUID()];
    for (const datasetId of datasets)
      assert.equal(
        (
          await send(jars.staff, "/api/v1/datasets", {
            datasetId,
            name: "Review E2E",
          })
        ).status,
        201,
      );
    const state = json(await get(jars.staff, path(clip))).data;
    assert.equal(state.capabilities.canReview, true);
    const cmd = {
      reviewId: randomUUID(),
      expectedReviewRevision: 0,
      jobId: state.jobId,
      resultManifestSha256: state.resultManifestSha256,
      decision: "approved",
      taskLabel: "pour",
      notes: "internal staff note",
      datasetSelection: {
        datasetIds: datasets,
        expectedRevisions: Object.fromEntries(datasets.map((d) => [d, 1])),
      },
    };
    // A stale dataset revision changes nothing.
    const stale = await send(jars.staff, path(clip), {
      ...cmd,
      reviewId: randomUUID(),
      datasetSelection: {
        ...cmd.datasetSelection,
        expectedRevisions: { [datasets[0]]: 1, [datasets[1]]: 9 },
      },
    });
    assert.equal(stale.status, 409);
    assert.equal(await reviewCount(clip), 0);
    assert.deepEqual(await members(clip), []);

    const first = await send(jars.staff, path(clip), cmd);
    assert.equal(first.status, 201);
    assert.equal(json(first).data.revision, 1);
    assert.deepEqual(await members(clip), [...datasets].sort());
    assert.deepEqual(await Promise.all(datasets.map(datasetRevision)), [2, 2]);
    // Same body: stored result, no new revision, no reapplication.
    const replay = await send(jars.staff, path(clip), cmd);
    assert.equal(replay.status, 200);
    assert.deepEqual(json(replay).data, json(first).data);
    assert.equal(await reviewCount(clip), 1);
    assert.deepEqual(await Promise.all(datasets.map(datasetRevision)), [2, 2]);
    // Changed body with the same key conflicts.
    const changed = await send(jars.staff, path(clip), {
      ...cmd,
      taskLabel: "other",
    });
    assert.equal(changed.status, 409);
    assert.equal(json(changed).error.code, "idempotency_conflict");

    // Notes never reach customers.
    const customerView = await get(jars.customer, `/api/v1/clips/${clip}`);
    assert.equal(customerView.text.includes("internal staff note"), false);

    const reject = await send(jars.staff, path(clip), {
      reviewId: randomUUID(),
      expectedReviewRevision: 1,
      jobId: state.jobId,
      resultManifestSha256: state.resultManifestSha256,
      decision: "rejected",
    });
    assert.equal(reject.status, 201);
    assert.deepEqual(await members(clip), []);
    assert.deepEqual(await Promise.all(datasets.map(datasetRevision)), [3, 3]);
    const after = json(await get(jars.staff, path(clip))).data;
    assert.equal(after.review.decision, "rejected");
    assert.deepEqual(after.memberships, []);
  });
});
