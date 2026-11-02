import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { grantAppRole, loadMigrations } from "../src/migrations.js";
import { transportDatabase } from "./transport-harness.js";
import type { Actors, TestDb } from "./harness.js";

let db: TestDb & { actors: Actors };
before(async () => {
  db = await transportDatabase();
});
after(async () => {
  await db.close();
});

const priv = async (table: string, privilege: string, column?: string) => {
  const { rows } = await db.owner.query<{ ok: boolean }>(
    column
      ? "SELECT has_column_privilege('stateaction_app', $1, $2, $3) AS ok"
      : "SELECT has_table_privilege('stateaction_app', $1, $2) AS ok",
    column ? [table, column, privilege] : [table, privilege],
  );
  return rows[0]!.ok;
};

test("005 and 006 are applied through the real migrator with the published 001-004 untouched", async () => {
  const applied = await db.owner.query<{ version: number; sha256: string }>(
    "SELECT version, sha256 FROM platform_schema_migrations ORDER BY version",
  );
  const files = await loadMigrations();
  assert.deepEqual(
    applied.rows,
    files.map((m) => ({ version: m.version, sha256: m.sha256 })),
  );
  assert.equal(applied.rows.at(-1)?.version, 6);
});

test("restricted-role matrix for the transport tables", async () => {
  // Receipts: append, corroborate; never rewrite identity/size or delete.
  assert.equal(await priv("file_part_receipts", "SELECT"), true);
  assert.equal(await priv("file_part_receipts", "INSERT"), true);
  assert.equal(
    await priv("file_part_receipts", "UPDATE"),
    false,
    "no table-wide UPDATE",
  );
  assert.equal(await priv("file_part_receipts", "DELETE"), false);
  assert.equal(await priv("file_part_receipts", "UPDATE", "etag"), true);
  assert.equal(
    await priv("file_part_receipts", "UPDATE", "corroborated_at"),
    true,
  );
  assert.equal(await priv("file_part_receipts", "UPDATE", "size_bytes"), false);
  assert.equal(
    await priv("file_part_receipts", "UPDATE", "part_number"),
    false,
  );
  // Output slots are append-only: the idempotency identity is never rewritten.
  assert.equal(await priv("job_output_slots", "SELECT"), true);
  assert.equal(await priv("job_output_slots", "INSERT"), true);
  assert.equal(await priv("job_output_slots", "UPDATE"), false);
  assert.equal(await priv("job_output_slots", "DELETE"), false);
  // The init claim is the only mutable lease table.
  for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"])
    assert.equal(await priv("file_transport_claims", p), true, p);
  // Nothing is granted to PUBLIC, and the helper is not callable by the app.
  const publicGrants = await db.owner.query(
    `SELECT 1 FROM information_schema.role_table_grants
     WHERE grantee = 'PUBLIC' AND table_name IN ('file_part_receipts','job_output_slots','file_transport_claims')`,
  );
  assert.equal(publicGrants.rowCount, 0);
  const exec = await db.owner.query<{ ok: boolean }>(
    "SELECT has_function_privilege('stateaction_app', 'stateaction_grant_transport(name)', 'EXECUTE') AS ok",
  );
  assert.equal(exec.rows[0]!.ok, false);
});

test("re-granting is idempotent and never widens privileges", async () => {
  const before = await db.owner.query(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants
     WHERE grantee = 'stateaction_app' ORDER BY 1, 2`,
  );
  const client = await db.owner.connect();
  try {
    assert.equal(await grantAppRole(client), true);
    assert.equal(await grantAppRole(client), true);
  } finally {
    client.release();
  }
  const after = await db.owner.query(
    `SELECT table_name, privilege_type FROM information_schema.role_table_grants
     WHERE grantee = 'stateaction_app' ORDER BY 1, 2`,
  );
  assert.deepEqual(after.rows, before.rows);
});
