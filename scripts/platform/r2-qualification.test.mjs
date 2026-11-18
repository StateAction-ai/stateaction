import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BudgetExceeded,
  BudgetLedger,
  CONFIG_SCHEMA,
  CaseRecorder,
  ConfigError,
  MIB,
  OPT_IN,
  PART_SIZE,
  RunClock,
  assertNoSecrets,
  assertOwnerOnlyStat,
  readOwnerOnlyConfig,
  RequireFailed,
  corsFacts,
  classifyUnsignedDenial,
  isDenied,
  mainFixture,
  overallVerdict,
  rangePlan,
  safeError,
  staleBytes,
  syntheticBytes,
  uploadPlan,
  validateConfig,
  validateRunPrefix,
  walkListParts,
  withTimeout,
} from "./r2-qualification-lib.mjs";

const ENDPOINT = "https://0123456789abcdef.r2.cloudflarestorage.com";
const base = () => ({
  schema: CONFIG_SCHEMA,
  optIn: OPT_IN,
  provider: {
    endpoint: ENDPOINT,
    region: "auto",
    bucket: "stateaction-dev-private",
    endpointAllowlist: [ENDPOINT],
  },
  credentials: {
    accessKeyId: "AKIAEXAMPLE0001",
    secretAccessKey: "s3cr3t-value-0001",
  },
  runPrefix: "qualification/sa-43/run-20261102-abcdef12/",
  budgets: {
    maxUploadBytes: 150 * MIB,
    maxDownloadBytes: 400 * MIB,
    operationTimeoutMs: 60_000,
    putTimeoutMs: 300_000,
    runDeadlineMs: 900_000,
    cleanupDeadlineMs: 120_000,
  },
  cors: {
    allowedOrigin: "https://app.example.com",
    deniedOrigin: "https://evil.example.com",
  },
  evidenceDir: "/tmp/sa43-evidence-test",
});
const rejects = (mutate, pattern) => {
  const c = base();
  mutate(c);
  assert.throws(
    () => validateConfig(c),
    (e) => e instanceof ConfigError && pattern.test(e.message),
  );
};

test("a complete config validates and plans within the byte budget", () => {
  const cfg = validateConfig(base());
  const plan = uploadPlan(cfg);
  assert.equal(plan.items[0].bytes, PART_SIZE + MIB);
  assert.ok(plan.totalBytes <= 150 * MIB);
  assert.equal(cfg.cleanup, "delete-owned");
});

test("explicit opt-in, schema and unknown keys are enforced", () => {
  rejects((c) => (c.optIn = "yes"), /optIn/);
  rejects((c) => (c.schema = "x"), /schema/);
  rejects((c) => (c.autoDiscover = true), /not a known setting/);
  rejects((c) => (c.budgets.surprise = 1), /not a known setting/);
});

test("endpoint must be allowlisted https R2 (or loopback) origin", () => {
  rejects(
    (c) =>
      (c.provider.endpointAllowlist = [
        "https://other.r2.cloudflarestorage.com",
      ]),
    /allowlist/i,
  );
  rejects((c) => {
    c.provider.endpoint = "http://abc.r2.cloudflarestorage.com";
    c.provider.endpointAllowlist = [c.provider.endpoint];
  }, /https/);
  rejects((c) => {
    c.provider.endpoint = "https://s3.amazonaws.com";
    c.provider.endpointAllowlist = [c.provider.endpoint];
  }, /r2\.cloudflarestorage/);
  rejects((c) => (c.provider.endpoint = `${ENDPOINT}/bucket`), /origin only/);
  const loop = base();
  loop.provider.endpoint = "http://127.0.0.1:9000";
  loop.provider.endpointAllowlist = ["http://127.0.0.1:9000"];
  assert.doesNotThrow(() => validateConfig(loop));
});

test("budgets cannot exceed the hard ceilings and plan must fit", () => {
  rejects((c) => (c.budgets.maxUploadBytes = 151 * MIB), /maxUploadBytes/);
  rejects((c) => (c.budgets.runDeadlineMs = 99_999_999), /runDeadlineMs/);
  rejects((c) => delete c.budgets.operationTimeoutMs, /operationTimeoutMs/);
  rejects((c) => (c.budgets.maxUploadBytes = 66 * MIB), /exceed/);
  rejects((c) => (c.presign = { getTtlSeconds: 3600 }), /getTtlSeconds/);
  rejects(
    (c) => (c.presign = { partUrlTtlSeconds: 3600 }),
    /partUrlTtlSeconds/,
  );
});

test("run prefix must be a unique relative qualification path", () => {
  for (const bad of [
    "",
    "/abs/qualification/x/y/zzzzzzzz/",
    "qualification/../x/yyyyyyyyyyyyyy/",
    "qualification/a/b",
    "recordings/a/bbbbbbbbbbbbbbbbbbbbbbbb/",
    "qualification//a/bbbbbbbbbbbbbbbb/",
    "qualification/a b/cccccccccccccccc/",
  ])
    assert.throws(() => validateRunPrefix(bad), ConfigError, bad);
  assert.equal(
    validateRunPrefix("qualification/sa-43/run-0001-abcdef/"),
    "qualification/sa-43/run-0001-abcdef/",
  );
});

test("cors origins are exact, distinct and wildcard free", () => {
  rejects(
    (c) => (c.cors.allowedOrigin = "https://*.example.com"),
    /exact origin/,
  );
  rejects(
    (c) => (c.cors.allowedOrigin = "https://a.example.com/path"),
    /exact origin/,
  );
  rejects((c) => (c.cors.deniedOrigin = c.cors.allowedOrigin), /differ/);
});

test("evidence inside the repo must be under artifacts/", () => {
  const c = base();
  c.evidenceDir = "/repo/docs/evidence";
  assert.throws(() => validateConfig(c, { repoRoot: "/repo" }), /artifacts/);
  c.evidenceDir = "/repo/artifacts/r2/run1";
  assert.doesNotThrow(() => validateConfig(c, { repoRoot: "/repo" }));
  c.evidenceDir = "/var/tmp/evidence";
  assert.doesNotThrow(() => validateConfig(c, { repoRoot: "/repo" }));
});

test("owner-only config permission check", () => {
  const stat = (mode, uid = 1000, file = true) => ({
    mode,
    uid,
    isFile: () => file,
    isSymbolicLink: () => !file,
  });
  assert.doesNotThrow(() => assertOwnerOnlyStat(stat(0o100600), 1000));
  assert.throws(() => assertOwnerOnlyStat(stat(0o100640), 1000), /owner-only/);
  assert.throws(() => assertOwnerOnlyStat(stat(0o100600, 0), 1000), /owned/);
  assert.throws(
    () => assertOwnerOnlyStat(stat(0o120777, 1000, false), 1000),
    /regular/,
  );
});

test("rrd source needs absolute path, hex sha and counts toward the plan", () => {
  rejects(
    (c) => (c.rrd = { path: "rel.rrd", sha256: "a".repeat(64), sizeBytes: 10 }),
    /absolute/,
  );
  rejects(
    (c) => (c.rrd = { path: "/x.rrd", sha256: "ZZ", sizeBytes: 10 }),
    /sha256/,
  );
  const c = base();
  c.rrd = { path: "/x.rrd", sha256: "a".repeat(64), sizeBytes: 90 * MIB };
  assert.throws(() => validateConfig(c), /exceed/);
  c.rrd.sizeBytes = 10 * MIB;
  c.budgets.maxUploadBytes = 100 * MIB;
  assert.equal(validateConfig(c).rrd.sizeBytes, 10 * MIB);
});

test("budget ledger refuses before I/O", () => {
  const l = new BudgetLedger({ maxUploadBytes: 10, maxDownloadBytes: 5 });
  l.reserveUpload(10);
  assert.throws(() => l.reserveUpload(1), BudgetExceeded);
  l.reserveDownload(5);
  assert.throws(() => l.reserveDownload(1), BudgetExceeded);
  assert.equal(l.snapshot().uploadedBytes, 10);
});

test("run clock bounds every operation and expires", () => {
  let now = 1000;
  const clock = new RunClock(500, () => now);
  assert.equal(clock.boundedTimeout(10_000), 500);
  now = 1400;
  assert.equal(clock.boundedTimeout(10_000), 100);
  now = 1600;
  assert.ok(clock.expired());
  assert.throws(() => clock.boundedTimeout(1), /deadline/);
});

test("withTimeout rejects a hung promise", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 20, "hang"),
    /timed out/,
  );
  assert.equal(await withTimeout(Promise.resolve(7), 20, "ok"), 7);
});

test("safeError keeps only class, status and code", () => {
  const e = Object.assign(new Error("https://x?X-Amz-Signature=abc secret"), {
    name: "NoSuchUpload",
    Code: "NoSuchUpload",
    $metadata: { httpStatusCode: 404 },
  });
  const s = safeError(e);
  assert.deepEqual(s, {
    name: "NoSuchUpload",
    httpStatus: 404,
    code: "NoSuchUpload",
  });
  assert.ok(!JSON.stringify(s).includes("Signature"));
});

test("assertNoSecrets rejects signed URLs and credential values", () => {
  assert.doesNotThrow(() => assertNoSecrets({ ok: 1 }, ["s3cr3t-value-0001"]));
  assert.throws(
    () => assertNoSecrets({ u: "https://h/k?X-Amz-Signature=1" }, []),
    /secret/,
  );
  assert.throws(
    () => assertNoSecrets({ v: "s3cr3t-value-0001" }, ["s3cr3t-value-0001"]),
    /secret/,
  );
});

test("synthetic bytes are deterministic and stale bytes differ at equal length", () => {
  const a = syntheticBytes("x", 4096);
  assert.ok(a.equals(syntheticBytes("x", 4096)));
  assert.ok(!a.equals(syntheticBytes("y", 4096)));
  const stale = staleBytes("x", 4096);
  assert.equal(stale.length, a.length);
  assert.ok(!stale.equals(a));
});

test("main fixture is one exact 64 MiB part plus the tail", () => {
  const f = mainFixture("qualification/t/", 1024);
  assert.equal(f.parts[0].length, PART_SIZE);
  assert.equal(f.parts[1].length, 1024);
  assert.equal(f.sizeBytes, PART_SIZE + 1024);
  assert.match(f.sha256, /^[0-9a-f]{64}$/);
});

test("range plan crosses the part boundary and the EOF edge", () => {
  const r = rangePlan(PART_SIZE + 1024);
  assert.deepEqual(
    r.map((x) => x.name),
    ["first-bytes", "cross-part-boundary", "last-bytes"],
  );
  assert.equal(r[1].start, BigInt(PART_SIZE) - 8n);
  assert.equal(r[2].endInclusive, BigInt(PART_SIZE + 1024) - 1n);
});

test("walkListParts follows markers across MaxParts=1 pages", async () => {
  const all = [
    { PartNumber: 1, ETag: '"a"', Size: 5 },
    { PartNumber: 2, ETag: '"b"', Size: 6 },
  ];
  const markers = [];
  const out = await walkListParts(async (marker) => {
    markers.push(marker);
    const n = Number(marker);
    return {
      Parts: all.slice(n, n + 1),
      IsTruncated: n + 1 < all.length,
      NextPartNumberMarker: String(n + 1),
    };
  });
  assert.deepEqual(markers, ["0", "1"]);
  assert.equal(out.pages.length, 2);
  assert.equal(out.pages[0].isTruncated, true);
  assert.deepEqual(
    out.parts.map((p) => p.partNumber),
    [1, 2],
  );
  await assert.rejects(
    walkListParts(
      async () => ({ Parts: [], IsTruncated: true, NextPartNumberMarker: "1" }),
      { pageLimit: 3 },
    ),
    /terminate/,
  );
});

test("case recorder and verdict fail closed", () => {
  const pass = new CaseRecorder("a");
  pass.begin();
  pass.check("x", true);
  pass.end();
  const empty = new CaseRecorder("b");
  empty.begin();
  empty.end();
  assert.equal(pass.status, "pass");
  assert.equal(
    empty.status,
    "fail",
    "a case with zero assertions never passes",
  );
  const skipped = new CaseRecorder("c");
  skipped.skip("dep");
  const optional = new CaseRecorder("d", { required: false });
  optional.skip("none");
  assert.equal(overallVerdict([pass, optional], { status: "pass" }), "pass");
  assert.equal(
    overallVerdict([pass, skipped], { status: "pass" }),
    "incomplete",
  );
  assert.equal(overallVerdict([pass, empty], { status: "pass" }), "fail");
  assert.equal(overallVerdict([pass], { status: "fail" }), "fail");
  assert.equal(overallVerdict([pass], { status: "uncertain" }), "fail");
  const hard = new CaseRecorder("h");
  hard.begin();
  assert.throws(() => hard.require("must hold", false), RequireFailed);
  assert.equal(hard.assertions.length, 1);
  const thrown = new CaseRecorder("e");
  thrown.begin();
  thrown.check("x", true);
  thrown.fail(new Error("boom"));
  thrown.end();
  assert.equal(thrown.status, "fail");
});

test("classifyUnsignedDenial: strict R2 400 only", () => {
  const xml = "application/xml";
  const exact =
    '<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidArgument</Code><Message>Authorization</Message></Error>';
  const c = (o) => classifyUnsignedDenial(o);
  assert.equal(c({ status: 400, contentType: xml, text: exact }).denied, true);
  assert.equal(c({ status: 403 }).denied, true);
  assert.equal(c({ status: 403, truncated: true }).denied, false);
  assert.equal(
    c({ status: 400, contentType: "text/plain", text: exact }).denied,
    false,
  );
  assert.equal(
    c({
      status: 400,
      contentType: xml,
      text: exact.replace("Authorization</Message>", "Other</Message>"),
    }).denied,
    false,
  );
  assert.equal(
    c({ status: 400, contentType: xml, text: exact.slice(0, -10) }).denied,
    false,
  );
  assert.equal(
    c({ status: 400, contentType: xml, text: exact + "<Key>k</Key>" }).denied,
    false,
  );
  assert.equal(
    c({ status: 400, contentType: xml, text: exact, truncated: true }).denied,
    false,
  );
  assert.equal(c({ status: 400, contentType: xml, text: "" }).denied, false);
  assert.equal(c({ status: 200, contentType: xml, text: exact }).denied, false);
});

test("denied statuses and cors facts", () => {
  assert.ok(isDenied(403) && isDenied(401) && isDenied(404));
  assert.ok(!isDenied(200) && !isDenied(500) && !isDenied(206));
  const facts = corsFacts(
    new Headers({
      "access-control-allow-origin": "https://a.example.com",
      "access-control-allow-methods": "GET, PUT",
      "access-control-expose-headers": "ETag",
    }),
  );
  assert.equal(facts.allowOrigin, "https://a.example.com");
  assert.deepEqual(facts.allowMethods, ["get", "put"]);
  assert.deepEqual(facts.exposeHeaders, ["etag"]);
});

test("config is read from an O_NOFOLLOW descriptor and must be owner-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "sa43-cfg-"));
  const file = join(dir, "c.json");
  writeFileSync(file, '{"a":1}', { mode: 0o600 });
  assert.equal(readOwnerOnlyConfig(file), '{"a":1}');
  chmodSync(file, 0o644);
  assert.throws(() => readOwnerOnlyConfig(file), /owner-only/);
  chmodSync(file, 0o600);
  const link = join(dir, "link.json");
  symlinkSync(file, link);
  assert.throws(() => readOwnerOnlyConfig(link), ConfigError);
  assert.throws(
    () => readOwnerOnlyConfig(join(dir, "missing.json")),
    ConfigError,
  );
});
