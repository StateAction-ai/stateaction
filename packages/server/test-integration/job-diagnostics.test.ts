import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { DatasetAuthenticate } from "../src/datasets/http.js";
import type { ReadSigner } from "../src/datasets/broker.js";
import {
  jobDiagnosticRoutes,
  listJobDiagnostics,
} from "../src/jobs/diagnostics.js";
import { allocateJobOutput } from "../src/transport/index.js";
import {
  acceptanceDatabase,
  acceptanceDeps,
  runningJob,
  sha,
  uploadOutput,
  type AcceptanceDb,
  type RunningJob,
} from "./acceptance-harness.js";

/**
 * SA-96 staff diagnostic read route and listing against the restricted
 * Postgres role and real output uploads: only a completed diagnostic_blob of
 * the named job is readable, only by staff, with one 60 s URL for one key.
 */
let db: AcceptanceDb;
let deps: Awaited<ReturnType<typeof acceptanceDeps>>;
let a: RunningJob;
let b: RunningJob;
const ids: Record<string, string> = {};
const signed: { key: string; expiresInSeconds: number }[] = [];

before(async () => {
  db = await acceptanceDatabase();
  deps = await acceptanceDeps(db);
  // Running a job retires the previous fixture holder, so upload b's file first.
  b = await runningJob(db);
  const up = async (job: RunningJob, slot: string, role: string) =>
    (await uploadOutput(deps.transport, job, slot, role, Buffer.from(slot)))
      .fileId;
  ids.other = await up(b, "diagnostics/caption/log.txt", "diagnostic_blob");
  a = await runningJob(db);
  ids.log = await up(a, "diagnostics/segment/log.txt", "diagnostic_blob");
  ids.thumb = await up(a, "clips/000/thumbnail.jpg", "thumbnail_jpeg");
  ids.reserved = (
    await allocateJobOutput(deps.transport, a.authority, {
      slot: "diagnostics/caption/pending.txt",
      role: "diagnostic_blob",
      sizeBytes: "3",
      sha256: sha("abc"),
    })
  ).fileId;
});
after(() => db.close());

const signer: ReadSigner = {
  presignRead: async ({ key, expiresInSeconds }) => {
    signed.push({ key, expiresInSeconds });
    return `https://objects.test/${encodeURIComponent(key)}?sig=1`;
  },
};
const authenticate: DatasetAuthenticate = async (request, need) => {
  assert.equal(need, "staff");
  const userId = request.headers.get("x-test-user");
  if (!userId)
    return {
      ok: false,
      response: Response.json(
        { error: { code: "unauthenticated" } },
        { status: 401 },
      ),
    };
  const { rows } = await db.owner.query<{ role: string }>(
    "SELECT role FROM access WHERE user_id = $1 AND enabled",
    [userId],
  );
  if (!rows.some((r) => r.role === "staff"))
    return {
      ok: false,
      response: Response.json(
        { error: { code: "forbidden" } },
        { status: 403 },
      ),
    };
  return { ok: true, principal: { userId } };
};
const routes = () =>
  jobDiagnosticRoutes({ pool: db.app, signer, authenticate });
const read = (user: string | null, job: string, file: string) =>
  routes().read(
    new Request("http://x/y", {
      method: "POST",
      headers: user ? { "x-test-user": user } : {},
    }),
    job,
    file,
  );

test("authorization matrix", async () => {
  const { actors } = db;
  const ok = await read(actors.staff, a.jobId, ids.log!);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("cache-control")!, /no-store/);
  const { data } = await ok.json();
  assert.equal(data.ttlSeconds, 60);
  assert.equal(signed.length, 1);
  assert.match(signed[0]!.key, /^[^?]+$/);
  assert.equal(signed[0]!.expiresInSeconds, 60);

  const before = signed.length;
  const denied: [string, Response][] = [
    ["customer", await read(actors.customer, a.jobId, ids.log!)],
    ["collector", await read(actors.collector, a.jobId, ids.log!)],
    ["outsider", await read(actors.outsider, a.jobId, ids.log!)],
    ["no session", await read(null, a.jobId, ids.log!)],
  ];
  assert.deepEqual(
    denied.map(([, r]) => r.status),
    [403, 403, 403, 401],
  );
  for (const [name, expected] of [
    ["wrong job", await read(actors.staff, b.jobId, ids.log!)],
    ["other job's file", await read(actors.staff, a.jobId, ids.other!)],
    ["non-diagnostic file", await read(actors.staff, a.jobId, ids.thumb!)],
    ["non-completed file", await read(actors.staff, a.jobId, ids.reserved!)],
    [
      "unknown id",
      await read(actors.staff, a.jobId, "99999999-9999-4999-8999-999999999999"),
    ],
  ] as const) {
    assert.equal(expected.status, 404, name);
    assert.equal((await expected.json()).error.code, "not_found", name);
  }
  assert.equal(signed.length, before);
});

test("listing returns only completed diagnostics of that job, staff only", async () => {
  const { actors } = db;
  assert.deepEqual(await listJobDiagnostics(db.app, actors.staff, a.jobId), [
    {
      fileId: ids.log,
      stage: "segment",
      name: "log.txt",
      sizeBytes: String("diagnostics/segment/log.txt".length),
    },
  ]);
  assert.deepEqual(
    await listJobDiagnostics(db.app, actors.customer, a.jobId),
    [],
  );
});
