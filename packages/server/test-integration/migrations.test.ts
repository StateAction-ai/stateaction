import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import { loadMigrations, migrateDatabase } from "../src/migrations.js";
import { expectCode, freshDatabase, writeArtifact } from "./harness.js";

const TABLES = [
  "access",
  "account",
  "clips",
  "dataset_access",
  "dataset_clips",
  "datasets",
  "files",
  "jobs",
  "platform_schema_migrations",
  "recordings",
  "reviews",
  "session",
  "user",
  "verification",
].sort();

test("migrations apply to an empty database with an unprivileged owner", async () => {
  const db = await freshDatabase({ migrate: false });
  try {
    const owner = await db.owner.query<{
      rolsuper: boolean;
      rolcreatedb: boolean;
    }>(
      "SELECT rolsuper, rolcreatedb FROM pg_roles WHERE rolname = current_user",
    );
    assert.deepEqual(owner.rows[0], { rolsuper: false, rolcreatedb: false });
    const first = await migrateDatabase({ ownerUrl: db.ownerUrl });
    assert.deepEqual(first, {
      applied: [1, 2, 3],
      alreadyApplied: [],
      adopted: [],
      appRoleGranted: true,
    });
    const tables = await db.owner.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    assert.deepEqual(tables.rows.map((r) => r.table_name).sort(), TABLES);
    assert.ok(!TABLES.includes("releases"), "no releases table in the MVP");
    const second = await migrateDatabase({ ownerUrl: db.ownerUrl });
    assert.deepEqual(second, {
      applied: [],
      alreadyApplied: [1, 2, 3],
      adopted: [],
      appRoleGranted: true,
    });
    const recorded = await db.owner.query(
      "SELECT version, name, sha256 FROM platform_schema_migrations ORDER BY version",
    );
    const files = await loadMigrations();
    assert.deepEqual(
      recorded.rows,
      files.map((m) => ({
        version: m.version,
        name: m.name,
        sha256: m.sha256,
      })),
    );
    const indexes = await db.owner.query(
      "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2",
    );
    await writeArtifact("migration-up.json", {
      first,
      second,
      tables: tables.rows.map((r) => r.table_name),
      migrations: recorded.rows,
      indexes: indexes.rows,
    });
  } finally {
    await db.close();
  }
});

test("applied migrations are immutable and a failed run changes nothing", async () => {
  const db = await freshDatabase();
  try {
    const files = await loadMigrations();
    const edited = files.map((m) =>
      m.version === 3 ? { ...m, sha256: "0".repeat(64) } : m,
    );
    await assert.rejects(
      migrateDatabase({ ownerUrl: db.ownerUrl, migrations: edited }),
      /changed; add a new migration/,
    );
    const broken = [
      ...files,
      {
        version: 4,
        name: "004_broken.sql",
        sha256: "f".repeat(64),
        sql: "CREATE TABLE releases (id uuid); SELECT 1/0;",
      },
    ];
    await assert.rejects(
      migrateDatabase({ ownerUrl: db.ownerUrl, migrations: broken }),
      /division by zero/,
    );
    const left = await db.owner.query(
      "SELECT to_regclass('releases') AS t, max(version) AS v FROM platform_schema_migrations",
    );
    assert.deepEqual(left.rows[0], { t: null, v: 3 });
  } finally {
    await db.close();
  }
});

test("a database bootstrapped by the original 001-only migrate adopts its checksum", async () => {
  const db = await freshDatabase({ migrate: false });
  try {
    const legacy = await readFile(
      new URL("../migrations/001_platform.sql", import.meta.url),
      "utf8",
    );
    await db.owner.query(legacy);
    const report = await migrateDatabase({ ownerUrl: db.ownerUrl });
    assert.deepEqual(report, {
      applied: [2, 3],
      alreadyApplied: [1],
      adopted: [1],
      appRoleGranted: true,
    });
  } finally {
    await db.close();
  }
});

test("concurrent migrators serialize and apply each version once", async () => {
  const db = await freshDatabase({ migrate: false });
  try {
    const reports = await Promise.all(
      Array.from({ length: 4 }, () =>
        migrateDatabase({ ownerUrl: db.ownerUrl }),
      ),
    );
    assert.equal(reports.filter((r) => r.applied.length === 3).length, 1);
    assert.equal(
      reports.filter((r) => r.alreadyApplied.length === 3).length,
      3,
    );
  } finally {
    await db.close();
  }
});

test("the restricted app role cannot change schema, roles or append-only rows", async () => {
  const db = await freshDatabase();
  const app = new pg.Client({ connectionString: db.appUrl });
  await app.connect();
  try {
    const denied = [
      "CREATE TABLE intruder (id int)",
      "ALTER TABLE reviews ADD COLUMN x int",
      "DROP TABLE clips",
      "TRUNCATE reviews",
      "CREATE ROLE intruder",
      "SET ROLE migration_owner",
      "DELETE FROM reviews",
      "UPDATE reviews SET notes = 'x'",
      "UPDATE clips SET title = 'x'",
      "DELETE FROM clips",
      "DELETE FROM files",
      "DELETE FROM recordings",
      "DELETE FROM jobs",
      "UPDATE recordings SET owner_user_id = 'x'",
      "UPDATE files SET sha256 = repeat('0', 64)",
      "UPDATE jobs SET source_manifest_sha256 = repeat('0', 64)",
      "INSERT INTO access (user_id, role) VALUES ('x', 'staff')",
      "UPDATE access SET enabled = true",
      "INSERT INTO dataset_access (dataset_id, user_id, granted_by, permission_evidence_ref) VALUES (gen_random_uuid(), 'x', 'x', 'x')",
      "SELECT stateaction_grant_app_role('stateaction_app')",
      "INSERT INTO platform_schema_migrations (version) VALUES (99)",
    ];
    const results: Record<string, string> = {};
    for (const sql of denied) {
      const e = await expectCode(app.query(sql), "42501");
      results[sql] = e.code ?? "";
    }
    for (const table of TABLES)
      await app.query(`SELECT count(*) FROM "${table}"`);
    await writeArtifact("app-role-denials.json", results);
  } finally {
    await app.end();
    await db.close();
  }
});
