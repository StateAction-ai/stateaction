// SA-27 REAL STAFF JOB-CONTROL E2E: production `next start`, real Better Auth sessions and
// access rows, restricted `stateaction_app` Postgres. Covers role/browser-mutation denial,
// bounded bodies, stale job/state fencing, cancel-is-not-stop, retry only after exact
// termination evidence, idempotent retry (lost response replay), new job + output prefix,
// source-hash re-upload guidance and the server-rendered controls. Synthetic seed data;
// not Render, Modal, Google or device qualification.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { browserHeaders, call, signIn, startStack } from "./harness.mjs";

const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const pg = createRequire(join(serverDir, "package.json"))("pg");
const dist = (p) => import(new URL(`dist/${p}`, `file://${serverDir}`).href);

let stack, owner, ids;
const jars = {};
before(async () => {
  stack = await startStack();
  owner = new pg.Pool({ connectionString: stack.db.ownerUrl, max: 2 });
  const seedEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CATALOG_APP_URL: stack.db.appUrl,
    CATALOG_TEST_OWNER_URL: stack.db.ownerUrl,
    SEED_USERS: JSON.stringify(stack.users),
  };
  const seed = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "test-auth/pipeline-seed-cli.ts",
    ],
    { cwd: serverDir, env: seedEnv, encoding: "utf8" },
  );
  if (seed.status !== 0) throw new Error(seed.stderr);
  ids = JSON.parse(seed.stdout);
  const extra = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "test-auth/job-control-seed-cli.ts",
    ],
    { cwd: serverDir, env: seedEnv, encoding: "utf8" },
  );
  if (extra.status !== 0) throw new Error(extra.stderr);
  ids = { ...ids, ...JSON.parse(extra.stdout) };
  for (const label of ["staff", "customer", "collector"])
    jars[label] = await signIn(stack, label);
});
after(async () => {
  await owner?.end();
  await stack?.stop();
});

const job = async (recordingId) =>
  (
    await owner.query(
      `SELECT j.id, j.state FROM jobs j JOIN recordings r ON r.current_job_id = j.id WHERE r.id = $1`,
      [recordingId],
    )
  ).rows[0];
const send = (jar, jobId, payload, extra = {}) =>
  call(stack.origin, `/api/v1/jobs/${jobId}/control`, {
    method: "POST",
    jar,
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
    headers: browserHeaders(stack.origin, extra),
  });
const cmd = (jobId, action, expectedState, requestId = randomUUID()) => ({
  requestId,
  action,
  jobId,
  expectedState,
});
const json = (res) => JSON.parse(res.text);
const navigate = (path, jar) =>
  call(stack.origin, path, {
    jar,
    headers: {
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    },
  });

describe("staff job control API", () => {
  test("anonymous, collector and customer are refused; browser mutation checks and body bounds hold", async () => {
    const j = await job(ids.live);
    const body = cmd(j.id, "cancel", j.state);
    assert.equal(
      (
        await call(stack.origin, `/api/v1/jobs/${j.id}/control`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: browserHeaders(stack.origin),
        })
      ).status,
      401,
    );
    for (const who of ["collector", "customer"])
      assert.equal((await send(jars[who], j.id, body)).status, 403, who);
    const noHeader = await call(stack.origin, `/api/v1/jobs/${j.id}/control`, {
      method: "POST",
      jar: jars.staff,
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin: stack.origin },
    });
    assert.equal(noHeader.status, 403);
    assert.ok(
      [400, 413].includes(
        (await send(jars.staff, j.id, "x".repeat(70000))).status,
      ),
    );
    assert.equal(
      (await send(jars.staff, j.id, { ...body, extra: 1 })).status,
      400,
    );
    assert.equal(
      (await send(jars.staff, j.id, cmd(randomUUID(), "cancel", j.state)))
        .status,
      400,
      "jobId must match the route",
    );
    assert.equal(
      (await owner.query("SELECT state FROM jobs WHERE id=$1", [j.id])).rows[0]
        .state,
      j.state,
      "nothing mutated",
    );
  });

  test("stale state cannot mutate; cancel is requested, not stopped; retry waits for exact evidence; then idempotent retry creates a new job", async () => {
    const j = await job(ids.live);
    assert.equal(j.state, "result_pending");
    const stale = await send(jars.staff, j.id, cmd(j.id, "cancel", "queued"));
    assert.equal(stale.status, 409);
    assert.match(json(stale).error.message, /^stale_state/);

    const cancel = await send(
      jars.staff,
      j.id,
      cmd(j.id, "cancel", "result_pending"),
    );
    assert.equal(cancel.status, 200);
    assert.equal(json(cancel).data.state, "cancel_requested");
    assert.equal(json(cancel).data.guidance.code, "cancel_pending_termination");
    const slot = async () =>
      (await owner.query("SELECT job_id FROM dispatch_admission WHERE slot=1"))
        .rows[0].job_id;
    assert.equal(await slot(), j.id);

    const early = await send(
      jars.staff,
      j.id,
      cmd(j.id, "retry", "cancel_requested"),
    );
    assert.equal(early.status, 409);
    assert.match(json(early).error.message, /^not_terminal/);
    const check = await send(
      jars.staff,
      j.id,
      cmd(j.id, "reconcile", "cancel_requested"),
    );
    assert.equal(
      json(check).data.state,
      "cancel_requested",
      "no evidence: still not stopped",
    );
    assert.equal(await slot(), j.id);

    // The exact physical evidence arrives (fixture reap); reconcile completes the cancellation.
    await (await dist("jobs/fixtures.js")).fixtureReapJob(owner, j.id);
    const done = await send(
      jars.staff,
      j.id,
      cmd(j.id, "reconcile", "cancel_requested"),
    );
    assert.equal(json(done).data.state, "cancelled");
    assert.equal(await slot(), null);

    const requestId = randomUUID();
    const retry = await send(
      jars.staff,
      j.id,
      cmd(j.id, "retry", "cancelled", requestId),
    );
    assert.equal(retry.status, 201);
    assert.equal(json(retry).data.retryJobId, requestId);
    const replay = await send(
      jars.staff,
      j.id,
      cmd(j.id, "retry", "cancelled", requestId),
    );
    assert.equal(replay.status, 200);
    assert.equal(json(replay).data.replayed, true);
    const other = await send(jars.staff, j.id, cmd(j.id, "retry", "cancelled"));
    assert.equal(
      other.status,
      409,
      "a different request cannot create a second retry",
    );
    assert.match(json(other).error.message, /^already_retried/);
    const changed = await send(
      jars.staff,
      j.id,
      cmd(j.id, "retry", "failed", requestId),
    );
    assert.equal(changed.status, 409, "changed expectedState conflicts");
    assert.match(json(changed).error.message, /^stale_state/);
    const next = await job(ids.live);
    assert.equal(next.id, requestId);
    assert.equal(next.state, "queued");
    // The old attempt is now stale and cannot be cancelled or retried.
    const old = await send(jars.staff, j.id, cmd(j.id, "cancel", "cancelled"));
    assert.equal(old.status, 409);
    assert.equal(
      (
        await owner.query("SELECT previous_job_id FROM jobs WHERE id=$1", [
          requestId,
        ])
      ).rows[0].previous_job_id,
      j.id,
    );
  });

  test("a failed source hash asks for corrected source; a failed job without termination evidence cannot retry", async () => {
    const j = await job(ids.failed);
    assert.equal(j.state, "failed");
    const res = await send(jars.staff, j.id, cmd(j.id, "retry", "failed"));
    assert.equal(res.status, 409);
    assert.match(json(res).error.message, /^source_reupload_required/);
    const page = await navigate(`/pipeline/${ids.failed}`, jars.staff);
    assert.match(page.text, /corrected source/);
    assert.doesNotMatch(page.text, /Retry as new job/);
  });
});

describe("retry of a failed job with proven termination", () => {
  test("the page offers Retry and the API retries once, idempotently", async () => {
    const j = await job(ids.processing);
    assert.equal(j.state, "failed");
    const page = await navigate(`/pipeline/${ids.processing}`, jars.staff);
    assert.match(page.text, /Retry as new job/);
    const requestId = randomUUID();
    const first = await send(
      jars.staff,
      j.id,
      cmd(j.id, "retry", "failed", requestId),
    );
    assert.equal(first.status, 201);
    const again = await send(
      jars.staff,
      j.id,
      cmd(j.id, "retry", "failed", requestId),
    );
    assert.equal(again.status, 200);
    assert.equal(json(again).data.replayed, true);
    assert.equal((await job(ids.processing)).id, requestId);
  });
});

describe("server-rendered controls", () => {
  test("the queued retry attempt shows a Cancel control; stale pages stay fenced by the API", async () => {
    const page = await navigate(`/pipeline/${ids.live}`, jars.staff);
    assert.equal(page.status, 200);
    assert.match(page.text, /data-testid="job-controls"/);
    assert.match(page.text, /Cancel job/);
    assert.doesNotMatch(page.text, /Retry as new job/);
  });
});
