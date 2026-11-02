#!/usr/bin/env node
// Bounded, Docker-free test fixtures for the full local CI gate.
//
// The gate runs against ONE already-running, resource-bounded PostgreSQL and
// S3-compatible store (loopback only) described by an explicit env file named
// by STATEACTION_LOCAL_FIXTURES (alias: E2E_EXTERNAL_FIXTURES). This module:
//   * refuses unsafe configuration (non-loopback, unexpected port, group/world
//     writable or foreign-owned env file, missing keys);
//   * refuses a Docker fallback when STATEACTION_REQUIRE_EXTERNAL_FIXTURES is
//     set (the local gate sets it);
//   * creates only run-owned resources (database / role / bucket names carry the
//     run id), records every one in a 0600 per-run JSONL ledger BEFORE creating
//     it, enforces finite counts / bytes / TTL, and removes ONLY exact ledger
//     entries after re-verifying ownership on the server (name shape, run id,
//     comment marker, expected owner role).
// There are no sweeps, no snapshot differences and no pattern deletes. Secrets
// are never printed.
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LIMITS = Object.freeze({
  pgPort: "54340",
  s3Port: "19000",
  maxDatabases: 160,
  maxRoles: 8,
  maxBuckets: 64,
  maxS3Objects: 20000,
  maxS3Bytes: 512 * 1024 * 1024,
  ttlMs: 2 * 60 * 60 * 1000,
  databaseConnectionLimit: 60,
  roleConnectionLimit: 8,
  envFileBytes: 16 * 1024,
});

// Never touched, even if a ledger entry names them.
export const PROTECTED_DATABASES = new Set([
  "postgres",
  "template0",
  "template1",
  "phone_dev_20261102",
  "e2e_5ef4d7461566b865",
]);
const OWNER_ROLE = "migration_owner";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const REQUIRED_KEYS = [
  "CATALOG_TEST_ADMIN_URL",
  "CATALOG_TEST_OWNER_URL",
  "CATALOG_TEST_APP_URL",
  "STORAGE_TEST_ENDPOINT",
  "STORAGE_TEST_ACCESS_KEY_ID",
  "STORAGE_TEST_SECRET_ACCESS_KEY",
];
const KINDS = { database: "db", role: "role", bucket: "bucket" };
const PURPOSES = /^[a-z][a-z0-9]{1,5}$/;

export class FixtureRefusal extends Error {}
const refuse = (message) => {
  throw new FixtureRefusal(message);
};

/** True when the caller demands external fixtures and forbids Docker. */
export function externalRequired(env = process.env) {
  const v = env.STATEACTION_REQUIRE_EXTERNAL_FIXTURES;
  return Boolean(v) && v !== "0" && v !== "false";
}

/** Throws if external fixtures are required; call before any Docker start. */
export function assertDockerAllowed(what, env = process.env) {
  if (externalRequired(env))
    refuse(
      `${what}: Docker fixtures are refused because STATEACTION_REQUIRE_EXTERNAL_FIXTURES is set; ` +
        "set STATEACTION_LOCAL_FIXTURES to the bounded fixtures env file",
    );
}

export function parseEnvText(text) {
  const values = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    values[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

/** Validate the already-parsed values; returns them frozen. */
export function validateFixtureValues(values, limits = LIMITS) {
  for (const key of REQUIRED_KEYS)
    if (!values[key]) refuse(`${key} missing from the fixtures env file`);
  const endpoints = [
    ["CATALOG_TEST_ADMIN_URL", "postgresql:", limits.pgPort],
    ["CATALOG_TEST_OWNER_URL", "postgresql:", limits.pgPort],
    ["CATALOG_TEST_APP_URL", "postgresql:", limits.pgPort],
    ["STORAGE_TEST_ENDPOINT", "http:", limits.s3Port],
  ];
  for (const [key, protocol, port] of endpoints) {
    let url;
    try {
      url = new URL(values[key]);
    } catch {
      refuse(`${key} is not a URL`);
    }
    if (url.protocol !== protocol) refuse(`${key} must use ${protocol}`);
    if (!LOOPBACK.has(url.hostname))
      refuse(`${key} must be loopback; external fixtures are local only`);
    if (url.port !== port)
      refuse(`${key} must use the bounded fixture port ${port}`);
  }
  const hosts = new Set(
    REQUIRED_KEYS.slice(0, 3).map((k) => new URL(values[k]).host),
  );
  if (hosts.size !== 1) refuse("PostgreSQL URLs must name one server");
  if (new URL(values.CATALOG_TEST_OWNER_URL).username !== OWNER_ROLE)
    refuse(`CATALOG_TEST_OWNER_URL must use the ${OWNER_ROLE} role`);
  if (new URL(values.CATALOG_TEST_APP_URL).username !== "stateaction_app")
    refuse("CATALOG_TEST_APP_URL must use the stateaction_app role");
  return Object.freeze({ ...values });
}

/** Read the fixtures env file with ownership/mode checks. */
export function loadFixtureFile(file, limits = LIMITS) {
  if (!isAbsolute(file)) refuse("fixtures env file must be an absolute path");
  let fd;
  try {
    fd = openSync(file, "r");
  } catch {
    refuse("fixtures env file is not readable");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) refuse("fixtures env file must be a regular file");
    if (typeof process.getuid === "function" && st.uid !== process.getuid())
      refuse("fixtures env file must be owned by the current user");
    // World-writable is always refused; group-writable only when the group is
    // the caller's own primary group (a private user group, as on this host).
    if (st.mode & 0o002) refuse("fixtures env file must not be world writable");
    if (
      st.mode & 0o020 &&
      typeof process.getgid === "function" &&
      st.gid !== process.getgid()
    )
      refuse("fixtures env file must not be writable by a foreign group");
    if (st.size > limits.envFileBytes) refuse("fixtures env file too large");
    const buffer = Buffer.alloc(st.size);
    readSync(fd, buffer, 0, st.size, 0);
    return validateFixtureValues(parseEnvText(buffer.toString("utf8")), limits);
  } finally {
    closeSync(fd);
  }
}

/** null = Docker mode allowed; object = external fixtures; throws on refusal. */
export function resolveFixtures(env = process.env, limits = LIMITS) {
  const a = env.STATEACTION_LOCAL_FIXTURES;
  const b = env.E2E_EXTERNAL_FIXTURES;
  if (a && b && resolve(a) !== resolve(b))
    refuse(
      "STATEACTION_LOCAL_FIXTURES and E2E_EXTERNAL_FIXTURES name different files",
    );
  const file = a || b;
  if (!file) {
    assertDockerAllowed("no external fixtures configured", env);
    return null;
  }
  return loadFixtureFile(file, limits);
}

const randomHex = (n) => randomBytes(n).toString("hex");
const IDENT = /^[a-z][a-z0-9_]{2,62}$/;
const BUCKET = /^sa-[0-9a-f]{12}-[0-9a-f]{12}$/;
const ident = (name) => {
  if (!IDENT.test(name)) refuse(`unsafe identifier ${name}`);
  return `"${name}"`;
};
export const marker = (runId) => `stateaction-local-fixture:${runId}`;

export function withDatabase(url, database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Default drivers load pg and the AWS SDK from the server package. */
export function defaultDrivers(values, root) {
  const serverRequire = createRequire(
    new URL("packages/server/package.json", root).pathname,
  );
  return {
    async connect(url) {
      const { Client } = serverRequire("pg");
      const client = new Client({
        connectionString: url,
        connectionTimeoutMillis: 10_000,
        statement_timeout: 60_000,
      });
      await client.connect();
      return client;
    },
    s3() {
      const sdk = serverRequire("@aws-sdk/client-s3");
      const client = new sdk.S3Client({
        endpoint: values.STORAGE_TEST_ENDPOINT,
        region: "us-east-1",
        forcePathStyle: true,
        maxAttempts: 2,
        credentials: {
          accessKeyId: values.STORAGE_TEST_ACCESS_KEY_ID,
          secretAccessKey: values.STORAGE_TEST_SECRET_ACCESS_KEY,
        },
      });
      const send = (Command, input) => client.send(new Command(input));
      return {
        createBucket: (Bucket) => send(sdk.CreateBucketCommand, { Bucket }),
        async listObjects(Bucket, token) {
          const r = await send(sdk.ListObjectsV2Command, {
            Bucket,
            ContinuationToken: token,
            MaxKeys: 1000,
          });
          return {
            objects: (r.Contents ?? []).map((o) => ({
              key: o.Key,
              size: o.Size ?? 0,
            })),
            next: r.IsTruncated ? r.NextContinuationToken : undefined,
          };
        },
        deleteObject: (Bucket, Key) =>
          send(sdk.DeleteObjectCommand, { Bucket, Key }),
        async listUploads(Bucket) {
          const r = await send(sdk.ListMultipartUploadsCommand, { Bucket });
          return (r.Uploads ?? []).map((u) => ({
            key: u.Key,
            id: u.UploadId,
          }));
        },
        abortUpload: (Bucket, Key, UploadId) =>
          send(sdk.AbortMultipartUploadCommand, { Bucket, Key, UploadId }),
        deleteBucket: (Bucket) => send(sdk.DeleteBucketCommand, { Bucket }),
        close: () => client.destroy(),
      };
    },
  };
}

const defaultRoot = new URL("../../", import.meta.url);

/** Per-run state directory: 0700 dir, 0600 meta/ledger/env files. */
export function createRunDir({
  purpose,
  base = process.env.STATEACTION_FIXTURE_TMP ?? tmpdir(),
  limits = LIMITS,
  now = Date.now(),
} = {}) {
  if (!PURPOSES.test(purpose))
    refuse("purpose must be 2-6 lowercase alphanumerics");
  const runId = randomHex(6);
  const dir = mkdtempSync(join(base, `stateaction-fixtures-${purpose}-`));
  chmodSync(dir, 0o700);
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      runId,
      purpose,
      createdAt: now,
      expiresAt: now + limits.ttlMs,
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(dir, "ledger.jsonl"), "", { mode: 0o600 });
  return { dir, runId };
}

function readMeta(dir) {
  const file = join(dir, "meta.json");
  let st;
  try {
    st = statSync(file);
  } catch {
    refuse("run directory has no meta.json");
  }
  if (st.mode & 0o077) refuse("run directory meta.json must be mode 0600");
  const meta = JSON.parse(readFileSync(file, "utf8"));
  if (!/^[0-9a-f]{12}$/.test(meta.runId)) refuse("corrupt run id");
  return meta;
}

/** One run's bounded fixture operations; `dir` is a createRunDir() result. */
export class FixtureSession {
  constructor({
    values,
    dir,
    drivers,
    limits = LIMITS,
    now = () => Date.now(),
  }) {
    this.values = values;
    this.dir = dir;
    this.limits = limits;
    this.now = now;
    this.meta = readMeta(dir);
    this.runId = this.meta.runId;
    this.drivers = drivers ?? defaultDrivers(values, defaultRoot);
    this.ledgerPath = join(dir, "ledger.jsonl");
  }

  entries() {
    return readFileSync(this.ledgerPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  /** Remaining live (not yet reaped) entries of one kind. */
  live(kind) {
    const gone = new Set(
      this.entries()
        .filter((e) => e.event === "removed")
        .map((e) => `${e.kind}:${e.name}`),
    );
    return this.entries().filter(
      (e) =>
        e.event === "created" &&
        e.kind === kind &&
        !gone.has(`${e.kind}:${e.name}`),
    );
  }

  record(event, kind, name, extra = {}) {
    appendFileSync(
      this.ledgerPath,
      `${JSON.stringify({ event, kind, name, runId: this.runId, ts: this.now(), ...extra })}\n`,
    );
  }

  assertBudget(kind, max) {
    if (this.now() > this.meta.expiresAt)
      refuse("run TTL expired; refusing to create more fixtures");
    const total = this.entries().filter(
      (e) => e.event === "created" && e.kind === kind,
    ).length;
    if (total >= max) refuse(`finite ${kind} budget (${max}) exhausted`);
  }

  nameFor(purpose, kind) {
    if (!PURPOSES.test(purpose)) refuse("bad purpose");
    return kind === "bucket"
      ? `sa-${this.runId}-${randomHex(6)}`
      : `sa_${purpose}_${this.runId}_${randomHex(6)}`;
  }

  async admin() {
    return this.drivers.connect(this.values.CATALOG_TEST_ADMIN_URL);
  }

  /** Create a run-owned database; `owner` is migration_owner or a run role. */
  async createDatabase({ purpose, owner = OWNER_ROLE }) {
    this.assertBudget("database", this.limits.maxDatabases);
    if (
      owner !== OWNER_ROLE &&
      !this.live("role").some((r) => r.name === owner)
    )
      refuse(`owner ${owner} is neither ${OWNER_ROLE} nor a run-owned role`);
    const name = this.nameFor(purpose, "database");
    this.record("created", "database", name, { owner });
    const admin = await this.admin();
    try {
      await admin.query(`CREATE DATABASE ${ident(name)} OWNER ${ident(owner)}`);
      await admin.query(
        `ALTER DATABASE ${ident(name)} CONNECTION LIMIT ${this.limits.databaseConnectionLimit}`,
      );
      await admin.query(
        `COMMENT ON DATABASE ${ident(name)} IS '${marker(this.runId)}'`,
      );
    } finally {
      await admin.end();
    }
    return {
      name,
      ownerUrl: withDatabase(this.values.CATALOG_TEST_OWNER_URL, name),
      appUrl: withDatabase(this.values.CATALOG_TEST_APP_URL, name),
    };
  }

  /** Create a run-owned login role with a random password. */
  async createRole({ purpose }) {
    this.assertBudget("role", this.limits.maxRoles);
    const name = this.nameFor(purpose, "role");
    const password = randomHex(18);
    this.record("created", "role", name);
    const admin = await this.admin();
    try {
      await admin.query(
        `CREATE ROLE ${ident(name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${this.limits.roleConnectionLimit} PASSWORD '${password}'`,
      );
      await admin.query(
        `COMMENT ON ROLE ${ident(name)} IS '${marker(this.runId)}'`,
      );
    } finally {
      await admin.end();
    }
    return { name, password };
  }

  async createBucket() {
    this.assertBudget("bucket", this.limits.maxBuckets);
    const name = this.nameFor("s3", "bucket");
    this.record("created", "bucket", name);
    const s3 = this.drivers.s3();
    try {
      await s3.createBucket(name);
    } finally {
      s3.close?.();
    }
    return { name };
  }

  /** Remove one exact ledger-recorded resource after verifying ownership. */
  async remove(kind, name) {
    if (!this.live(kind).some((e) => e.name === name))
      return {
        name,
        skipped: "not recorded for this run (or already removed)",
      };
    if (kind === "database") return this.#dropDatabase(name);
    if (kind === "role") return this.#dropRole(name);
    if (kind === "bucket") return this.#dropBucket(name);
    return refuse(`unknown kind ${kind}`);
  }

  async #dropDatabase(name) {
    const entry = this.live("database").find((e) => e.name === name);
    const shape = new RegExp(
      `^sa_[a-z][a-z0-9]{1,5}_${this.runId}_[0-9a-f]{12}$`,
    );
    if (!shape.test(name) || PROTECTED_DATABASES.has(name))
      return { name, skipped: "name does not prove run ownership" };
    const admin = await this.admin();
    try {
      const { rows } = await admin.query(
        `SELECT r.rolname AS owner, shobj_description(d.oid, 'pg_database') AS comment
           FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = $1`,
        [name],
      );
      if (rows.length === 0) {
        this.record("removed", "database", name, { already: true });
        return { name, removed: false, note: "already absent" };
      }
      if (
        rows[0].comment !== marker(this.runId) ||
        rows[0].owner !== entry.owner
      )
        return { name, skipped: "server marker/owner does not match ledger" };
      await admin.query(`DROP DATABASE ${ident(name)} WITH (FORCE)`);
      this.record("removed", "database", name);
      return { name, removed: true };
    } finally {
      await admin.end();
    }
  }

  async #dropRole(name) {
    // Run-created roles are sa_<purpose>_<run>_<hex>; test-created ones are
    // sa_* and are additionally proven by the server-side marker below.
    const shape = /^sa_[a-z0-9_]{3,56}$/;
    if (!shape.test(name))
      return { name, skipped: "name does not prove run ownership" };
    const admin = await this.admin();
    try {
      const { rows } = await admin.query(
        `SELECT shobj_description(oid, 'pg_authid') AS comment, rolsuper
           FROM pg_roles WHERE rolname = $1`,
        [name],
      );
      if (rows.length === 0) {
        this.record("removed", "role", name, { already: true });
        return { name, removed: false, note: "already absent" };
      }
      if (rows[0].rolsuper || rows[0].comment !== marker(this.runId))
        return { name, skipped: "server marker does not match ledger" };
      await admin.query(`DROP ROLE ${ident(name)}`);
      this.record("removed", "role", name);
      return { name, removed: true };
    } finally {
      await admin.end();
    }
  }

  async #dropBucket(name) {
    if (!BUCKET.test(name) || !name.startsWith(`sa-${this.runId}-`))
      return { name, skipped: "name does not prove run ownership" };
    const s3 = this.drivers.s3();
    try {
      let objects = 0;
      let bytes = 0;
      let token;
      try {
        do {
          const page = await s3.listObjects(name, token);
          for (const o of page.objects) {
            objects += 1;
            bytes += o.size;
            if (objects > this.limits.maxS3Objects)
              return {
                name,
                skipped: "object budget exceeded; not deleting",
                objects,
              };
            await s3.deleteObject(name, o.key);
          }
          token = page.next;
        } while (token);
        for (const u of await s3.listUploads(name))
          await s3.abortUpload(name, u.key, u.id);
        await s3.deleteBucket(name);
      } catch (error) {
        if (/NoSuchBucket|NotFound/.test(String(error?.name ?? error))) {
          this.record("removed", "bucket", name, { already: true });
          return { name, removed: false, note: "already absent" };
        }
        throw error;
      }
      this.record("removed", "bucket", name, { objects, bytes });
      return {
        name,
        removed: true,
        objects,
        bytes,
        overBudget: bytes > this.limits.maxS3Bytes,
      };
    } finally {
      s3.close?.();
    }
  }

  /** Remove everything still live, databases before roles. Never throws on one failure. */
  async reap() {
    const results = [];
    for (const kind of ["database", "bucket", "role"])
      for (const entry of this.live(kind)) {
        try {
          results.push({ kind, ...(await this.remove(kind, entry.name)) });
        } catch (error) {
          results.push({
            kind,
            name: entry.name,
            error: String(error.message),
          });
        }
      }
    const failed = results.filter((r) => r.error || r.skipped || r.overBudget);
    return { results, ok: failed.length === 0 };
  }
}

// ---- shared process-wide session for JS adapters (no launcher run dir) ----
let shared;
/**
 * Session for in-process adapters. Uses STATEACTION_FIXTURE_RUN_DIR when a
 * launcher prepared one (so its trap can reap on crash); otherwise creates a
 * private 0700 dir that the adapters empty as they stop.
 */
export function externalSession(env = process.env) {
  if (shared) return shared;
  const values = resolveFixtures(env);
  if (!values) return null;
  let dir = env.STATEACTION_FIXTURE_RUN_DIR;
  const private_ = !dir;
  if (!dir) dir = createRunDir({ purpose: "proc" }).dir;
  shared = new FixtureSession({ values, dir });
  if (private_)
    process.on("exit", () => {
      // Everything stopped cleanly: drop the private run dir. Otherwise keep it
      // so `local-fixtures.mjs reap <dir>` can remove the exact leftovers.
      const live = ["database", "role", "bucket"].flatMap((k) =>
        shared.live(k),
      );
      if (live.length === 0) rmSync(dir, { recursive: true, force: true });
      else
        console.error(
          `fixtures left behind; run: node scripts/platform/local-fixtures.mjs reap ${dir}`,
        );
    });
  return shared;
}
export function resetSharedSessionForTests() {
  shared = undefined;
}

// ---- CLI for shell launchers ----
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

function runEnvText(values, dir, runId, extra = {}) {
  const exports = {
    STATEACTION_REQUIRE_EXTERNAL_FIXTURES: "1",
    STATEACTION_FIXTURE_RUN_DIR: dir,
    STATEACTION_FIXTURE_RUN_ID: runId,
    ...Object.fromEntries(REQUIRED_KEYS.map((k) => [k, values[k]])),
    ...extra,
  };
  return Object.entries(exports)
    .map(([k, v]) => `export ${k}=${shq(v)}\n`)
    .join("");
}

async function sqlMain(args, env) {
  const flag = (n) => {
    const i = args.indexOf(n);
    return i < 0 ? undefined : args[i + 1];
  };
  const urlEnv = flag("--url-env");
  if (!urlEnv || !/^[A-Z0-9_]+$/.test(urlEnv)) refuse("--url-env required");
  const url = env[urlEnv];
  if (!url) refuse(`${urlEnv} is not set`);
  const values = resolveFixtures(env);
  if (!values) refuse("sql requires external fixtures");
  const u = new URL(url);
  if (!LOOPBACK.has(u.hostname) || u.port !== LIMITS.pgPort)
    refuse("sql only connects to the bounded fixture server");
  const sql = flag("-c") ?? readFileSync(0, "utf8");
  const drivers = defaultDrivers(values, defaultRoot);
  const client = await drivers.connect(url);
  try {
    const res = await client.query({ text: sql, rowMode: "array" });
    for (const r of Array.isArray(res) ? res : [res])
      for (const row of r.rows ?? []) console.log(row.join("|"));
  } finally {
    await client.end();
  }
}

/**
 * Bounded TCP forwarder 127.0.0.2:<ephemeral> -> 127.0.0.1:<fixture PG port>
 * so hosted-style production configuration (which refuses the literal loopback
 * names) can be exercised without exposing the fixture on any real interface.
 * Prints its port, serves at most `maxConnections`, and exits after `ttlMs`.
 */
export async function forwardMain(args, env = process.env, out = console.log) {
  const values = resolveFixtures(env);
  if (!values) refuse("forward requires external fixtures");
  const net = await import("node:net");
  const listen = "127.0.0.2";
  const ttl = Number(args[args.indexOf("--ttl") + 1] || 1800) * 1000;
  const maxConnections = 32;
  const target = new URL(values.CATALOG_TEST_ADMIN_URL);
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port), "127.0.0.1");
    client.pipe(upstream).pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end);
    upstream.on("error", end);
    client.on("close", end);
  });
  server.maxConnections = maxConnections;
  await new Promise((r) => server.listen(0, listen, r));
  out(String(server.address().port));
  const stop = () => process.exit(0);
  setTimeout(stop, ttl).unref?.();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return new Promise(() => {});
}

export async function main(argv, env = process.env) {
  const [command, ...rest] = argv;
  if (command === "prepare") {
    const purpose = rest[0];
    const values = resolveFixtures(env);
    if (!values) refuse("prepare requires STATEACTION_LOCAL_FIXTURES");
    const { dir, runId } = createRunDir({ purpose });
    const extra = {};
    const session = new FixtureSession({ values, dir });
    if (rest.includes("--database")) {
      const db = await session.createDatabase({ purpose });
      Object.assign(extra, {
        STATEACTION_FIXTURE_DATABASE: db.name,
        STATEACTION_FIXTURE_OWNER_URL: db.ownerUrl,
        STATEACTION_FIXTURE_APP_URL: db.appUrl,
      });
    }
    if (rest.includes("--bucket")) {
      const bucket = await session.createBucket();
      extra.STATEACTION_FIXTURE_BUCKET = bucket.name;
    }
    const artifacts = rest[rest.indexOf("--artifacts") + 1];
    if (rest.includes("--artifacts")) extra.CATALOG_TEST_ARTIFACTS = artifacts;
    writeFileSync(join(dir, "run.env"), runEnvText(values, dir, runId, extra), {
      mode: 0o600,
    });
    console.log(dir);
    return 0;
  }
  if (command === "reap") {
    const dir = rest[0];
    if (!dir || !existsSync(join(dir, "meta.json")))
      refuse("reap needs a prepared run directory");
    const values = resolveFixtures(env);
    if (!values) refuse("reap requires STATEACTION_LOCAL_FIXTURES");
    const session = new FixtureSession({ values, dir });
    const { results, ok } = await session.reap();
    for (const r of results) {
      const state = r.error
        ? `error: ${r.error}`
        : r.skipped
          ? `skipped: ${r.skipped}`
          : r.removed
            ? "removed"
            : (r.note ?? "absent");
      console.log(
        `${r.kind} ${r.name} ${state}${r.overBudget ? " OVER-BUDGET" : ""}`,
      );
    }
    if (ok) rmSync(dir, { recursive: true, force: true });
    return ok ? 0 : 1;
  }
  if (command === "sql") {
    await sqlMain(rest, env);
    return 0;
  }
  if (command === "forward") return forwardMain(rest, env);
  if (command === "check") {
    resolveFixtures(env);
    return 0;
  }
  console.error("usage: local-fixtures.mjs prepare|reap|sql|check ...");
  return 2;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(
        error instanceof FixtureRefusal
          ? `refused: ${error.message}`
          : `error: ${error.message}`,
      );
      process.exit(error instanceof FixtureRefusal ? 3 : 1);
    },
  );
