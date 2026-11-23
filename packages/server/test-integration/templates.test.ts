import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import pg from "pg";
import {
  FixtureSession,
  createRunDir,
  resolveFixtures,
} from "../../../scripts/platform/local-fixtures.mjs";
import {
  cloneFromTemplate,
  contentKey,
  dropTemplate,
  ensureTemplate,
  pruneTemplates,
  templateName,
  TEMPLATE_TTL_MS,
} from "../../../scripts/platform/db-template.mjs";
import { migratedSpec } from "../test-auth/migrated-template.mjs";
import { migrateDatabase } from "../src/migrations.js";
import { freshDatabase } from "./harness.js";

// SA-115: sealed, content-keyed template databases. Test templates use their
// own random kind/key so they never touch the shared migrated template.
const url = (key: string) => process.env[key]!;
const values = () => resolveFixtures(process.env);
const env = (log: string[] = []) => ({
  async connect(u: string) {
    const c = new pg.Client({ connectionString: u });
    await c.connect();
    return c;
  },
  adminUrl: url("CATALOG_TEST_ADMIN_URL"),
  ownerUrl: url("CATALOG_TEST_OWNER_URL"),
  appUrl: url("CATALOG_TEST_APP_URL"),
  note: (e: unknown) => void log.push(JSON.stringify(e)),
});
const withDb = (u: string, db: string) => {
  const x = new URL(u);
  x.pathname = `/${db}`;
  return x.toString();
};

const created: string[] = []; // test templates and clones this file made
const sql = async (db: string, text: string, params: unknown[] = []) => {
  const c = new pg.Client({
    connectionString: withDb(url("CATALOG_TEST_ADMIN_URL"), db),
  });
  await c.connect();
  try {
    return (await c.query(text, params)).rows;
  } finally {
    await c.end();
  }
};
const tinySpec = (key: string, builds: string[]) => ({
  kind: "tst",
  key,
  async build({ ownerUrl }: { ownerUrl: string }) {
    builds.push(key);
    const c = new pg.Client({ connectionString: ownerUrl });
    await c.connect();
    await c.query("CREATE TABLE t (n int)");
    await c.query("INSERT INTO t VALUES (1)");
    await c.end();
    return { seeded: 1 };
  },
});
const cloneName = () => `sa_tstc_${randomBytes(6).toString("hex")}`;
const clone = async (spec: ReturnType<typeof tinySpec>, log: string[] = []) => {
  const name = cloneName();
  created.push(name);
  return cloneFromTemplate(env(log), spec, {
    name,
    owner: "migration_owner",
  });
};

after(async () => {
  const admin = new pg.Client({
    connectionString: url("CATALOG_TEST_ADMIN_URL"),
  });
  await admin.connect();
  try {
    for (const name of created)
      if (/^sa_tstc_[0-9a-f]{12}$/.test(name))
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      else if (/^sa_tpl_tst_[0-9a-f]{16}$/.test(name))
        await dropTemplate(admin, name);
  } finally {
    await admin.end();
  }
});

test("a clone is migrated, isolated, and leaves the template untouched", async () => {
  const a = await freshDatabase();
  const b = await freshDatabase();
  try {
    const tpl = migratedSpec();
    const name = templateName(tpl.kind, tpl.key);
    const flags = await sql(
      "postgres",
      "SELECT datistemplate, datallowconn FROM pg_database WHERE datname = $1",
      [name],
    );
    assert.deepEqual(flags, [{ datistemplate: true, datallowconn: false }]);
    const before = await sql(
      "postgres",
      "SELECT shobj_description(oid,'pg_database') AS c FROM pg_database WHERE datname=$1",
      [name],
    );
    const versions = await a.owner.query(
      "SELECT count(*)::int AS n FROM platform_schema_migrations",
    );
    assert.ok(versions.rows[0].n >= 11);
    await a.owner.query(
      `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ('iso', 'iso', 'iso@example.test', true)`,
    );
    assert.equal(
      (await a.owner.query(`SELECT count(*)::int AS n FROM "user"`)).rows[0].n,
      1,
    );
    assert.equal(
      (await b.owner.query(`SELECT count(*)::int AS n FROM "user"`)).rows[0].n,
      0,
    );
    // Database-level ACL is replayed: the app role has no TEMP, the clone is not a template.
    const cflags = await sql(
      "postgres",
      "SELECT datistemplate, datallowconn, datconnlimit FROM pg_database WHERE datname = $1",
      [a.name],
    );
    assert.deepEqual(cflags, [
      { datistemplate: false, datallowconn: true, datconnlimit: Number(60) },
    ]);
    assert.equal(
      (
        await sql(
          "postgres",
          "SELECT has_database_privilege('stateaction_app', $1, 'TEMPORARY') AS t",
          [a.name],
        )
      )[0].t,
      false,
    );
    const after_ = await sql(
      "postgres",
      "SELECT shobj_description(oid,'pg_database') AS c FROM pg_database WHERE datname=$1",
      [name],
    );
    assert.deepEqual(after_, before); // template comment (key + fingerprint) unchanged
    // Row counts of the sealed template cannot even be read: nobody can connect.
    await assert.rejects(
      sql(name, "SELECT 1"),
      /not currently accepting connections/,
    );
  } finally {
    await a.close();
    await b.close();
  }
});

test("same key reuses the template, a changed key builds a new one", async () => {
  const builds: string[] = [];
  const k1 = randomBytes(16).toString("hex");
  const k2 = randomBytes(16).toString("hex");
  created.push(templateName("tst", k1), templateName("tst", k2));
  const logs: string[] = [];
  await clone(tinySpec(k1, builds), logs);
  await clone(tinySpec(k1, builds), logs);
  assert.deepEqual(builds, [k1]);
  assert.ok(
    logs.some((l) => l.includes('"reused":true')),
    logs.join("\n"),
  );
  await clone(tinySpec(k2, builds), logs);
  assert.deepEqual(builds, [k1, k2]);
});

test("concurrent builders build one template", async () => {
  const builds: string[] = [];
  const k = randomBytes(16).toString("hex");
  created.push(templateName("tst", k));
  const out = await Promise.all(
    [1, 2, 3].map(() => ensureTemplate(env(), tinySpec(k, builds))),
  );
  assert.equal(builds.length, 1);
  assert.equal(out.filter((o) => !o.reused).length, 1);
});

test("a corrupted template is detected and rebuilt, never reused", async () => {
  const builds: string[] = [];
  const k = randomBytes(16).toString("hex");
  const name = templateName("tst", k);
  created.push(name);
  await clone(tinySpec(k, builds));
  // Simulate corruption: a writer gets into the sealed template.
  await sql("postgres", `ALTER DATABASE ${name} WITH ALLOW_CONNECTIONS true`);
  await sql(name, "INSERT INTO t VALUES (99)");
  await sql("postgres", `ALTER DATABASE ${name} WITH ALLOW_CONNECTIONS false`);
  const logs: string[] = [];
  const spec = { ...tinySpec(k, builds), log: (m: string) => logs.push(m) };
  const out = await clone(spec as ReturnType<typeof tinySpec>);
  assert.deepEqual(builds, [k, k], "rebuilt once");
  assert.ok(
    logs.some((l) => /mismatch/.test(l)),
    logs.join("\n"),
  );
  const cloned = created[created.length - 1]!;
  assert.deepEqual(await sql(cloned, "SELECT n FROM t ORDER BY n"), [{ n: 1 }]);
  assert.ok(out.name);
});

test("ledger reaps clones after a killed run and keeps the template", async () => {
  const v = values();
  const base = mkdtempSync(join(tmpdir(), "sa115-"));
  try {
    const { dir } = createRunDir({ purpose: "tst", base });
    const session = new FixtureSession({ values: v, dir });
    const db = await session.createClonedDatabase({
      purpose: "cat",
      spec: migratedSpec({
        migrate: (ownerUrl: string) => migrateDatabase({ ownerUrl }),
      }),
    });
    assert.equal(session.live("database").length, 1);
    // "Killed": the owning process is gone; a fresh session on the same ledger reaps it.
    const reaper = new FixtureSession({ values: v, dir });
    const { ok } = await reaper.reap();
    assert.equal(ok, true);
    assert.deepEqual(
      await sql("postgres", "SELECT 1 FROM pg_database WHERE datname=$1", [
        db.name,
      ]),
      [],
    );
    assert.equal(
      (
        await sql("postgres", "SELECT 1 FROM pg_database WHERE datname=$1", [
          db.template,
        ])
      ).length,
      1,
    );
    assert.ok(
      reaper.entries().some((e: { event: string }) => e.event === "template"),
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("prune drops only old unlocked test templates and orphan staging, never kept or busy ones", async () => {
  const builds: string[] = [];
  const old = randomBytes(16).toString("hex");
  const kept = randomBytes(16).toString("hex");
  const fresh = randomBytes(16).toString("hex");
  const names = [old, kept, fresh].map((k) => templateName("tst", k));
  created.push(...names);
  const e = env();
  await ensureTemplate(e, {
    ...tinySpec(old, builds),
    now: Date.now() - 2 * TEMPLATE_TTL_MS,
  });
  await ensureTemplate(e, {
    ...tinySpec(kept, builds),
    now: Date.now() - 2 * TEMPLATE_TTL_MS,
  });
  await ensureTemplate(e, tinySpec(fresh, builds));
  // Orphan staging database of a killed build for a template nobody builds.
  const orphanKey = randomBytes(4).toString("hex");
  const orphan = `sa_tplb_tst_${orphanKey}${orphanKey}_${randomBytes(4).toString("hex")}`;
  const busyKey = randomBytes(4).toString("hex");
  const busyFinal = `sa_tpl_tst_${busyKey}${busyKey}`;
  const busy = `sa_tplb_tst_${busyKey}${busyKey}_${randomBytes(4).toString("hex")}`;
  await sql("postgres", `CREATE DATABASE ${orphan}`);
  await sql("postgres", `CREATE DATABASE ${busy}`);
  // A live builder holds the template lock for its final name.
  const { createHash } = await import("node:crypto");
  const b = createHash("sha256").update(`sa-template:${busyFinal}`).digest();
  const holder = new pg.Client({
    connectionString: url("CATALOG_TEST_ADMIN_URL"),
  });
  await holder.connect();
  try {
    await holder.query("SELECT pg_advisory_lock($1, $2)", [
      b.readInt32BE(0),
      b.readInt32BE(4),
    ]);
    // Never touch other runs' templates: keep everything that is not ours.
    const others = (
      await sql(
        "postgres",
        `SELECT datname FROM pg_database WHERE datname LIKE 'sa\\_tpl\\_%' AND datname NOT LIKE 'sa\\_tpl\\_tst\\_%'`,
      )
    ).map((r) => r.datname as string);
    const dropped = await pruneTemplates(e, { keep: [...others, names[1]!] });
    assert.ok(dropped.includes(names[0]!), dropped.join());
    assert.ok(dropped.includes(orphan), dropped.join());
    assert.ok(!dropped.includes(names[1]!), "kept template survives");
    assert.ok(!dropped.includes(names[2]!), "fresh template survives");
    assert.ok(
      !dropped.includes(busy),
      "a staging db under a live lock survives",
    );
    for (const o of others)
      assert.ok(!dropped.includes(o), `foreign template ${o} untouched`);
  } finally {
    await holder.end();
    await sql("postgres", `DROP DATABASE IF EXISTS ${busy} WITH (FORCE)`);
    await sql("postgres", `DROP DATABASE IF EXISTS ${orphan} WITH (FORCE)`);
  }
});

test("the template key follows file content", () => {
  const root = mkdtempSync(join(tmpdir(), "sa115key-"));
  try {
    mkdirSync(join(root, "m"));
    writeFileSync(join(root, "m", "001.sql"), "select 1");
    const one = contentKey(root, ["m"]);
    assert.equal(contentKey(root, ["m"]), one);
    writeFileSync(join(root, "m", "001.sql"), "select 2");
    assert.notEqual(contentKey(root, ["m"]), one);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
