// Focused refusal / ownership / cleanup tests for the bounded external
// fixture adapter. No database, S3 or Docker: pg and S3 are in-memory fakes.
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  FixtureRefusal,
  FixtureSession,
  LIMITS,
  PROTECTED_DATABASES,
  assertDockerAllowed,
  createRunDir,
  externalRequired,
  loadFixtureFile,
  marker,
  resolveFixtures,
  validateFixtureValues,
} from "./local-fixtures.mjs";

const base = mkdtempSync(join(tmpdir(), "sa-fixture-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

const good = {
  CATALOG_TEST_ADMIN_URL: "postgresql://bootstrap@127.0.0.1:54340/postgres",
  CATALOG_TEST_OWNER_URL:
    "postgresql://migration_owner:pw@127.0.0.1:54340/postgres",
  CATALOG_TEST_APP_URL:
    "postgresql://stateaction_app:pw@127.0.0.1:54340/postgres",
  STORAGE_TEST_ENDPOINT: "http://127.0.0.1:19000",
  STORAGE_TEST_ACCESS_KEY_ID: "id",
  STORAGE_TEST_SECRET_ACCESS_KEY: "secret",
};
const text = (values) =>
  Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
function envFile(values = good, mode = 0o600) {
  const dir = mkdtempSync(join(base, "env-"));
  const file = join(dir, "fixtures.env");
  writeFileSync(file, text(values), { mode });
  chmodSync(file, mode);
  return file;
}

describe("refusals", () => {
  it("accepts the bounded loopback fixtures", () => {
    assert.equal(
      validateFixtureValues(good).STORAGE_TEST_ENDPOINT,
      "http://127.0.0.1:19000",
    );
    assert.equal(
      loadFixtureFile(envFile()).CATALOG_TEST_APP_URL,
      good.CATALOG_TEST_APP_URL,
    );
  });

  for (const [what, patch, pattern] of [
    [
      "non-loopback postgres",
      {
        CATALOG_TEST_ADMIN_URL:
          "postgresql://bootstrap@10.0.0.5:54340/postgres",
      },
      /loopback/,
    ],
    [
      "non-loopback s3",
      { STORAGE_TEST_ENDPOINT: "http://192.0.2.1:19000" },
      /loopback/,
    ],
    [
      "wrong postgres port",
      {
        CATALOG_TEST_OWNER_URL:
          "postgresql://migration_owner:pw@127.0.0.1:5432/postgres",
      },
      /bounded fixture port/,
    ],
    [
      "wrong s3 port",
      { STORAGE_TEST_ENDPOINT: "http://127.0.0.1:9000" },
      /bounded fixture port/,
    ],
    ["https s3", { STORAGE_TEST_ENDPOINT: "https://127.0.0.1:19000" }, /http:/],
    [
      "wrong owner role",
      {
        CATALOG_TEST_OWNER_URL:
          "postgresql://bootstrap@127.0.0.1:54340/postgres",
      },
      /migration_owner/,
    ],
    [
      "wrong app role",
      {
        CATALOG_TEST_APP_URL: "postgresql://bootstrap@127.0.0.1:54340/postgres",
      },
      /stateaction_app/,
    ],
    ["missing key", { STORAGE_TEST_SECRET_ACCESS_KEY: "" }, /missing/],
    ["not a url", { CATALOG_TEST_ADMIN_URL: "nonsense" }, /not a URL/],
  ])
    it(`refuses ${what}`, () => {
      assert.throws(
        () => validateFixtureValues({ ...good, ...patch }),
        (e) => e instanceof FixtureRefusal && pattern.test(e.message),
      );
    });

  it("refuses unsafe env files", () => {
    assert.throws(() => loadFixtureFile("relative.env"), /absolute/);
    assert.throws(
      () => loadFixtureFile(join(base, "absent.env")),
      /not readable/,
    );
    assert.throws(
      () => loadFixtureFile(envFile(good, 0o666)),
      /world writable/,
    );
    assert.throws(
      () => loadFixtureFile(envFile(good, 0o602)),
      /world writable/,
    );
    // Own-group write (a private user group) is tolerated.
    assert.ok(loadFixtureFile(envFile(good, 0o664)));
    assert.throws(() => loadFixtureFile(base), /regular file/);
  });

  it("refuses a Docker fallback when external fixtures are required", () => {
    const env = { STATEACTION_REQUIRE_EXTERNAL_FIXTURES: "1" };
    assert.equal(externalRequired(env), true);
    assert.throws(
      () => assertDockerAllowed("x", env),
      /Docker fixtures are refused/,
    );
    assert.throws(() => resolveFixtures(env), /Docker fixtures are refused/);
    assert.equal(
      externalRequired({ STATEACTION_REQUIRE_EXTERNAL_FIXTURES: "0" }),
      false,
    );
    assert.equal(resolveFixtures({}), null);
    assert.doesNotThrow(() => assertDockerAllowed("x", {}));
  });

  it("accepts the E2E alias and rejects conflicting files", () => {
    const a = envFile();
    assert.ok(resolveFixtures({ E2E_EXTERNAL_FIXTURES: a }));
    assert.ok(
      resolveFixtures({
        STATEACTION_LOCAL_FIXTURES: a,
        E2E_EXTERNAL_FIXTURES: a,
      }),
    );
    assert.throws(
      () =>
        resolveFixtures({
          STATEACTION_LOCAL_FIXTURES: a,
          E2E_EXTERNAL_FIXTURES: envFile(),
        }),
      /different files/,
    );
  });
});

// ---- fakes ----
function fakes({ existing = {}, buckets = {} } = {}) {
  const log = [];
  // name -> {owner, comment}
  const databases = new Map(Object.entries(existing));
  const roles = new Map();
  const store = new Map(Object.entries(buckets)); // bucket -> [{key,size}]
  const drivers = {
    async connect() {
      return {
        async query(sql, params) {
          log.push(sql.replace(/\s+/g, " ").trim());
          let m;
          if (/FROM pg_database/.test(sql)) {
            const d = databases.get(params[0]);
            return { rows: d ? [d] : [] };
          }
          if (/FROM pg_roles WHERE rolname/.test(sql)) {
            const r = roles.get(params[0]);
            return { rows: r ? [r] : [] };
          }
          if ((m = /^CREATE DATABASE "([^"]+)" OWNER "([^"]+)"/.exec(sql))) {
            databases.set(m[1], { owner: m[2], comment: null });
          } else if (
            (m = /^COMMENT ON DATABASE "([^"]+)" IS '([^']+)'/.exec(sql))
          ) {
            databases.get(m[1]).comment = m[2];
          } else if ((m = /^CREATE ROLE "([^"]+)"/.exec(sql))) {
            roles.set(m[1], { comment: null, rolsuper: false });
          } else if (
            (m = /^COMMENT ON ROLE "([^"]+)" IS '([^']+)'/.exec(sql))
          ) {
            roles.get(m[1]).comment = m[2];
          } else if ((m = /^DROP DATABASE "([^"]+)"/.exec(sql))) {
            databases.delete(m[1]);
          } else if ((m = /^DROP ROLE "([^"]+)"/.exec(sql))) {
            roles.delete(m[1]);
          }
          return { rows: [] };
        },
        async end() {},
      };
    },
    s3() {
      return {
        async createBucket(b) {
          log.push(`S3 create ${b}`);
          store.set(b, []);
        },
        async listObjects(b) {
          if (!store.has(b))
            throw Object.assign(new Error("x"), { name: "NoSuchBucket" });
          return { objects: store.get(b), next: undefined };
        },
        async deleteObject(b, k) {
          log.push(`S3 delete ${b}/${k}`);
          store.set(
            b,
            store.get(b).filter((o) => o.key !== k),
          );
        },
        async listUploads() {
          return [];
        },
        async abortUpload() {},
        async deleteBucket(b) {
          log.push(`S3 drop ${b}`);
          store.delete(b);
        },
      };
    },
  };
  return { drivers, log, databases, roles, store };
}

function session(over = {}, f = fakes(), limits = LIMITS) {
  const { dir } = createRunDir({ purpose: "tst", base, limits });
  const s = new FixtureSession({
    values: validateFixtureValues(good),
    dir,
    drivers: f.drivers,
    limits,
    ...over,
  });
  return { s, f, dir };
}

describe("run directory", () => {
  it("is private: dir 0700, files 0600", () => {
    const { dir } = createRunDir({ purpose: "tst", base });
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "ledger.jsonl")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "meta.json")).mode & 0o777, 0o600);
    assert.throws(() => createRunDir({ purpose: "BAD!", base }), /purpose/);
  });
  it("refuses a run dir whose meta is not private", () => {
    const { dir } = createRunDir({ purpose: "tst", base });
    chmodSync(join(dir, "meta.json"), 0o644);
    assert.throws(
      () => new FixtureSession({ values: good, dir, drivers: fakes().drivers }),
      /0600/,
    );
  });
});

describe("ownership and cleanup", () => {
  it("records the ledger before creating and marks the database", async () => {
    const { s, f } = session();
    const db = await s.createDatabase({ purpose: "e2e" });
    assert.match(db.name, new RegExp(`^sa_e2e_${s.runId}_[0-9a-f]{12}$`));
    assert.equal(s.live("database").length, 1);
    assert.equal(f.databases.get(db.name).comment, marker(s.runId));
    assert.equal(f.databases.get(db.name).owner, "migration_owner");
    assert.ok(f.log.some((q) => /CONNECTION LIMIT 60/.test(q)));
    assert.match(new URL(db.appUrl).pathname, new RegExp(db.name));
  });

  it("keeps the ledger entry when creation fails so reap can see it", async () => {
    const f = fakes();
    const real = f.drivers.connect;
    f.drivers.connect = async () => {
      const c = await real();
      return {
        ...c,
        query: async (sql, p) => {
          if (/^CREATE DATABASE/.test(sql)) throw new Error("boom");
          return c.query(sql, p);
        },
      };
    };
    const { s } = session({}, f);
    await assert.rejects(s.createDatabase({ purpose: "e2e" }), /boom/);
    assert.equal(s.live("database").length, 1);
    const reaped = await s.reap(); // absent on server -> reported already-absent, not an error
    assert.equal(reaped.ok, true);
    assert.equal(s.live("database").length, 0);
  });

  it("removes exactly the run's databases, roles and buckets", async () => {
    const f = fakes({
      existing: {
        sa_other_aaaaaaaaaaaa_bbbbbbbbbbbb: {
          owner: "migration_owner",
          comment: "stateaction-local-fixture:aaaaaaaaaaaa",
        },
      },
    });
    const { s } = session({}, f);
    const role = await s.createRole({ purpose: "auth" });
    const db = await s.createDatabase({ purpose: "auth", owner: role.name });
    const bucket = await s.createBucket();
    f.store
      .get(bucket.name)
      .push({ key: "a", size: 10 }, { key: "b", size: 20 });
    const out = await s.reap();
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(
      out.results.map((r) => r.kind),
      ["database", "bucket", "role"],
    );
    assert.equal(f.databases.has(db.name), false);
    assert.equal(f.roles.has(role.name), false);
    assert.equal(f.store.has(bucket.name), false);
    assert.equal(out.results.find((r) => r.kind === "bucket").bytes, 30);
    // A foreign (other run's) database survived.
    assert.equal(f.databases.size, 1);
    assert.equal((await s.reap()).results.length, 0); // idempotent
  });

  it("never drops a database whose server marker or owner differs from the ledger", async () => {
    const { s, f } = session();
    const db = await s.createDatabase({ purpose: "e2e" });
    f.databases.get(db.name).comment = "someone-else";
    const r = await s.remove("database", db.name);
    assert.match(r.skipped, /marker\/owner/);
    assert.equal(f.databases.has(db.name), true);
    assert.equal(f.log.filter((q) => /^DROP/.test(q)).length, 0);
    f.databases.get(db.name).comment = marker(s.runId);
    f.databases.get(db.name).owner = "intruder";
    assert.match(
      (await s.remove("database", db.name)).skipped,
      /marker\/owner/,
    );
  });

  it("refuses to remove anything not in this run's ledger", async () => {
    const { s, f } = session();
    for (const name of [
      ...PROTECTED_DATABASES,
      "e2e_5ef4d7461566b865",
      "phone_dev_20261102",
    ]) {
      const r = await s.remove("database", name);
      assert.match(r.skipped, /not recorded/);
    }
    assert.match(
      (await s.remove("bucket", "stateaction-local")).skipped,
      /not recorded/,
    );
    assert.equal(f.log.filter((q) => /DROP/.test(q)).length, 0);
  });

  it("does not trust a forged ledger line for a protected or foreign name", async () => {
    const { s, f, dir } = session();
    for (const name of [
      "phone_dev_20261102",
      `sa_e2e_${"0".repeat(12)}_${"1".repeat(12)}`,
    ])
      writeFileSync(
        join(dir, "ledger.jsonl"),
        `${JSON.stringify({ event: "created", kind: "database", name, runId: s.runId, owner: "migration_owner" })}\n`,
        { flag: "a" },
      );
    f.databases.set("phone_dev_20261102", {
      owner: "migration_owner",
      comment: marker(s.runId),
    });
    const out = await s.reap();
    assert.equal(out.ok, false);
    assert.ok(
      out.results.every((r) => /does not prove run ownership/.test(r.skipped)),
    );
    assert.equal(f.databases.has("phone_dev_20261102"), true);
    assert.equal(f.log.filter((q) => /^DROP/.test(q)).length, 0);
  });

  it("drops a harness-recorded role only with the server marker, after databases", async () => {
    const { s, f, dir } = session();
    const line = (name) =>
      `${JSON.stringify({ event: "created", kind: "role", name, runId: s.runId })}\n`;
    writeFileSync(
      join(dir, "ledger.jsonl"),
      line("sa_hosted_abcdef123456") +
        line("postgres") +
        line("sa_fresh_unmarked0000"),
      { flag: "a" },
    );
    f.roles.set("sa_hosted_abcdef123456", {
      comment: marker(s.runId),
      rolsuper: false,
    });
    f.roles.set("sa_fresh_unmarked0000", { comment: null, rolsuper: false });
    f.roles.set("postgres", { comment: marker(s.runId), rolsuper: true });
    const out = await s.reap();
    assert.equal(out.ok, false);
    const by = Object.fromEntries(out.results.map((r) => [r.name, r]));
    assert.equal(by.sa_hosted_abcdef123456.removed, true);
    assert.match(by.sa_fresh_unmarked0000.skipped, /marker/);
    assert.match(by.postgres.skipped, /does not prove/);
    assert.deepEqual([...f.roles.keys()].sort(), [
      "postgres",
      "sa_fresh_unmarked0000",
    ]);
  });

  it("refuses to drop a bucket over the object budget", async () => {
    const limits = { ...LIMITS, maxS3Objects: 2 };
    const { s, f } = session({}, fakes(), limits);
    const b = await s.createBucket();
    f.store
      .get(b.name)
      .push(
        { key: "1", size: 1 },
        { key: "2", size: 1 },
        { key: "3", size: 1 },
      );
    const r = await s.remove("bucket", b.name);
    assert.match(r.skipped, /object budget/);
    assert.equal(f.store.has(b.name), true);
  });

  it("flags a bucket over the byte budget", async () => {
    const limits = { ...LIMITS, maxS3Bytes: 10 };
    const { s, f } = session({}, fakes(), limits);
    const b = await s.createBucket();
    f.store.get(b.name).push({ key: "1", size: 11 });
    const out = await s.reap();
    assert.equal(out.ok, false);
    assert.equal(out.results[0].overBudget, true);
  });

  it("refuses a database owner that is neither migration_owner nor a run role", async () => {
    const { s } = session();
    await assert.rejects(
      s.createDatabase({ purpose: "e2e", owner: "postgres" }),
      /neither/,
    );
  });
});

describe("finite budgets", () => {
  it("stops after the database budget", async () => {
    const { s } = session({}, fakes(), { ...LIMITS, maxDatabases: 2 });
    await s.createDatabase({ purpose: "e2e" });
    await s.createDatabase({ purpose: "e2e" });
    await assert.rejects(
      s.createDatabase({ purpose: "e2e" }),
      /budget \(2\) exhausted/,
    );
  });
  it("counts removed resources against the budget (no churn bypass)", async () => {
    const { s } = session({}, fakes(), { ...LIMITS, maxBuckets: 1 });
    const b = await s.createBucket();
    await s.remove("bucket", b.name);
    await assert.rejects(s.createBucket(), /exhausted/);
  });
  it("refuses new fixtures after the TTL", async () => {
    let now = 1_000;
    const f = fakes();
    const { dir } = createRunDir({ purpose: "tst", base, now: 1_000 });
    const s = new FixtureSession({
      values: good,
      dir,
      drivers: f.drivers,
      now: () => now,
    });
    await s.createBucket();
    now += LIMITS.ttlMs + 1;
    await assert.rejects(s.createBucket(), /TTL expired/);
    // Reaping still works after expiry.
    assert.equal((await s.reap()).ok, true);
  });
  it("never writes secrets to the ledger", async () => {
    const { s, dir } = session();
    const role = await s.createRole({ purpose: "auth" });
    assert.ok(
      !readFileSync(join(dir, "ledger.jsonl"), "utf8").includes(role.password),
    );
  });
});
