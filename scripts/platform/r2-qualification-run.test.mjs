// Flow regressions: the exact runQualification() used against R2, driven by an
// in-memory S3-like store. No network, no SDK, no real credentials.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CONFIG_SCHEMA,
  MIB,
  OPT_IN,
  validateConfig,
} from "./r2-qualification-lib.mjs";
import { ERROR_BODY_CAP, runQualification } from "./r2-qualification-run.mjs";

const PART = 4096;
const ENDPOINT = "http://127.0.0.1:9000";
const BUCKET = "stateaction-dev-private";
const SECRET = "fake-secret-access-key-0001";

class ProviderUploadGone extends Error {}
class ListPartsCommand {
  constructor(input) {
    this.kind = "ListParts";
    this.input = input;
  }
}
class DeleteObjectCommand {
  constructor(input) {
    this.kind = "Delete";
    this.input = input;
  }
}
class HangCommand {
  constructor() {
    this.kind = "Hang";
  }
}

const md5ish = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

function makeStore(options = {}) {
  const s = {
    options,
    objects: new Map(), // key -> {data, parts}
    uploads: new Map(), // id -> {key, parts: Map, done}
    counters: { create: 0, put: 0, del: 0, complete: 0, abort: 0 },
    completesByKey: {},
    pulled: { range: 0, leak: 0 },
    hangSignalAborted: false,
    nextId: 1,
    t: 0,
  };
  const live = (id, key) => {
    const u = s.uploads.get(id);
    return u && !u.done && u.key === key ? u : null;
  };
  s.now = () => s.t;
  s.sleep = async (ms) => {
    s.t += ms;
  };
  s.provider = {
    async headObject(key) {
      const o = s.objects.get(key);
      return o
        ? {
            sizeBytes: BigInt(o.data.length),
            etag: md5ish(o.data),
            partsCount: o.parts,
          }
        : null;
    },
    async listUploadsForKey(key) {
      return [...s.uploads.entries()]
        .filter(([, u]) => u.key === key && !u.done)
        .map(([id]) => ({ uploadId: id, initiatedAt: null }));
    },
    async createUpload(key) {
      s.counters.create += 1;
      const id = `up${s.nextId++}`;
      s.uploads.set(id, { key, parts: new Map(), done: false });
      return { uploadId: id, initiatedAt: new Date() };
    },
    async abortUpload(key, id) {
      s.counters.abort += 1;
      const u = s.uploads.get(id);
      if (u) u.done = true;
    },
    async completeUpload(key, id, parts) {
      s.counters.complete += 1;
      s.completesByKey[key] = (s.completesByKey[key] ?? 0) + 1;
      if (s.options.hangForever === key) return new Promise(() => {});
      if (s.options.hangAbortable === key)
        await s.control.send(new HangCommand());
      const u = live(id, key);
      assert.ok(u, "complete on a live upload");
      const bufs = parts.map((p) => {
        const got = u.parts.get(p.partNumber);
        assert.ok(got && md5ish(got) === p.etag, "part etag matches");
        return got;
      });
      s.objects.set(key, { data: Buffer.concat(bufs), parts: parts.length });
      u.done = true;
    },
    async readObject(key, range) {
      const o = s.objects.get(key);
      assert.ok(o, "object exists");
      if (range && range.start >= BigInt(o.data.length)) {
        throw Object.assign(new Error("invalid range"), {
          name: "InvalidRange",
          $metadata: { httpStatusCode: 416 },
        });
      }
      const data = range
        ? o.data.subarray(Number(range.start), Number(range.endInclusive) + 1)
        : o.data;
      return (async function* () {
        for (let i = 0; i < data.length; i += 1024)
          yield data.subarray(i, i + 1024);
      })();
    },
    async listParts(key, id, from, to) {
      const u = live(id, key);
      if (!u) throw new ProviderUploadGone();
      return [...u.parts.entries()]
        .sort(([a], [b]) => a - b)
        .filter(([n]) => n >= from && n <= to)
        .map(([n, b]) => ({
          partNumber: n,
          etag: md5ish(b),
          sizeBytes: BigInt(b.length),
        }));
    },
    async presignUploadPart({ key, uploadId, partNumber, lengthBytes }) {
      return `${ENDPOINT}/${BUCKET}/${key}?fake-sign=1&uploadId=${uploadId}&partNumber=${partNumber}&len=${lengthBytes}`;
    },
  };
  s.control = {
    send: async (cmd, opts = {}) => {
      if (cmd.kind === "ListParts") {
        const u = live(cmd.input.UploadId, cmd.input.Key);
        if (!u) throw new ProviderUploadGone();
        const all = [...u.parts.entries()]
          .sort(([a], [b]) => a - b)
          .filter(([n]) => n > Number(cmd.input.PartNumberMarker));
        const page = all.slice(0, cmd.input.MaxParts);
        const last = page.at(-1)?.[0];
        return {
          Parts: page.map(([n, b]) => ({
            PartNumber: n,
            ETag: `"${md5ish(b)}"`,
            Size: b.length,
          })),
          IsTruncated: all.length > page.length,
          NextPartNumberMarker: last === undefined ? undefined : String(last),
        };
      }
      if (cmd.kind === "Delete") {
        s.counters.del += 1;
        s.objects.delete(cmd.input.Key);
        return {};
      }
      if (cmd.kind === "Hang")
        return new Promise((_, reject) => {
          opts.abortSignal?.addEventListener("abort", () => {
            s.hangSignalAborted = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      throw new Error("unexpected command");
    },
  };
  const cors = (origin) =>
    origin === "https://app.example.com"
      ? {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET, PUT",
          "access-control-allow-headers": "range",
          "access-control-expose-headers": "ETag",
        }
      : {};
  const stream = (chunk, onPull, total) => {
    let sent = 0;
    return new ReadableStream({
      pull(c) {
        if (sent >= total) return c.close();
        onPull(chunk.length);
        sent += chunk.length;
        c.enqueue(chunk);
      },
    });
  };
  s.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const origin = init.headers?.origin;
    const key = decodeURIComponent(u.pathname.slice(`/${BUCKET}/`.length));
    if (init.method === "OPTIONS")
      return new Response(null, { status: 200, headers: cors(origin) });
    if (init.method === "PUT") {
      s.counters.put += 1;
      const up = live(u.searchParams.get("uploadId"), key);
      if (!up)
        return new Response("<Error><Code>NoSuchUpload</Code></Error>", {
          status: 404,
          headers: cors(origin),
        });
      const body = Buffer.from(init.body);
      up.parts.set(Number(u.searchParams.get("partNumber")), body);
      return new Response(null, {
        status: 200,
        headers: { etag: `"${md5ish(body)}"`, ...cors(origin) },
      });
    }
    if (!u.searchParams.has("fake-sign")) {
      if (s.options.unsignedLeak && u.pathname.length > BUCKET.length + 2)
        return new Response(
          stream(Buffer.alloc(8192, 1), (n) => (s.pulled.leak += n), 1 << 30),
          { status: 200 },
        );
      if (s.options.unsigned400) {
        const bodies = {
          exact:
            '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidArgument</Code><Message>Authorization</Message></Error>',
          other:
            '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidArgument</Code><Message>Something else</Message></Error>',
          malformed: "<Error><Code>InvalidArgument</Code><Message>Authoriz",
          keys: '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidArgument</Code><Message>Authorization</Message></Error><Key>leak</Key>',
          generic: "bad request",
        };
        return new Response(bodies[s.options.unsigned400], {
          status: s.options.unsigned400 === "ok2xx" ? 200 : 400,
          headers: { "content-type": "application/xml" },
        });
      }
      return new Response("<Error><Code>AccessDenied</Code></Error>", {
        status: 403,
      });
    }
    // presigned GET (virtual-time expiry)
    const ttl = Number(u.searchParams.get("X-Amz-Expires"));
    if (s.now() - Number(u.searchParams.get("at")) > ttl * 1000)
      return new Response("<Error/>", { status: 403 });
    const o = s.objects.get(key);
    if (!o) return new Response("<Error/>", { status: 404 });
    if (s.options.ignoreRange)
      return new Response(
        stream(
          o.data.subarray(0, 1024),
          (n) => (s.pulled.range += n),
          o.data.length,
        ),
        { status: 200 },
      );
    return new Response(o.data.subarray(0, 1), {
      status: 206,
      headers: {
        "content-range": `bytes 0-0/${o.data.length}`,
        ...cors(origin),
      },
    });
  };
  return s;
}

function config(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sa43-run-"));
  return validateConfig({
    schema: CONFIG_SCHEMA,
    optIn: OPT_IN,
    provider: {
      endpoint: ENDPOINT,
      region: "auto",
      bucket: BUCKET,
      endpointAllowlist: [ENDPOINT],
    },
    credentials: { accessKeyId: "AKIAFAKE000001", secretAccessKey: SECRET },
    runPrefix: "qualification/sa-43/run-test-abcdef12/",
    budgets: {
      maxUploadBytes: 150 * MIB,
      maxDownloadBytes: 64 * MIB,
      operationTimeoutMs: 1000,
      putTimeoutMs: 5000,
      runDeadlineMs: 60_000,
      cleanupDeadlineMs: 10_000,
    },
    fixture: { tailBytes: 1000, smallBytes: 2048, abortBytes: 512 },
    presign: { getTtlSeconds: 5, pollIntervalMs: 1000, expiryGraceSeconds: 20 },
    cors: {
      allowedOrigin: "https://app.example.com",
      deniedOrigin: "https://evil.example.com",
    },
    evidenceDir: join(dir, "run"),
    ...overrides,
  });
}

const run = (cfg, store, extra = {}) =>
  runQualification(cfg, {
    provider: store.provider,
    control: store.control,
    ProviderUploadGone,
    ListPartsCommand,
    DeleteObjectCommand,
    planFor: (size) => ({
      sizeBytes: size,
      partSizeBytes: BigInt(PART),
      partCount: Number((size + BigInt(PART) - 1n) / BigInt(PART)),
    }),
    partRange: (plan, n) => {
      const offsetBytes = BigInt(n - 1) * BigInt(PART);
      const rem = plan.sizeBytes - offsetBytes;
      return {
        partNumber: n,
        offsetBytes,
        lengthBytes: rem < BigInt(PART) ? rem : BigInt(PART),
      };
    },
    presignGet: async (key, ttl) =>
      `${ENDPOINT}/${BUCKET}/${key}?fake-sign=1&X-Amz-Expires=${ttl}&at=${store.now()}`,
    fetch: store.fetch,
    partSize: PART,
    settleMs: 50,
    sleep: store.sleep,
    now: store.now,
    ...extra,
  });
const readReport = (r) => JSON.parse(readFileSync(r.reportPath, "utf8"));
const statusOf = (report, id) => report.cases.find((c) => c.id === id)?.status;

test("happy path: every required case passes, only owned state is cleaned", async () => {
  const store = makeStore();
  const result = await run(config(), store);
  const report = readReport(result);
  assert.equal(
    result.verdict,
    "pass",
    JSON.stringify(
      report.cases.filter((c) => c.status !== "pass" && c.required),
    ),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(report.cleanup.status, "pass");
  assert.equal(store.objects.size, 0, "owned objects deleted");
  assert.ok([...store.uploads.values()].every((u) => u.done));
  assert.deepEqual(
    Object.values(store.completesByKey),
    [1, 1],
    "one complete per object",
  );
  assert.equal(statusOf(report, "rrd.immutable-key-private-get"), "not-run");
  assert.ok(report.pendingGates.length >= 6);
  assert.ok(!JSON.stringify(report).includes(SECRET));
  assert.ok(report.usage.uploadedBytes <= report.uploadPlan.totalBytes);
  assert.equal(
    report.cases.find((c) => c.id === "mpu.list-parts-maxparts-1").observations
      .pages.length,
    2,
  );
  assert.ok(existsSync(join(result.reportPath, "..", "ledger.json")));
});

test("a second run with the same evidence directory is refused (one run)", async () => {
  const cfg = config();
  await run(cfg, makeStore());
  await assert.rejects(run(cfg, makeStore()), /EEXIST/);
});

test("collision on any owned key stops before ANY create, PUT, abort or delete", async () => {
  for (const which of ["main", "lost", "abort"]) {
    const store = makeStore();
    const cfg = config();
    const key = `${cfg.runPrefix}${which === "main" ? "main" : which === "lost" ? "lost-reply" : "abort"}/object.bin`;
    store.objects.set(key, { data: Buffer.from("PREEXISTING"), parts: 1 });
    const result = await run(cfg, store);
    const report = readReport(result);
    assert.equal(result.verdict, "fail", which);
    assert.deepEqual(
      store.counters,
      { create: 0, put: 0, del: 0, complete: 0, abort: 0 },
      which,
    );
    assert.equal(
      store.objects.get(key).data.toString(),
      "PREEXISTING",
      "pre-existing data untouched",
    );
    assert.equal(statusOf(report, "preflight.keys-unused"), "fail");
    assert.ok(report.cases.slice(1).every((c) => c.status === "not-run"));
  }
  // an in-flight upload at an owned key is also a collision
  const store = makeStore();
  const cfg = config();
  store.uploads.set("foreign", {
    key: `${cfg.runPrefix}abort/object.bin`,
    parts: new Map(),
    done: false,
  });
  const result = await run(cfg, store);
  assert.equal(result.verdict, "fail");
  assert.equal(
    store.counters.create +
      store.counters.put +
      store.counters.abort +
      store.counters.del,
    0,
  );
  assert.equal(
    store.uploads.get("foreign").done,
    false,
    "foreign upload not aborted",
  );
});

test("a provider that ignores Range fails the probe and is read only to a finite bound", async () => {
  const store = makeStore({ ignoreRange: true });
  const cfg = config({
    fixture: { tailBytes: 1000, smallBytes: MIB, abortBytes: 512 },
  });
  const result = await run(cfg, store);
  const report = readReport(result);
  assert.equal(result.verdict, "fail");
  assert.equal(statusOf(report, "presign.short-get-expiry-renewal"), "fail");
  assert.ok(
    store.pulled.range <= 16 * 1024,
    `pulled ${store.pulled.range} of a 1 MiB object`,
  );
  assert.equal(report.cleanup.status, "pass", "owned state still cleaned");
});

test("an unsigned GET that unexpectedly serves data is cancelled at the body cap", async () => {
  const store = makeStore({ unsignedLeak: true });
  const result = await run(config(), store);
  const report = readReport(result);
  assert.equal(result.verdict, "fail");
  assert.equal(statusOf(report, "access.unsigned-denied"), "fail");
  assert.ok(
    store.pulled.leak <= ERROR_BODY_CAP + 3 * 8192,
    `pulled ${store.pulled.leak}`,
  );
});

test("exact R2 missing-Authorization 400 counts as unsigned denial", async () => {
  const store = makeStore({ unsigned400: "exact" });
  const result = await run(config(), store);
  const report = readReport(result);
  assert.equal(statusOf(report, "access.unsigned-denied"), "pass");
  const text = JSON.stringify(report);
  assert.ok(text.includes("r2-missing-authorization-400"));
  assert.ok(!text.includes("<Error>"), "raw body is never recorded");
});

for (const variant of ["other", "malformed", "keys", "generic"]) {
  test(`unsigned 400 with ${variant} body is not a denial`, async () => {
    const store = makeStore({ unsigned400: variant });
    const result = await run(config(), store);
    const report = readReport(result);
    assert.equal(result.verdict, "fail");
    assert.equal(statusOf(report, "access.unsigned-denied"), "fail");
  });
}

test("an unsettled completion keeps the ledger and never claims cleanup", async () => {
  const cfg = config();
  const store = makeStore({ hangForever: `${cfg.runPrefix}main/object.bin` });
  const result = await run(cfg, store);
  const report = readReport(result);
  assert.equal(result.verdict, "fail");
  assert.equal(statusOf(report, "mpu.complete-head-eof-ranges"), "fail");
  assert.equal(report.cleanup.status, "uncertain");
  assert.equal(
    store.counters.abort + store.counters.del,
    0,
    "no cleanup raced the unknown outcome",
  );
  assert.ok(report.uncertainOperations.includes("complete"));
  assert.ok(
    report.cases.filter((c) => c.status === "not-run").length > 0,
    "later cases did not start",
  );
  const ledger = JSON.parse(
    readFileSync(join(result.reportPath, "..", "ledger.json"), "utf8"),
  );
  assert.ok(ledger.owned.some((o) => o.state === "completing" && o.uploadId));
});

test("a timed-out call is aborted via its signal and settles before moving on", async () => {
  const cfg = config();
  const store = makeStore({ hangAbortable: `${cfg.runPrefix}main/object.bin` });
  const result = await run(cfg, store);
  const report = readReport(result);
  assert.ok(
    store.hangSignalAborted,
    "abort signal reached the underlying call",
  );
  assert.deepEqual(
    report.uncertainOperations,
    [],
    "the call settled after abort",
  );
  assert.equal(result.verdict, "fail");
  assert.equal(
    report.cleanup.status,
    "uncertain",
    "completing state is retained, not cleaned",
  );
  const main = report.cleanup.items.find((i) =>
    i.key.endsWith("main/object.bin"),
  );
  assert.match(main.action, /retained/);
  assert.equal(
    [...store.uploads.values()].find((u) => u.key.endsWith("main/object.bin"))
      .done,
    false,
    "unknown-outcome upload not aborted",
  );
});

test("a refused stale PUT must be an HTTP 4xx and bytes must stay identical", async () => {
  const store = makeStore();
  const orig = store.fetch;
  // A store that wrongly ACCEPTS the stale PUT after completion and mutates the part.
  store.fetch = async (url, init = {}) => {
    if (
      init.method === "PUT" &&
      store.objects.size > 0 &&
      new URL(url).searchParams.get("partNumber") === "2"
    ) {
      store.counters.put += 1;
      const o = store.objects.get(
        decodeURIComponent(new URL(url).pathname.slice(`/${BUCKET}/`.length)),
      );
      if (o)
        o.data = Buffer.concat([
          o.data.subarray(0, o.data.length - 4),
          Buffer.from("EVIL"),
        ]);
      return new Response(null, { status: 200, headers: { etag: '"x"' } });
    }
    return orig(url, init);
  };
  const result = await run(config(), store);
  const report = readReport(result);
  assert.equal(result.verdict, "fail");
  assert.equal(statusOf(report, "stale.part-url-after-complete"), "fail");
  const stale = report.cases.find(
    (c) => c.id === "stale.part-url-after-complete",
  );
  assert.ok(
    stale.assertions.some((a) => a.name.includes("full-EOF SHA") && !a.ok),
    "mutation caught by the full hash",
  );
});
