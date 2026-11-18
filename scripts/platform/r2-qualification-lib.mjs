// Pure helpers for the SA-43 provider-qualification harness. No network, no
// provider SDK and no module-level side effects: everything here is unit tested
// without services. The runner (qualify-r2-transfers.mjs) owns all I/O.
import { createCipheriv, createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const CONFIG_SCHEMA = "stateaction.r2-qualification-config.v1";
export const REPORT_SCHEMA = "stateaction.r2-qualification-report.v1";
export const OPT_IN = "stateaction-sa43-real-r2-transfer";

export const MIB = 1024 * 1024;
export const PART_SIZE = 64 * MIB;
/** Hard ceilings the config may not exceed (task budget: ~150 MiB uploaded). */
export const LIMITS = Object.freeze({
  maxUploadBytes: 150 * MIB,
  maxDownloadBytes: 512 * MIB,
  maxOperationTimeoutMs: 300_000,
  maxRunDeadlineMs: 1_800_000,
  maxCleanupDeadlineMs: 300_000,
  maxPutTimeoutMs: 600_000,
  maxPartUrlTtlSeconds: 900,
  minGetTtlSeconds: 5,
  maxGetTtlSeconds: 60,
});

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

const fail = (message) => {
  throw new ConfigError(message);
};

function exactKeys(value, allowed, where) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${where} must be an object`);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${where}.${key} is not a known setting`);
}

function int(value, where, min, max) {
  if (!Number.isInteger(value) || value < min || value > max)
    fail(`${where} must be an integer in [${min}, ${max}]`);
  return value;
}

function str(value, where) {
  if (typeof value !== "string" || value.length === 0)
    fail(`${where} must be a non-empty string`);
  return value;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const isLoopbackHost = (hostname) => LOOPBACK.has(hostname);

/**
 * Owner-only config: regular file (not a symlink), owned by the caller, no
 * group/other permission bits. The caller passes the stat so tests need no fs.
 */
export function assertOwnerOnlyStat(stat, uid) {
  if (!stat.isFile() || stat.isSymbolicLink())
    fail("config must be a regular file, not a symlink");
  if (uid !== undefined && stat.uid !== uid)
    fail("config must be owned by the invoking user");
  if ((stat.mode & 0o077) !== 0)
    fail("config must be owner-only (mode 0600): group/other bits are set");
}

/**
 * Opens without following symlinks, checks the OPEN descriptor (same inode we
 * then read, so there is no check/use gap), and reads at most 64 KiB from it.
 * The file holds real credentials.
 */
export function readOwnerOnlyConfig(path, uid = process.getuid?.()) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return fail("config could not be opened (missing, or a symlink)");
  }
  try {
    const stat = fstatSync(fd);
    assertOwnerOnlyStat(
      {
        mode: stat.mode,
        uid: stat.uid,
        isFile: () => stat.isFile(),
        isSymbolicLink: () => false,
      },
      uid,
    );
    if (stat.size > 65_536) fail("config is unreasonably large");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Run prefix: unique per run, ends with "/", no traversal, never a prod root. */
export function validateRunPrefix(prefix) {
  str(prefix, "runPrefix");
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*\/$/.test(prefix))
    fail("runPrefix must be relative, [A-Za-z0-9._-/] only and end with '/'");
  if (prefix.includes("//") || prefix.split("/").some((s) => s === ".."))
    fail("runPrefix must not contain empty or '..' segments");
  if (prefix.length < 24 || prefix.length > 200)
    fail("runPrefix must be 24-200 characters (include a unique run id)");
  const segments = prefix.split("/").filter(Boolean);
  if (segments.length < 3) fail("runPrefix needs at least 3 path segments");
  if (!segments[0].startsWith("qualification"))
    fail("runPrefix must start with a 'qualification…' segment");
  return prefix;
}

/**
 * Validates and normalizes the explicit config. Nothing is read from the
 * environment: the file is the only source of endpoint, bucket, credentials,
 * prefix, budgets and evidence destination.
 */
export function validateConfig(raw, { repoRoot } = {}) {
  exactKeys(
    raw,
    [
      "schema",
      "optIn",
      "provider",
      "credentials",
      "runPrefix",
      "budgets",
      "fixture",
      "presign",
      "cors",
      "rrd",
      "cleanup",
      "evidenceDir",
    ],
    "config",
  );
  if (raw.schema !== CONFIG_SCHEMA) fail(`schema must be ${CONFIG_SCHEMA}`);
  if (raw.optIn !== OPT_IN) fail(`optIn must be exactly "${OPT_IN}"`);

  exactKeys(
    raw.provider,
    ["endpoint", "region", "bucket", "endpointAllowlist"],
    "provider",
  );
  const endpointUrl = (() => {
    try {
      return new URL(str(raw.provider.endpoint, "provider.endpoint"));
    } catch {
      return fail("provider.endpoint is not a URL");
    }
  })();
  if (endpointUrl.pathname !== "/" || endpointUrl.search || endpointUrl.hash)
    fail("provider.endpoint must be an origin only");
  if (endpointUrl.username || endpointUrl.password)
    fail("provider.endpoint must not embed credentials");
  const allow = raw.provider.endpointAllowlist;
  if (!Array.isArray(allow) || allow.length === 0 || allow.length > 4)
    fail("provider.endpointAllowlist must list 1-4 exact origins");
  if (!allow.every((o) => typeof o === "string" && o === new URL(o).origin))
    fail("provider.endpointAllowlist entries must be exact origins");
  if (!allow.includes(endpointUrl.origin))
    fail("provider.endpoint is not in provider.endpointAllowlist");
  const loopback = isLoopbackHost(endpointUrl.hostname);
  if (!loopback) {
    if (endpointUrl.protocol !== "https:")
      fail("provider.endpoint must be https");
    if (!endpointUrl.hostname.endsWith(".r2.cloudflarestorage.com"))
      fail("provider.endpoint must be a *.r2.cloudflarestorage.com host");
  }
  const bucket = str(raw.provider.bucket, "provider.bucket");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))
    fail("provider.bucket is not a valid bucket name");
  const region = str(raw.provider.region, "provider.region");

  exactKeys(raw.credentials, ["accessKeyId", "secretAccessKey"], "credentials");
  const credentials = {
    accessKeyId: str(raw.credentials.accessKeyId, "credentials.accessKeyId"),
    secretAccessKey: str(
      raw.credentials.secretAccessKey,
      "credentials.secretAccessKey",
    ),
  };

  const b = raw.budgets ?? {};
  exactKeys(
    b,
    [
      "maxUploadBytes",
      "maxDownloadBytes",
      "operationTimeoutMs",
      "putTimeoutMs",
      "runDeadlineMs",
      "cleanupDeadlineMs",
    ],
    "budgets",
  );
  const budgets = {
    maxUploadBytes: int(
      b.maxUploadBytes,
      "budgets.maxUploadBytes",
      1,
      LIMITS.maxUploadBytes,
    ),
    maxDownloadBytes: int(
      b.maxDownloadBytes,
      "budgets.maxDownloadBytes",
      1,
      LIMITS.maxDownloadBytes,
    ),
    operationTimeoutMs: int(
      b.operationTimeoutMs,
      "budgets.operationTimeoutMs",
      1000,
      LIMITS.maxOperationTimeoutMs,
    ),
    putTimeoutMs: int(
      b.putTimeoutMs,
      "budgets.putTimeoutMs",
      1000,
      LIMITS.maxPutTimeoutMs,
    ),
    runDeadlineMs: int(
      b.runDeadlineMs,
      "budgets.runDeadlineMs",
      10_000,
      LIMITS.maxRunDeadlineMs,
    ),
    cleanupDeadlineMs: int(
      b.cleanupDeadlineMs,
      "budgets.cleanupDeadlineMs",
      5000,
      LIMITS.maxCleanupDeadlineMs,
    ),
  };

  const f = raw.fixture ?? {};
  exactKeys(f, ["tailBytes", "smallBytes", "abortBytes"], "fixture");
  const fixture = {
    tailBytes: int(f.tailBytes ?? MIB, "fixture.tailBytes", 1, 8 * MIB),
    smallBytes: int(f.smallBytes ?? MIB, "fixture.smallBytes", 1, 8 * MIB),
    abortBytes: int(f.abortBytes ?? 262_144, "fixture.abortBytes", 1, 8 * MIB),
  };

  const p = raw.presign ?? {};
  exactKeys(
    p,
    [
      "partUrlTtlSeconds",
      "getTtlSeconds",
      "pollIntervalMs",
      "expiryGraceSeconds",
    ],
    "presign",
  );
  const presign = {
    partUrlTtlSeconds: int(
      p.partUrlTtlSeconds ?? 600,
      "presign.partUrlTtlSeconds",
      60,
      LIMITS.maxPartUrlTtlSeconds,
    ),
    getTtlSeconds: int(
      p.getTtlSeconds ?? 10,
      "presign.getTtlSeconds",
      LIMITS.minGetTtlSeconds,
      LIMITS.maxGetTtlSeconds,
    ),
    pollIntervalMs: int(
      p.pollIntervalMs ?? 1000,
      "presign.pollIntervalMs",
      250,
      10_000,
    ),
    expiryGraceSeconds: int(
      p.expiryGraceSeconds ?? 20,
      "presign.expiryGraceSeconds",
      5,
      60,
    ),
  };

  exactKeys(raw.cors, ["allowedOrigin", "deniedOrigin"], "cors");
  const origin = (value, where) => {
    str(value, where);
    let u;
    try {
      u = new URL(value);
    } catch {
      return fail(`${where} is not a URL`);
    }
    if (u.origin !== value || value.includes("*"))
      fail(`${where} must be one exact origin, no wildcard or path`);
    return value;
  };
  const cors = {
    allowedOrigin: origin(raw.cors.allowedOrigin, "cors.allowedOrigin"),
    deniedOrigin: origin(raw.cors.deniedOrigin, "cors.deniedOrigin"),
  };
  if (cors.allowedOrigin === cors.deniedOrigin)
    fail("cors.deniedOrigin must differ from cors.allowedOrigin");

  let rrd = null;
  if (raw.rrd !== undefined && raw.rrd !== null) {
    exactKeys(raw.rrd, ["path", "sha256", "sizeBytes"], "rrd");
    if (!isAbsolute(str(raw.rrd.path, "rrd.path")))
      fail("rrd.path must be absolute");
    if (!/^[0-9a-f]{64}$/.test(str(raw.rrd.sha256, "rrd.sha256")))
      fail("rrd.sha256 must be 64 lowercase hex characters");
    rrd = {
      path: raw.rrd.path,
      sha256: raw.rrd.sha256,
      sizeBytes: int(
        raw.rrd.sizeBytes,
        "rrd.sizeBytes",
        1,
        LIMITS.maxUploadBytes,
      ),
    };
  }

  const cleanup = raw.cleanup ?? "delete-owned";
  if (cleanup !== "delete-owned" && cleanup !== "keep-owned")
    fail('cleanup must be "delete-owned" or "keep-owned"');

  const evidenceDir = str(raw.evidenceDir, "evidenceDir");
  if (!isAbsolute(evidenceDir)) fail("evidenceDir must be absolute");
  if (repoRoot) {
    const rel = relative(resolve(repoRoot), resolve(evidenceDir));
    const insideRepo = !rel.startsWith("..") && !isAbsolute(rel);
    const ignored = rel.split(sep)[0] === "artifacts";
    if (insideRepo && !ignored)
      fail(
        "evidenceDir inside the repository must be under the ignored artifacts/",
      );
  }

  const config = {
    provider: {
      endpoint: endpointUrl.origin,
      region,
      bucket,
      endpointAllowlist: [...allow],
    },
    credentials,
    runPrefix: validateRunPrefix(raw.runPrefix),
    budgets,
    fixture,
    presign,
    cors,
    rrd,
    cleanup,
    evidenceDir: resolve(evidenceDir),
  };
  const plan = uploadPlan(config);
  if (plan.totalBytes > budgets.maxUploadBytes)
    fail(
      `planned uploads ${plan.totalBytes} bytes exceed budgets.maxUploadBytes ${budgets.maxUploadBytes}`,
    );
  return config;
}

/** Exact bytes every case will upload, computed before any network call. */
export function uploadPlan(config, partSize = PART_SIZE) {
  const main = partSize + config.fixture.tailBytes;
  const items = [
    { id: "main-multipart", bytes: main },
    { id: "stale-after-complete", bytes: config.fixture.tailBytes },
    { id: "lost-reply-object", bytes: config.fixture.smallBytes },
    { id: "stale-after-complete-small", bytes: config.fixture.smallBytes },
    { id: "abort-part", bytes: config.fixture.abortBytes },
    { id: "stale-after-abort", bytes: config.fixture.abortBytes },
  ];
  if (config.rrd) items.push({ id: "rrd-source", bytes: config.rrd.sizeBytes });
  const totalBytes = items.reduce((n, i) => n + i.bytes, 0);
  return { items, totalBytes };
}

/** Owned keys are derived, never client/provider-chosen. */
export function ownedKeys(prefix) {
  return {
    main: `${prefix}main/object.bin`,
    lost: `${prefix}lost-reply/object.bin`,
    abort: `${prefix}abort/object.bin`,
  };
}

/** Byte and operation ledger; reserving past a budget throws before I/O. */
export class BudgetLedger {
  constructor({ maxUploadBytes, maxDownloadBytes }) {
    this.maxUploadBytes = maxUploadBytes;
    this.maxDownloadBytes = maxDownloadBytes;
    this.uploadedBytes = 0;
    this.downloadedBytes = 0;
    this.operations = 0;
  }
  reserveUpload(bytes) {
    if (this.uploadedBytes + bytes > this.maxUploadBytes)
      throw new BudgetExceeded("upload byte budget exhausted");
    this.uploadedBytes += bytes;
  }
  reserveDownload(bytes) {
    if (this.downloadedBytes + bytes > this.maxDownloadBytes)
      throw new BudgetExceeded("download byte budget exhausted");
    this.downloadedBytes += bytes;
  }
  op() {
    this.operations += 1;
  }
  snapshot() {
    return {
      uploadedBytes: this.uploadedBytes,
      downloadedBytes: this.downloadedBytes,
      operations: this.operations,
      maxUploadBytes: this.maxUploadBytes,
      maxDownloadBytes: this.maxDownloadBytes,
    };
  }
}
export class BudgetExceeded extends Error {
  constructor(message) {
    super(message);
    this.name = "BudgetExceeded";
  }
}

/** Remaining time of the whole run; every operation takes min(op, remaining). */
export class RunClock {
  constructor(runDeadlineMs, now = () => Date.now()) {
    this.now = now;
    this.startedAt = now();
    this.deadlineAt = this.startedAt + runDeadlineMs;
  }
  remainingMs() {
    return Math.max(0, this.deadlineAt - this.now());
  }
  expired() {
    return this.remainingMs() === 0;
  }
  boundedTimeout(operationMs) {
    const left = this.remainingMs();
    if (left === 0) throw new DeadlineExceeded("run deadline exceeded");
    return Math.min(operationMs, left);
  }
}
export class DeadlineExceeded extends Error {
  constructor(message) {
    super(message);
    this.name = "DeadlineExceeded";
  }
}

/** Bounds any promise; the underlying call must also carry its own timeout. */
export async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new DeadlineExceeded(`${label} timed out`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Evidence-safe error: only the error class, status and provider error code.
 * Messages, bodies and request echoes are never kept (they can carry signed
 * URLs, hosts and tokens).
 */
export function safeError(error) {
  const e = error ?? {};
  const code = e.Code ?? e.code;
  return {
    name: typeof e.name === "string" ? e.name.slice(0, 64) : "Error",
    httpStatus: e.$metadata?.httpStatusCode ?? e.httpStatus ?? null,
    code: typeof code === "string" ? code.slice(0, 64) : null,
  };
}

/** Fail closed if a report/ledger would persist a secret or a signed URL. */
export function assertNoSecrets(value, secrets) {
  const text = JSON.stringify(value);
  const needles = [
    "X-Amz-Signature",
    "x-amz-signature",
    "X-Amz-Credential",
    "x-amz-credential",
    "X-Amz-Security-Token",
    "Authorization",
    ...secrets.filter((s) => typeof s === "string" && s.length >= 6),
  ];
  for (const needle of needles)
    if (text.includes(needle)) throw new Error("evidence contains a secret");
}

/** Deterministic synthetic bytes (AES-CTR keystream), never private data. */
export function syntheticBytes(label, length) {
  const key = createHash("sha256").update(`sa43/${label}`).digest();
  const cipher = createCipheriv("aes-256-ctr", key, Buffer.alloc(16));
  return cipher.update(Buffer.alloc(length));
}

export const sha256Hex = (...buffers) => {
  const h = createHash("sha256");
  for (const b of buffers) h.update(b);
  return h.digest("hex");
};

/** The two-part fixture: exactly one 64 MiB part plus a small last part. */
export function mainFixture(runPrefix, tailBytes, partSize = PART_SIZE) {
  const part1 = syntheticBytes(`${runPrefix}main/1`, partSize);
  const part2 = syntheticBytes(`${runPrefix}main/2`, tailBytes);
  return {
    parts: [part1, part2],
    sizeBytes: partSize + tailBytes,
    sha256: sha256Hex(part1, part2),
  };
}

/** Same-length, different-content bytes for a stale-URL overwrite attempt. */
export function staleBytes(label, length) {
  return syntheticBytes(`${label}/stale`, length);
}

/** Byte ranges that cross the 64 MiB boundary and the EOF edge. */
export function rangePlan(sizeBytes, partSize = PART_SIZE) {
  const size = BigInt(sizeBytes);
  const boundary = BigInt(partSize);
  const ranges = [
    { name: "first-bytes", start: 0n, endInclusive: 15n },
    {
      name: "cross-part-boundary",
      start: boundary - 8n,
      endInclusive: boundary + 7n,
    },
    { name: "last-bytes", start: size - 8n, endInclusive: size - 1n },
  ];
  return ranges.filter((r) => r.endInclusive < size && r.start >= 0n);
}

/**
 * Walks ListParts with the provider's own marker logic but a tiny page size
 * (MaxParts 1) to exercise real pagination. `send(marker)` returns a raw
 * ListParts-shaped page. Returns every page's facts for the evidence.
 */
export async function walkListParts(send, { pageLimit = 20 } = {}) {
  const pages = [];
  const parts = [];
  let marker = "0";
  for (let i = 0; i < pageLimit; i++) {
    const out = await send(marker);
    pages.push({
      returned: (out.Parts ?? []).length,
      isTruncated: out.IsTruncated === true,
      nextMarker: out.NextPartNumberMarker ?? null,
    });
    for (const p of out.Parts ?? [])
      parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size });
    if (!out.IsTruncated || out.NextPartNumberMarker === undefined)
      return { pages, parts };
    marker = String(out.NextPartNumberMarker);
  }
  throw new Error("ListParts walk did not terminate");
}

/** A denied unsigned request: 401/403/404 only (see classifyUnsignedDenial for 400). */
export function isDenied(status) {
  return status === 401 || status === 403 || status === 404;
}

/**
 * R2 answers an unsigned request with 400 and exactly this XML error (measured
 * against the real endpoint). Only that strict, bounded body counts as a denial.
 */
const R2_MISSING_AUTH_BODY =
  /^<\?xml version="1\.0" encoding="UTF-8"\?><Error><Code>InvalidArgument<\/Code><Message>Authorization<\/Message><\/Error>\s*$/;

/**
 * Response-aware unsigned-denial classifier. 401/403/404 are denials (not
 * truncated). 400 is a denial only with Content-Type application/xml and the
 * exact InvalidArgument/Authorization error body, untruncated, with no key
 * listing. Returns curated facts only: no raw body, URL or secret.
 */
export function classifyUnsignedDenial({
  status,
  contentType = null,
  text = "",
  truncated = false,
}) {
  const leaksKeys = text.includes("<Key>");
  if (truncated || leaksKeys)
    return {
      denied: false,
      reason: leaksKeys ? "body-lists-keys" : "body-truncated",
      leaksKeys,
    };
  if (isDenied(status))
    return { denied: true, reason: `status-${status}`, leaksKeys };
  if (status === 400) {
    const xml = /^application\/xml(\s*;.*)?$/i.test((contentType ?? "").trim());
    if (xml && R2_MISSING_AUTH_BODY.test(text))
      return {
        denied: true,
        reason: "r2-missing-authorization-400",
        code: "InvalidArgument",
        leaksKeys,
      };
    return { denied: false, reason: "400-not-r2-auth-error", leaksKeys };
  }
  return { denied: false, reason: `status-${status}`, leaksKeys };
}

/** CORS facts from Headers, normalized for assertions (HTTP only). */
export function corsFacts(headers) {
  const get = (n) => headers.get(n);
  const list = (n) =>
    (get(n) ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  return {
    allowOrigin: get("access-control-allow-origin"),
    allowMethods: list("access-control-allow-methods"),
    allowHeaders: list("access-control-allow-headers"),
    exposeHeaders: list("access-control-expose-headers"),
    maxAge: get("access-control-max-age"),
    vary: get("vary"),
  };
}

export class RequireFailed extends Error {
  constructor(name) {
    super(`required assertion failed: ${name}`);
    this.name = "RequireFailed";
  }
}

/** Assertion recorder: a case passes only with >=1 assertion and none failed. */
export class CaseRecorder {
  constructor(id, { required = true, reason } = {}) {
    this.id = id;
    this.required = required;
    this.reason = reason ?? null;
    this.assertions = [];
    this.observations = {};
    this.error = null;
    this.status = "not-run";
    this.startedAt = null;
    this.timingsMs = null;
  }
  begin() {
    this.startedAt = Date.now();
    this.status = "running";
  }
  check(name, ok, observed) {
    this.assertions.push({ name, ok: ok === true, observed: observed ?? null });
    return ok === true;
  }
  /** Hard precondition: records the assertion, then stops the case. */
  require(name, ok, observed) {
    if (!this.check(name, ok, observed)) throw new RequireFailed(name);
  }
  observe(key, value) {
    this.observations[key] = value;
  }
  fail(error) {
    this.error = safeError(error);
  }
  skip(reason) {
    this.status = "not-run";
    this.reason = reason;
  }
  end() {
    if (this.status !== "running") return;
    this.timingsMs = Date.now() - this.startedAt;
    const ok =
      this.error === null &&
      this.assertions.length > 0 &&
      this.assertions.every((a) => a.ok);
    this.status = ok ? "pass" : "fail";
  }
  toJSON() {
    return {
      id: this.id,
      required: this.required,
      status: this.status,
      reason: this.reason,
      timingsMs: this.timingsMs,
      error: this.error,
      assertions: this.assertions,
      observations: this.observations,
    };
  }
}

/**
 * pass: every required case passed and cleanup was clean.
 * fail: any executed case failed or cleanup left owned state.
 * incomplete: otherwise (a required case never executed). Fail closed.
 */
export function overallVerdict(cases, cleanup) {
  if (cases.some((c) => c.status === "fail")) return "fail";
  if (cleanup && (cleanup.status === "fail" || cleanup.status === "uncertain"))
    return "fail";
  if (cases.some((c) => c.required && c.status !== "pass")) return "incomplete";
  return "pass";
}

export const PENDING_GATES = Object.freeze([
  [
    "physical-android-background-upload",
    "needs the physical phone gate (SA-43 mobile slot)",
  ],
  ["ios-transfer", "iOS deprioritized; not exercised"],
  [
    "real-browser-rerun-viewer",
    "HTTP/CORS header checks are not a real-browser Rerun load",
  ],
  ["modal-or-hosted-worker-transfer", "no Modal/hosted compute exercised"],
  ["hosted-ci", "local harness only"],
  [
    "thousand-page-list-parts",
    "only MaxParts=1 pagination over 2 parts was run",
  ],
  ["concurrent-mpu-create-race", "intentionally not raced against real R2"],
  [
    "long-ttl-presigned-get",
    "only a short TTL was measured; 3600s is not claimed",
  ],
]);
