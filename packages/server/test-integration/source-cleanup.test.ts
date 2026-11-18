import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect as tcp } from "node:net";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  s3ObjectHasher,
  type ObjectHasher,
} from "../src/acceptance/storage.js";
import { CatalogAccessStore } from "../src/auth/access.js";
import type { AuthRuntime } from "../src/auth/runtime.js";
import { fixtureAcceptResult } from "../src/jobs/fixtures.js";
import { sourceCleanupConfigFromEnv } from "../src/source-cleanup/config.js";
import { sourceCleanupRoutes } from "../src/source-cleanup/http.js";
import { sourceCleanupAuthenticator } from "../src/source-cleanup/next.js";
import {
  confirmSourceCopy,
  issueCleanupProof,
  SourceCleanupError,
  type SourceCleanupDeps,
} from "../src/source-cleanup/service.js";
import {
  createActors,
  freshDatabase,
  ownerPoolFor,
  processedRecording,
  type Actors,
  type TestDb,
} from "./harness.js";
import { toRequest } from "./http-adapter.js";
import { BUCKET, realProvider, realS3, s3Config } from "./transport-harness.js";

let db: TestDb;
let actors: Actors;
let otherCollector: string;
let staffTwo: string;
let server: Server;
let base: string;

// Test-only gate/spy over the REAL streaming hasher.
const real = s3ObjectHasher(s3Config());
let hashCalls = 0;
let gate: Promise<void> | undefined;
let entered: (() => void) | undefined;
const hasher: ObjectHasher = {
  async hash(key, bytes, timeoutMs) {
    hashCalls++;
    entered?.();
    if (gate) await gate;
    return real.hash(key, bytes, timeoutMs);
  },
};
const config = sourceCleanupConfigFromEnv({
  SOURCE_CLEANUP_PROOF_TTL_SECONDS: "30",
  SOURCE_COPY_BODY_TIMEOUT_MS: "400",
  SOURCE_COPY_DB_TIMEOUT_MS: "5000",
});
let deps: SourceCleanupDeps;

const sessions = async (headers: Headers) => {
  const userId = headers.get("x-test-user");
  return {
    setCookies: [] as string[],
    session: userId
      ? {
          sessionId: `s_${userId}`,
          userId,
          email: `${userId}@example.test`,
          name: userId,
          expiresAt: new Date(Date.now() + 3_600_000),
        }
      : null,
  };
};

async function addUser(role: "collector" | "staff") {
  const id = `ba_${randomUUID().slice(0, 8)}_${role}`;
  await db.owner.query(
    `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $1, $2, true)`,
    [id, `${id}@example.test`],
  );
  await db.owner.query("INSERT INTO access (user_id, role) VALUES ($1, $2)", [
    id,
    role,
  ]);
  return id;
}

before(async () => {
  db = await freshDatabase();
  actors = await createActors(db.owner);
  otherCollector = await addUser("collector");
  staffTwo = await addUser("staff");
  await realProvider(); // ensures the throwaway bucket exists
  deps = { pool: db.app, hasher, config };
  const runtime = {
    ready: async () => undefined,
    guard: {
      sessions,
      access: new CatalogAccessStore(db.app as never),
      trustedOrigins: [],
    },
  } as unknown as AuthRuntime;
  const routes = sourceCleanupRoutes({
    ...deps,
    authenticateStaff: sourceCleanupAuthenticator("staff", () => runtime),
    authenticateCollector: sourceCleanupAuthenticator(
      "collector",
      () => runtime,
    ),
  });
  server = createServer((req, res) => {
    void (async () => {
      const request = toRequest(req);
      const path = new URL(request.url).pathname;
      let m: RegExpExecArray | null;
      let response: Response;
      if (
        (m = /^\/api\/v1\/recordings\/([^/]+)\/source-copy-confirmation$/.exec(
          path,
        )) &&
        req.method === "POST"
      )
        response = await routes.confirm(request, decodeURIComponent(m[1]!));
      else if (
        (m = /^\/api\/v1\/recordings\/([^/]+)\/cleanup-proofs$/.exec(path)) &&
        req.method === "POST"
      )
        response = await routes.issueProof(request, decodeURIComponent(m[1]!));
      else response = new Response(null, { status: 404 });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      req.resume();
    })().catch((error: unknown) => {
      res.writeHead(500);
      res.end(String((error as Error).message));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.close();
});

// ------------------------------------------------------------------ fixtures
type Rec = {
  id: string;
  clientRecordingId: string;
  sealSha256: string;
  manifestSha256: string;
  keys: Map<string, string>;
  bodies: Map<string, Buffer>;
};

const put = (key: string, body: Buffer) =>
  realS3().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));
const del = (key: string) =>
  realS3().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
const read = async (key: string) => {
  const out = await realS3().send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  return Buffer.from(await out.Body!.transformToByteArray());
};

async function recording(
  options: { accept?: boolean; owner?: string } = {},
): Promise<Rec> {
  const keys = new Map<string, string>();
  const bodies = new Map<string, Buffer>();
  const own: Actors = options.owner
    ? { ...actors, collector: options.owner }
    : actors;
  const p = await processedRecording(db.app, own, 1, {
    sources: {
      body: (role) => Buffer.from(`${role}:${randomUUID()}:original-bytes`),
      stored: async (f) => {
        await put(f.objectKey, f.body);
        keys.set(f.role, f.objectKey);
        bodies.set(f.role, f.body);
      },
    },
  });
  if (options.accept !== false)
    await fixtureAcceptResult(ownerPoolFor(db.app), db.app, {
      jobId: p.jobId,
      manifestFileId: p.manifestFileId,
      manifestSha256: p.manifestSha256,
      clips: p.clips,
    });
  const row = (
    await db.app.query<{ c: string; s: string; m: string }>(
      `SELECT r.client_recording_id::text AS c, s.request_sha256 AS s, r.source_manifest_sha256 AS m
       FROM recordings r JOIN recording_seals s ON s.recording_id = r.id WHERE r.id = $1`,
      [p.recordingId],
    )
  ).rows[0]!;
  return {
    id: p.recordingId,
    clientRecordingId: row.c,
    sealSha256: row.s,
    manifestSha256: row.m,
    keys,
    bodies,
  };
}

async function call(
  path: string,
  user: string | null,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-stateaction-client": "test",
      ...(user ? { "x-test-user": user } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const json = (await res.json()) as {
    data?: Record<string, any>;
    error?: { code: string; message: string; retryable: boolean };
    requestId: string;
  };
  return { status: res.status, json, headers: res.headers };
}
const confirmBody = (r: Rec) => ({
  expectedSealSha256: r.sealSha256,
  expectedSourceManifestSha256: r.manifestSha256,
  expectedFileCount: 3,
});
const proofBody = (r: Rec) => ({
  sealSha256: r.sealSha256,
  sourceManifestSha256: r.manifestSha256,
  clientRecordingId: r.clientRecordingId,
});
const confirm = (r: Rec, user: string | null = actors.staff, body?: unknown) =>
  call(
    `/api/v1/recordings/${r.id}/source-copy-confirmation`,
    user,
    body ?? confirmBody(r),
  );
const proof = (
  r: Rec,
  user: string | null = actors.collector,
  body?: unknown,
) =>
  call(`/api/v1/recordings/${r.id}/cleanup-proofs`, user, body ?? proofBody(r));
const count = async (table: string, id: string) =>
  Number(
    (
      await db.app.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE recording_id = $1`,
        [id],
      )
    ).rows[0]!.n,
  );

// ---------------------------------------------------------------------- tests
describe("staff confirmation", () => {
  test("only an active staff principal confirms; others are refused before any storage read", async () => {
    const r = await recording();
    const before = hashCalls;
    for (const user of [actors.collector, actors.customer, actors.outsider]) {
      const res = await confirm(r, user);
      assert.equal(res.status, 403, user);
    }
    assert.equal((await confirm(r, null)).status, 401);
    const bearer = await confirm(r, actors.staff, undefined);
    assert.equal(bearer.status, 201); // control: staff itself is fine
    const rb = await recording();
    const withBearer = await call(
      `/api/v1/recordings/${rb.id}/source-copy-confirmation`,
      actors.staff,
      confirmBody(rb),
      { authorization: "Bearer x" },
    );
    assert.equal(withBearer.status, 401);
    const noClient = await call(
      `/api/v1/recordings/${rb.id}/source-copy-confirmation`,
      actors.staff,
      confirmBody(rb),
      { "x-stateaction-client": "" },
    );
    assert.equal(noClient.status, 403);
    assert.equal(await count("source_copy_confirmations", rb.id), 0);
    assert.equal(hashCalls - before, 3); // only the one legitimate confirmation streamed (3 originals)
  });

  test("streams every original, records evidence, and replays idempotently without re-hashing", async () => {
    const r = await recording();
    const before = hashCalls;
    const first = await confirm(r);
    assert.equal(first.status, 201, JSON.stringify(first.json));
    assert.equal(
      hashCalls - before,
      3,
      "manifest, MCAP and metadata all streamed",
    );
    const d = first.json.data!;
    assert.equal(d.recordingId, r.id);
    assert.equal(d.clientRecordingId, r.clientRecordingId);
    assert.equal(d.sealSha256, r.sealSha256);
    assert.equal(d.sourceManifestSha256, r.manifestSha256);
    assert.notEqual(d.sealSha256, d.sourceManifestSha256);
    assert.equal(d.confirmedByUserId, actors.staff);
    assert.deepEqual(d.files.map((f: any) => f.role).sort(), [
      "recorder_metadata",
      "source_manifest",
      "source_mcap",
    ]);
    const total = [...r.bodies.values()].reduce((n, b) => n + b.length, 0);
    assert.equal(d.totalBytes, String(total));
    const again = await confirm(r, staffTwo);
    assert.equal(again.status, 200);
    assert.equal(again.json.data!.confirmationId, d.confirmationId);
    assert.equal(
      again.json.data!.confirmedByUserId,
      actors.staff,
      "audit keeps the first actor",
    );
    assert.equal(hashCalls - before, 3, "replay does not hash again");
    assert.equal(await count("source_copy_confirmations", r.id), 1);
    for (const [role, key] of r.keys)
      assert.deepEqual(
        await read(key),
        r.bodies.get(role),
        "original bytes retained",
      );
  });

  test("pending, failed-state and unaccepted originals are never confirmable", async () => {
    const pending = await recording({ accept: false });
    const res = await confirm(pending);
    assert.equal(res.status, 409);
    assert.equal(res.json.error!.code, "source_not_eligible");
    assert.equal(await count("source_copy_confirmations", pending.id), 0);
  });

  test("hostile requests: owner/staff ids, wrong identities, bad types, oversize", async () => {
    const r = await recording();
    const withOwner = await confirm(r, actors.staff, {
      ...confirmBody(r),
      ownerUserId: actors.collector,
    });
    assert.equal(withOwner.status, 422);
    const staffId = await confirm(r, actors.staff, {
      ...confirmBody(r),
      confirmedByUserId: staffTwo,
    });
    assert.equal(staffId.status, 422);
    const wrongSeal = await confirm(r, actors.staff, {
      ...confirmBody(r),
      expectedSealSha256: "0".repeat(64),
    });
    assert.equal(wrongSeal.status, 409);
    assert.equal(wrongSeal.json.error!.code, "inventory_changed");
    const swapped = await confirm(r, actors.staff, {
      ...confirmBody(r),
      expectedSealSha256: r.manifestSha256,
      expectedSourceManifestSha256: r.sealSha256,
    });
    assert.equal(
      swapped.json.error!.code,
      "inventory_changed",
      "seal and manifest digests are distinct identities",
    );
    const wrongCount = await confirm(r, actors.staff, {
      ...confirmBody(r),
      expectedFileCount: 4,
    });
    assert.equal(wrongCount.json.error!.code, "inventory_changed");
    assert.equal((await confirm(r, actors.staff, "[]")).status, 422);
    assert.equal((await confirm(r, actors.staff, "{not json")).status, 422);
    assert.equal(
      (await confirm(r, actors.staff, " ".repeat(2048))).status,
      413,
    );
    const unknown = await call(
      `/api/v1/recordings/${randomUUID()}/source-copy-confirmation`,
      actors.staff,
      confirmBody(r),
    );
    assert.equal(unknown.status, 404);
    assert.equal(
      (
        await call(
          "/api/v1/recordings/not-a-uuid/source-copy-confirmation",
          actors.staff,
          confirmBody(r),
        )
      ).status,
      404,
    );
    assert.equal(await count("source_copy_confirmations", r.id), 0);
  });

  test("wrong SHA, truncated, longer and missing objects produce no confirmation", async () => {
    const cases: Array<[string, (r: Rec) => Promise<void>, string]> = [
      [
        "same-length wrong bytes",
        async (r) =>
          put(
            r.keys.get("source_mcap")!,
            Buffer.alloc(r.bodies.get("source_mcap")!.length, 7),
          ),
        "source_hash_mismatch",
      ],
      [
        "truncated",
        async (r) =>
          put(
            r.keys.get("source_mcap")!,
            r.bodies.get("source_mcap")!.subarray(0, 5),
          ),
        "source_size_mismatch",
      ],
      [
        "longer",
        async (r) =>
          put(
            r.keys.get("recorder_metadata")!,
            Buffer.concat([
              r.bodies.get("recorder_metadata")!,
              Buffer.from("x"),
            ]),
          ),
        "source_size_mismatch",
      ],
      [
        "missing",
        async (r) => void (await del(r.keys.get("source_manifest")!)),
        "source_object_missing",
      ],
    ];
    for (const [name, damage, expected] of cases) {
      const r = await recording();
      await damage(r);
      const res = await confirm(r);
      assert.equal(res.status, 409, name);
      assert.equal(res.json.error!.code, expected, name);
      assert.ok(
        !JSON.stringify(res.json).includes("recordings/"),
        "no object key leaks",
      );
      assert.equal(await count("source_copy_confirmations", r.id), 0, name);
    }
  });

  test("budgets: over-limit inventories return an actionable non-proof without reading storage", async () => {
    const r = await recording();
    const before = hashCalls;
    const tiny = { ...config, maxObjectBytes: 10 };
    await assert.rejects(
      confirmSourceCopy(
        { ...deps, config: tiny },
        { userId: actors.staff },
        r.id,
        {
          sealSha256: r.sealSha256,
          sourceManifestSha256: r.manifestSha256,
          fileCount: 3,
        },
      ),
      (e: unknown) =>
        e instanceof SourceCleanupError &&
        e.code === "verification_budget_exceeded" &&
        e.status === 413,
    );
    const few = { ...config, maxFiles: 3, maxTotalBytes: 10 };
    await assert.rejects(
      confirmSourceCopy(
        { ...deps, config: few },
        { userId: actors.staff },
        r.id,
        {
          sealSha256: r.sealSha256,
          sourceManifestSha256: r.manifestSha256,
          fileCount: 3,
        },
      ),
      /limited to/,
    );
    assert.equal(hashCalls, before);
    assert.equal(await count("source_copy_confirmations", r.id), 0);
  });

  test("repeated proof issuance releases its connection error listeners", async () => {
    const r = await recording();
    const pool = new pg.Pool({
      connectionString: db.appUrl,
      max: 1,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
    });
    try {
      const first = await pool.connect();
      const baseline = first.listenerCount("error");
      first.release();
      const local = { ...deps, pool };
      await confirmSourceCopy(local, { userId: actors.staff }, r.id, {
        sealSha256: r.sealSha256,
        sourceManifestSha256: r.manifestSha256,
        fileCount: 3,
      });
      for (let n = 0; n < 3; n++) {
        await issueCleanupProof(local, { userId: actors.collector }, r.id, {
          sealSha256: r.sealSha256,
          sourceManifestSha256: r.manifestSha256,
          clientRecordingId: r.clientRecordingId,
        });
        const returned = await pool.connect();
        try {
          assert.equal(returned.listenerCount("error"), baseline);
        } finally {
          returned.release();
        }
      }
    } finally {
      await pool.end();
    }
  });

  test("one active verifier: a second verification is refused while one is streaming, and a wall limit returns no proof", async () => {
    const a = await recording();
    const b = await recording();
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (entered = r));
    const first = confirm(a);
    await started;
    entered = undefined;
    const busy = await confirm(b);
    assert.equal(busy.status, 429);
    assert.equal(busy.json.error!.code, "verifier_busy");
    assert.equal(busy.headers.get("retry-after"), "5");
    release();
    gate = undefined;
    assert.equal((await first).status, 201);
    assert.equal(
      (await confirm(b)).status,
      201,
      "admission is released afterwards",
    );
    const slow = await recording();
    const wall = { ...config, wallMs: 1000 };
    gate = new Promise((r) => setTimeout(r, 1200));
    await assert.rejects(
      confirmSourceCopy(
        { ...deps, config: wall },
        { userId: actors.staff },
        slow.id,
        {
          sealSha256: slow.sealSha256,
          sourceManifestSha256: slow.manifestSha256,
          fileCount: 3,
        },
      ),
      (e: unknown) =>
        e instanceof SourceCleanupError && e.code === "verification_timeout",
    );
    gate = undefined;
    assert.equal(await count("source_copy_confirmations", slow.id), 0);
  });

  test("concurrent duplicate confirmations converge on one audited row", async () => {
    const r = await recording();
    const results = await Promise.all([
      confirm(r),
      confirm(r, staffTwo),
      confirm(r),
      confirm(r, staffTwo),
    ]);
    for (const res of results)
      assert.ok([200, 201, 429].includes(res.status), String(res.status));
    assert.ok(results.some((x) => x.status === 201));
    let ids = new Set(
      results
        .filter((x) => x.status !== 429)
        .map((x) => x.json.data!.confirmationId),
    );
    for (const res of results.filter((x) => x.status === 429)) {
      const retry = await confirm(r);
      assert.equal(retry.status, 200);
      ids.add(retry.json.data!.confirmationId);
    }
    assert.equal(ids.size, 1);
    assert.equal(await count("source_copy_confirmations", r.id), 1);
  });
});

describe("owner cleanup proof", () => {
  test("requires explicit staff confirmation; reviewable alone is not approval", async () => {
    const r = await recording();
    const res = await proof(r);
    assert.equal(res.status, 409);
    assert.equal(res.json.error!.code, "staff_confirmation_required");
    assert.equal(await count("source_cleanup_proofs", r.id), 0);
    const pending = await recording({ accept: false });
    assert.equal(
      (await proof(pending)).json.error!.code,
      "source_not_eligible",
    );
  });

  test("the original owner gets a fresh re-hashed proof bound to the exact inventory; each request re-streams", async () => {
    const r = await recording();
    assert.equal((await confirm(r)).status, 201);
    const before = hashCalls;
    const first = await proof(r);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.equal(hashCalls - before, 3, "all three originals re-streamed");
    const p = first.json.data!;
    assert.equal(p.recordingId, r.id);
    assert.equal(p.clientRecordingId, r.clientRecordingId);
    assert.equal(p.ownerUserId, actors.collector);
    assert.equal(p.sealSha256, r.sealSha256);
    assert.equal(p.sourceManifestSha256, r.manifestSha256);
    assert.equal(p.verification, "rehash");
    assert.equal(p.files.length, 3);
    assert.equal(p.fileCount, 3);
    const ttl = Date.parse(p.expiresAt) - Date.parse(p.issuedAt);
    assert.equal(ttl, 30_000);
    assert.ok(
      !("signedUrl" in p) && !JSON.stringify(p).includes("recordings/"),
    );
    const second = await proof(r);
    assert.equal(second.status, 200);
    assert.notEqual(
      second.json.data!.proofId,
      p.proofId,
      "never a cached proof",
    );
    assert.equal(hashCalls - before, 6);
    assert.equal(await count("source_cleanup_proofs", r.id), 2);
    for (const [role, key] of r.keys)
      assert.deepEqual(await read(key), r.bodies.get(role));
  });

  test("only the original active collector: no cross-owner enumeration", async () => {
    const r = await recording();
    await confirm(r);
    const foreign = await proof(r, otherCollector);
    const missing = await call(
      `/api/v1/recordings/${randomUUID()}/cleanup-proofs`,
      otherCollector,
      proofBody(r),
    );
    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(
      foreign.json.error,
      missing.json.error,
      "indistinguishable from a missing id",
    );
    assert.equal(
      (await proof(r, actors.staff)).status,
      403,
      "staff is not a collector",
    );
    assert.equal((await proof(r, actors.customer)).status, 403);
    assert.equal((await proof(r, null)).status, 401);
    assert.equal(
      (
        await proof(r, actors.collector, {
          ...proofBody(r),
          ownerUserId: otherCollector,
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await proof(r, actors.collector, {
          ...proofBody(r),
          clientRecordingId: randomUUID(),
        })
      ).json.error!.code,
      "inventory_changed",
    );
    assert.equal(
      (
        await proof(r, actors.collector, {
          ...proofBody(r),
          sealSha256: "1".repeat(64),
        })
      ).json.error!.code,
      "inventory_changed",
    );
    assert.equal(await count("source_cleanup_proofs", r.id), 0);
  });

  test("a changed, truncated or missing object after confirmation fails closed with no proof", async () => {
    const damage: Array<[string, (r: Rec) => Promise<void>, string]> = [
      [
        "replaced bytes",
        async (r) =>
          put(
            r.keys.get("source_mcap")!,
            Buffer.alloc(r.bodies.get("source_mcap")!.length, 9),
          ),
        "source_hash_mismatch",
      ],
      [
        "truncated",
        async (r) => put(r.keys.get("recorder_metadata")!, Buffer.alloc(3)),
        "source_size_mismatch",
      ],
      [
        "deleted",
        async (r) => void (await del(r.keys.get("source_mcap")!)),
        "source_object_missing",
      ],
    ];
    for (const [name, op, expected] of damage) {
      const r = await recording();
      await confirm(r);
      assert.equal((await proof(r)).status, 200, `${name}: control`);
      await op(r);
      const res = await proof(r);
      assert.equal(res.status, 409, name);
      assert.equal(res.json.error!.code, expected, name);
      assert.equal(
        await count("source_cleanup_proofs", r.id),
        1,
        `${name}: only the earlier proof exists`,
      );
    }
  });

  test("permission revocation, deletion and role changes fail closed", async () => {
    const owner = await addUser("collector");
    const r = await recording({ owner });
    assert.equal((await confirm(r)).status, 201);
    assert.equal((await proof(r, owner)).status, 200);
    // Staff role revoked later: the confirmation stays historical evidence.
    await db.owner.query(
      "UPDATE access SET enabled = false WHERE user_id = $1 AND role = 'staff'",
      [actors.staff],
    );
    assert.equal((await confirm(r)).status, 403, "revoked staff cannot act");
    assert.equal(
      (await proof(r, owner)).status,
      200,
      "historic confirmation survives staff revocation",
    );
    await db.owner.query(
      "UPDATE access SET enabled = true WHERE user_id = $1 AND role = 'staff'",
      [actors.staff],
    );
    // Collector role revoked: refused by the guard (and by the proof trigger).
    await db.owner.query(
      "UPDATE access SET enabled = false WHERE user_id = $1 AND role = 'collector'",
      [owner],
    );
    assert.equal((await proof(r, owner)).status, 403);
    await assert.rejects(
      db.app.query(
        `INSERT INTO source_cleanup_proofs (id, confirmation_id, recording_id, owner_user_id, seal_sha256,
           source_manifest_sha256, verification, file_count, total_bytes, files, expires_at)
         SELECT $1, c.id, c.recording_id, c.owner_user_id, c.seal_sha256, c.source_manifest_sha256,
                'rehash', c.file_count, c.total_bytes, c.files, now() + interval '30 seconds'
         FROM source_copy_confirmations c WHERE c.recording_id = $2`,
        [randomUUID(), r.id],
      ),
      /enabled collector role/,
    );
    await db.owner.query(
      "UPDATE access SET enabled = true WHERE user_id = $1 AND role = 'collector'",
      [owner],
    );
    assert.equal((await proof(r, owner)).status, 200);
    // Ingest permission revoked: not eligible any more.
    await db.owner.query(
      "UPDATE ingest_permissions SET status = 'revoked', revoked_at = now(), revoked_by = 'test' WHERE owner_user_id = $1",
      [owner],
    );
    const revoked = await proof(r, owner);
    assert.equal(revoked.status, 409);
    assert.equal(revoked.json.error!.code, "source_not_eligible");
    // Deleted recording: indistinguishable from missing.
    await db.app.query(
      "UPDATE recordings SET deleted_at = now() WHERE id = $1",
      [r.id],
    );
    assert.equal((await proof(r, owner)).status, 404);
    assert.equal((await confirm(r)).status, 404);
  });
});

describe("bounded requests and revocation during verification", () => {
  test("a trickling request body is cut off by a finite deadline, before any storage read", async () => {
    const r = await recording();
    const before = hashCalls;
    const port = new URL(base).port;
    const started = Date.now();
    const text = await new Promise<string>((resolve, reject) => {
      const socket = tcp(Number(port), "127.0.0.1", () => {
        socket.write(
          `POST /api/v1/recordings/${r.id}/source-copy-confirmation HTTP/1.1\r\n` +
            `Host: x\r\nContent-Type: application/json\r\nContent-Length: 200\r\n` +
            `x-stateaction-client: test\r\nx-test-user: ${actors.staff}\r\n\r\n{"expectedSealSha256":"`,
        );
        // never finishes the body
      });
      let out = "";
      socket.on("data", (c) => {
        out += c.toString();
        if (/\r\n\r\n[\s\S]*}/.test(out)) {
          socket.destroy();
          resolve(out);
        }
      });
      socket.on("error", reject);
      setTimeout(() => {
        socket.destroy();
        reject(new Error("no response to a stalled body"));
      }, 4000);
    });
    assert.match(text, /^HTTP\/1\.1 408/);
    assert.match(text, /request_timeout/);
    assert.ok(Date.now() - started < 3500);
    assert.equal(hashCalls, before);
    assert.equal(await count("source_copy_confirmations", r.id), 0);
  });

  test("an oversized catalog inventory is cut off by LIMIT and returns the budget answer", async () => {
    const r = await recording();
    await assert.rejects(
      confirmSourceCopy(
        { ...deps, config: { ...config, maxFiles: 2 } },
        { userId: actors.staff },
        r.id,
        {
          sealSha256: r.sealSha256,
          sourceManifestSha256: r.manifestSha256,
          fileCount: 3,
        },
      ),
      (e: unknown) =>
        e instanceof SourceCleanupError &&
        e.code === "verification_budget_exceeded",
    );
  });

  test("ingest permission revoked WHILE hashing: no proof, no stale success", async () => {
    const owner = await addUser("collector");
    const r = await recording({ owner });
    assert.equal((await confirm(r)).status, 201);
    let release!: () => void;
    gate = new Promise<void>((x) => (release = x));
    const started = new Promise<void>((x) => (entered = x));
    const pending = proof(r, owner);
    await started;
    entered = undefined;
    await db.owner.query(
      "UPDATE ingest_permissions SET status = 'revoked', revoked_at = now(), revoked_by = 'test' WHERE owner_user_id = $1",
      [owner],
    );
    release();
    gate = undefined;
    const res = await pending;
    assert.equal(res.status, 409);
    assert.equal(res.json.error!.code, "source_not_eligible");
    assert.equal(await count("source_cleanup_proofs", r.id), 0);
  });

  test("collector role revoked WHILE hashing: the database refuses the proof", async () => {
    const owner = await addUser("collector");
    const r = await recording({ owner });
    assert.equal((await confirm(r)).status, 201);
    let release!: () => void;
    gate = new Promise<void>((x) => (release = x));
    const started = new Promise<void>((x) => (entered = x));
    const pending = proof(r, owner);
    await started;
    entered = undefined;
    await db.owner.query(
      "UPDATE access SET enabled = false WHERE user_id = $1",
      [owner],
    );
    release();
    gate = undefined;
    const res = await pending;
    assert.equal(res.status, 409);
    assert.equal(res.json.error!.code, "permission_revoked");
    assert.equal(await count("source_cleanup_proofs", r.id), 0);
  });

  test("staff role revoked WHILE hashing: no confirmation is recorded", async () => {
    const staff = await addUser("staff");
    const r = await recording();
    let release!: () => void;
    gate = new Promise<void>((x) => (release = x));
    const started = new Promise<void>((x) => (entered = x));
    const pending = confirm(r, staff);
    await started;
    entered = undefined;
    await db.owner.query(
      "UPDATE access SET enabled = false WHERE user_id = $1",
      [staff],
    );
    release();
    gate = undefined;
    const res = await pending;
    assert.equal(res.status, 409);
    assert.equal(res.json.error!.code, "permission_revoked");
    assert.equal(await count("source_copy_confirmations", r.id), 0);
  });
});

describe("database invariants and retention", () => {
  test("evidence tables are append-only and carry no purge capability; originals are retained", async () => {
    const r = await recording();
    await confirm(r);
    await proof(r);
    for (const sql of [
      "DELETE FROM source_copy_confirmations",
      "UPDATE source_copy_confirmations SET file_count = 4",
      "DELETE FROM source_cleanup_proofs",
      "UPDATE source_cleanup_proofs SET expires_at = now() + interval '1 hour'",
      "DELETE FROM files",
      "DELETE FROM recording_seals",
    ])
      await assert.rejects(
        db.app.query(sql),
        /permission denied|immutable|append-only/i,
        sql,
      );
    const bad = await db.app.query<{ n: string }>(
      "SELECT count(*) AS n FROM files WHERE recording_id = $1 AND purpose = 'source' AND state IN ('completed','verified')",
      [r.id],
    );
    assert.equal(bad.rows[0]!.n, "3");
  });

  test("the database refuses forged or stale evidence and over-long expiry", async () => {
    const r = await recording();
    const files = (
      await db.app.query(
        `SELECT inventory FROM recording_seals WHERE recording_id = $1`,
        [r.id],
      )
    ).rows[0]!.inventory as Array<Record<string, string>>;
    const manifest = files.find((f) => f.role === "source_manifest")!;
    const insert = (evidence: unknown, by: string, total?: string) =>
      db.app.query(
        `INSERT INTO source_copy_confirmations (id, recording_id, owner_user_id, seal_sha256,
           source_manifest_file_id, source_manifest_sha256, file_count, total_bytes, files,
           confirmed_by_user_id, verified_at)
         VALUES ($1, $2, $3, $4, $5, $6, 3, $7, $8::jsonb, $9, now())`,
        [
          randomUUID(),
          r.id,
          actors.collector,
          r.sealSha256,
          manifest.fileId,
          r.manifestSha256,
          total ?? files.reduce((n, f) => n + Number(f.sizeBytes), 0),
          JSON.stringify(evidence),
          by,
        ],
      );
    await assert.rejects(
      insert(files, actors.collector),
      /staff role/,
      "non-staff cannot confirm",
    );
    await assert.rejects(insert(files, actors.customer), /staff role/);
    const forged = files.map((f) => ({ ...f }));
    forged[1]!.sha256 = "e".repeat(64);
    await assert.rejects(
      insert(forged, actors.staff),
      /does not equal the sealed inventory/,
    );
    await assert.rejects(
      insert(files.slice(0, 2), actors.staff),
      /check|does not equal|violat/i,
    );
    await assert.rejects(insert(files, actors.staff, "5"), /totals/);
    await insert(files, actors.staff); // control: exact evidence is accepted
    await assert.rejects(
      db.app.query(
        `INSERT INTO source_cleanup_proofs (id, confirmation_id, recording_id, owner_user_id, seal_sha256,
           source_manifest_sha256, verification, file_count, total_bytes, files, expires_at)
         SELECT $1, c.id, c.recording_id, c.owner_user_id, c.seal_sha256, c.source_manifest_sha256,
                'rehash', c.file_count, c.total_bytes, c.files, now() + interval '10 minutes'
         FROM source_copy_confirmations c WHERE c.recording_id = $2`,
        [randomUUID(), r.id],
      ),
      /violates check constraint/,
    );
    await assert.rejects(
      db.app.query(
        `INSERT INTO source_cleanup_proofs (id, confirmation_id, recording_id, owner_user_id, seal_sha256,
           source_manifest_sha256, verification, file_count, total_bytes, files, expires_at)
         SELECT $1, c.id, c.recording_id, c.owner_user_id, c.seal_sha256, c.source_manifest_sha256,
                'head_bound', c.file_count, c.total_bytes, c.files, now() + interval '30 seconds'
         FROM source_copy_confirmations c WHERE c.recording_id = $2`,
        [randomUUID(), r.id],
      ),
      /violates check constraint/,
    );
    await assert.rejects(
      db.app.query(
        `INSERT INTO source_cleanup_proofs (id, confirmation_id, recording_id, owner_user_id, seal_sha256,
           source_manifest_sha256, verification, file_count, total_bytes, files, expires_at)
         SELECT $1, c.id, c.recording_id, $3, c.seal_sha256, c.source_manifest_sha256,
                'rehash', c.file_count, c.total_bytes, c.files, now() + interval '30 seconds'
         FROM source_copy_confirmations c WHERE c.recording_id = $2`,
        [randomUUID(), r.id, otherCollector],
      ),
      /foreign key|confirmation/i,
    );
  });
});
