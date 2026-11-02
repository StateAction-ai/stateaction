import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

/** Same advisory lock the hosted migrator uses; serializes concurrent runs. */
export const MIGRATION_LOCK_ID = 7430001;
export const APP_DB_ROLE = "stateaction_app";

export type Migration = {
  version: number;
  name: string;
  sha256: string;
  sql: string;
};
export type MigrationReport = {
  applied: number[];
  alreadyApplied: number[];
  /** Pre-existing rows without a checksum that adopted the current file hash. */
  adopted: number[];
  appRoleGranted: boolean;
};

const directory = new URL("../migrations/", import.meta.url);

export async function loadMigrations(): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((n) => n.endsWith(".sql"));
  const migrations: Migration[] = [];
  for (const name of names.sort()) {
    const match = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(name);
    if (!match?.[1]) throw new Error(`Unexpected migration file name: ${name}`);
    const sql = await readFile(new URL(name, directory), "utf8");
    migrations.push({
      version: Number(match[1]),
      name,
      sql,
      sha256: createHash("sha256").update(sql).digest("hex"),
    });
  }
  migrations.forEach((m, index) => {
    if (m.version !== index + 1)
      throw new Error(`Migration versions must be contiguous at ${m.name}`);
  });
  return migrations;
}

/**
 * Applies pending migrations inside the caller's open transaction. Applied
 * files are immutable: a changed checksum fails the run, so schema changes are
 * always new additive files. Version 1 predates checksums; an existing row
 * without one adopts the current file hash and is reported as adopted.
 */
export async function applyMigrations(
  client: pg.ClientBase,
  migrations?: Migration[],
): Promise<Omit<MigrationReport, "appRoleGranted">> {
  const files = migrations ?? (await loadMigrations());
  await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
  await client.query(`CREATE TABLE IF NOT EXISTS platform_schema_migrations (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.query(
    "ALTER TABLE platform_schema_migrations ADD COLUMN IF NOT EXISTS name text, ADD COLUMN IF NOT EXISTS sha256 text",
  );
  const { rows } = await client.query<{
    version: number;
    sha256: string | null;
  }>("SELECT version, sha256 FROM platform_schema_migrations ORDER BY version");
  const recorded = new Map(rows.map((r) => [r.version, r.sha256]));
  for (const version of recorded.keys())
    if (!files.some((m) => m.version === version))
      throw new Error(`Database has unknown migration version ${version}`);
  const report = {
    applied: [] as number[],
    alreadyApplied: [] as number[],
    adopted: [] as number[],
  };
  for (const migration of files) {
    if (recorded.has(migration.version)) {
      const sha = recorded.get(migration.version);
      if (sha === null || sha === undefined) {
        await client.query(
          "UPDATE platform_schema_migrations SET name = $2, sha256 = $3 WHERE version = $1",
          [migration.version, migration.name, migration.sha256],
        );
        report.adopted.push(migration.version);
      } else if (sha !== migration.sha256) {
        throw new Error(
          `Applied migration ${migration.name} changed; add a new migration instead`,
        );
      }
      report.alreadyApplied.push(migration.version);
      continue;
    }
    await client.query(migration.sql);
    await client.query(
      `INSERT INTO platform_schema_migrations (version, name, sha256) VALUES ($1, $2, $3)
       ON CONFLICT (version) DO UPDATE SET name = EXCLUDED.name, sha256 = EXCLUDED.sha256`,
      [migration.version, migration.name, migration.sha256],
    );
    report.applied.push(migration.version);
  }
  return report;
}

/** Re-applies least-privilege grants when the restricted role exists. */
export async function grantAppRole(
  client: pg.ClientBase,
  role: string = APP_DB_ROLE,
): Promise<boolean> {
  const { rowCount } = await client.query(
    "SELECT 1 FROM pg_roles WHERE rolname = $1",
    [role],
  );
  if (!rowCount) return false;
  await client.query("SELECT stateaction_grant_app_role($1)", [role]);
  return true;
}

/** Owner-credential migration in one transaction. */
export async function migrateDatabase(options: {
  ownerUrl: string;
  appRole?: string;
  migrations?: Migration[];
}): Promise<MigrationReport> {
  const client = new pg.Client({
    connectionString: options.ownerUrl,
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    const report = await applyMigrations(client, options.migrations);
    const appRoleGranted = await grantAppRole(client, options.appRole);
    await client.query("COMMIT");
    return { ...report, appRoleGranted };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
