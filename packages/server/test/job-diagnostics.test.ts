import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatasetAuthenticate } from "../src/datasets/http.js";
import type { ReadSigner } from "../src/datasets/broker.js";
import {
  diagnosticSlot,
  jobDiagnosticRoutes,
  listJobDiagnostics,
} from "../src/jobs/diagnostics.js";

const JOB = "11111111-1111-4111-8111-111111111111";
const FILE = "22222222-2222-4222-8222-222222222222";

test("diagnostic slots map to their stage and file name", () => {
  assert.deepEqual(diagnosticSlot("diagnostics/segment/log.txt"), {
    stage: "segment",
    name: "log.txt",
  });
  assert.deepEqual(diagnosticSlot("diagnostics/hand_pose/sub/a.jsonl"), {
    stage: "hand_pose",
    name: "sub/a.jsonl",
  });
  for (const slot of [
    "segments.json",
    "diagnostics/log.txt",
    "diagnostics/unknown/log.txt",
    "other/segment/log.txt",
  ])
    assert.equal(diagnosticSlot(slot), null, slot);
});

test("listing groups rows by stage, drops foreign slots and skips non-UUID jobs", async () => {
  const calls: unknown[][] = [];
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      calls.push(params);
      return {
        rows: [
          { id: "a", slot: "diagnostics/caption/log.txt", size_bytes: "5" },
          { id: "b", slot: "diagnostics/bogus/log.txt", size_bytes: "5" },
        ],
      };
    },
  } as never;
  assert.deepEqual(await listJobDiagnostics(pool, "u", JOB), [
    { fileId: "a", stage: "caption", name: "log.txt", sizeBytes: "5" },
  ]);
  assert.deepEqual(calls, [["u", JOB]]);
  assert.deepEqual(await listJobDiagnostics(pool, "u", "nope"), []);
  assert.equal(calls.length, 1);
});

function harness(rows: { object_key: string; size_bytes: string }[]) {
  const signed: unknown[] = [];
  const signer: ReadSigner = {
    presignRead: async (r) => {
      signed.push(r);
      return "https://objects.test/signed?sig=1";
    },
  };
  const authenticate: DatasetAuthenticate = async (_request, need) => {
    assert.equal(need, "staff");
    return { ok: true, principal: { userId: "staff-1" } };
  };
  const queries: unknown[][] = [];
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      queries.push(params);
      return { rows };
    },
  } as never;
  const denied: DatasetAuthenticate = async () => ({
    ok: false,
    response: Response.json({ error: { code: "forbidden" } }, { status: 403 }),
  });
  return { signed, queries, signer, pool, authenticate, denied };
}
const post = () => new Request("http://x/y", { method: "POST" });

test("read route: a refused session never reaches the database or signer", async () => {
  const h = harness([{ object_key: "k", size_bytes: "5" }]);
  const routes = jobDiagnosticRoutes({ ...h, authenticate: h.denied });
  const res = await routes.read(post(), JOB, FILE);
  assert.equal(res.status, 403);
  assert.equal(h.queries.length, 0);
  assert.equal(h.signed.length, 0);
});

test("read route: eligible file gets a 60 s no-store URL for its one key", async () => {
  const h = harness([{ object_key: "outputs/k1", size_bytes: "5" }]);
  const res = await jobDiagnosticRoutes(h).read(post(), JOB, FILE);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control")!, /no-store/);
  const { data } = await res.json();
  assert.equal(data.url, "https://objects.test/signed?sig=1");
  assert.equal(data.ttlSeconds, 60);
  assert.deepEqual(h.queries, [
    ["staff-1", JOB, FILE, ["segment", "caption", "hand_pose"]],
  ]);
  assert.deepEqual(h.signed, [
    {
      key: "outputs/k1",
      expiresInSeconds: 60,
      contentType: "text/plain; charset=utf-8",
    },
  ]);
});

test("read route: no eligible row, malformed ids and oversize files do not sign", async () => {
  const none = harness([]);
  assert.equal(
    (await jobDiagnosticRoutes(none).read(post(), JOB, FILE)).status,
    404,
  );
  assert.equal(
    (await jobDiagnosticRoutes(none).read(post(), "bad", FILE)).status,
    404,
  );
  assert.equal(
    (await jobDiagnosticRoutes(none).read(post(), JOB, "bad")).status,
    404,
  );
  assert.equal(none.queries.length, 1);
  const big = harness([{ object_key: "k", size_bytes: "67108865" }]);
  assert.equal(
    (await jobDiagnosticRoutes(big).read(post(), JOB, FILE)).status,
    409,
  );
  assert.equal(none.signed.length + big.signed.length, 0);
});
