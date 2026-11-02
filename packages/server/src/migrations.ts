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

/**
 * Restricted app role names are plain unquoted lowercase identifiers. Every
 * helper validates the name before issuing any query, so a hostile value can
 * never reach SQL text (it is also bound/%I-quoted downstream).
 */
export const SAFE_ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
export function assertSafeRoleName(role: string): string {
  if (typeof role !== "string" || !SAFE_ROLE_NAME.test(role))
    throw new Error(
      "App database role must match ^[a-z_][a-z0-9_]{0,62}$ (plain unquoted identifier)",
    );
  return role;
}

/** Re-applies least-privilege grants when the restricted role exists. */
export async function grantAppRole(
  client: pg.ClientBase,
  role: string = APP_DB_ROLE,
): Promise<boolean> {
  assertSafeRoleName(role);
  const { rowCount } = await client.query(
    "SELECT 1 FROM pg_roles WHERE rolname = $1",
    [role],
  );
  if (!rowCount) return false;
  await client.query("SELECT stateaction_grant_app_role($1)", [role]);
  // Later additive migrations contribute their own grant helper (one per
  // feature); the SA-13 helper above stays the unchanged baseline.
  const { rowCount: transport } = await client.query(
    "SELECT 1 WHERE to_regprocedure('stateaction_grant_transport(name)') IS NOT NULL",
  );
  if (transport)
    await client.query("SELECT stateaction_grant_transport($1)", [role]);
  const { rowCount: jobs } = await client.query(
    "SELECT 1 WHERE to_regprocedure('stateaction_grant_jobs(name)') IS NOT NULL",
  );
  if (jobs) await client.query("SELECT stateaction_grant_jobs($1)", [role]);
  return true;
}

/**
 * Creates the restricted application role if absent and (re)sets its password.
 * Privileges are NOT granted here: stateaction_grant_app_role() is the single
 * source of grants, so no broad or default ACLs are ever introduced. The name
 * is validated before any query and, like the password, passed as a bound
 * transaction-local setting (never interpolated into SQL text). A fresh role is
 * a plain LOGIN role. A pre-existing role fails closed unless it is plain
 * LOGIN: no SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS and no
 * membership in any other role. (The CREATEROLE owner's own automatic ADMIN
 * membership *in* the app role is the reverse direction and is allowed.)
 */
export async function ensureAppRole(
  client: pg.ClientBase,
  password: string,
  role: string = APP_DB_ROLE,
): Promise<void> {
  assertSafeRoleName(role);
  if (password.length < 16)
    throw new Error("APP_DB_PASSWORD must have at least 16 characters");
  await client.query(
    "SELECT set_config('stateaction.app_password', $1, true), set_config('stateaction.app_role', $2, true)",
    [password, role],
  );
  await client.query(
    `DO $$
DECLARE r name := current_setting('stateaction.app_role');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
  END IF;
  -- A CREATEROLE (non-superuser) owner cannot touch attribute flags it does not
  -- hold, so verify rather than reset them: a pre-existing privileged role fails closed.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r AND (rolsuper OR rolcreatedb
       OR rolcreaterole OR rolreplication OR rolbypassrls OR NOT rolcanlogin)) THEN
    RAISE EXCEPTION 'Role % must be a plain LOGIN role (no SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS)', r;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles a ON a.oid = m.member
             WHERE a.rolname = r) THEN
    RAISE EXCEPTION 'Role % must not be a member of other roles', r;
  END IF;
  EXECUTE format('ALTER ROLE %I PASSWORD %L', r, current_setting('stateaction.app_password'));
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r);
END $$`,
  );
}

/**
 * Owner-credential migration in one transaction: schema, optional restricted
 * role creation/password, then the exact least-privilege grant helper.
 */
export async function migrateDatabase(options: {
  ownerUrl: string;
  appRole?: string;
  /** Hosted/dev: create or rotate the restricted role inside the transaction. */
  appRolePassword?: string;
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
    if (options.appRolePassword)
      await ensureAppRole(client, options.appRolePassword, options.appRole);
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
