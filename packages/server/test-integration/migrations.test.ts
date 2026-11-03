import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import pg from "pg";
import {
  ensureAppRole,
  grantAppRole,
  loadMigrations,
  migrateDatabase,
} from "../src/migrations.js";
import { claimRole, expectRole } from "./fixture-ledger.js";
import { expectCode, freshDatabase, writeArtifact } from "./harness.js";

const TABLES = [
  "access",
  "account",
  "clips",
  "dataset_access",
  "dataset_clips",
  "datasets",
  "dispatch_admission",
  "file_part_receipts",
  "file_transport_claims",
  "files",
  "ingest_permissions",
  "job_execution_evidence",
  "job_inputs",
  "job_output_slots",
  "jobs",
  "platform_schema_migrations",
  "recording_admissions",
  "recording_registrations",
  "recording_seals",
  "recordings",
  "reviews",
  "service_capabilities",
  "session",
  "user",
  "verification",
].sort();

// Published bytes of 001-004 on main (SA-13/15/19). Applied files are immutable;
// 005 (SA-20) is additive.
const PUBLISHED = {
  "001_platform.sql":
    "813b81abb0e51f74d3dd411e54c92c26ed81ecefbc3366736973d3ebf52642a4",
  "002_auth.sql":
    "87b5d6d5bccafde4693e09f351c70a2da47350b42cf08596535cafb5aeab8dce",
  "003_catalog.sql":
    "557ee2b65600b78945d6c0546bb27756a24798f0b118bd59323fbe79bbb1dd5a",
  "004_ingest_admission.sql":
    "59b8ad6efbf2b410f170a617dc53868496a6ef88445cb1586b266b04b6cdcc3e",
  "005_multipart_transport.sql":
    "658c6bb2b445f9519634ce7088c37dbbe9eed3aabf89e2441c4709f9ab737080",
} as const;

test("published migrations 001-005 are byte-identical; 006 and 007 follow", async () => {
  const files = await loadMigrations();
  assert.deepEqual(
    files.slice(0, 5).map((m) => [m.name, m.sha256]),
    Object.entries(PUBLISHED),
  );
  assert.equal(files[5]?.name, "006_simulated_capture.sql");
  assert.equal(files[6]?.name, "007_job_admission_claims.sql");
  assert.equal(files.length, 7);
});

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
      applied: [1, 2, 3, 4, 5, 6, 7],
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
      alreadyApplied: [1, 2, 3, 4, 5, 6, 7],
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
        version: 8,
        name: "008_broken.sql",
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
    assert.deepEqual(left.rows[0], { t: null, v: 7 });
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
      applied: [2, 3, 4, 5, 6, 7],
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
    assert.equal(reports.filter((r) => r.applied.length === 7).length, 1);
    assert.equal(
      reports.filter((r) => r.alreadyApplied.length === 7).length,
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
      "SELECT stateaction_grant_app_role_003('stateaction_app')",
      "INSERT INTO ingest_permissions (id, permission_ref, owner_user_id, pilot_scope, covers_capture, covers_processing, evidence_ref, recorded_by) VALUES (gen_random_uuid(), 'self', 'x', 'x', true, true, 'x', 'x')",
      "UPDATE ingest_permissions SET status = 'active'",
      "DELETE FROM ingest_permissions",
      "UPDATE recording_registrations SET permission_ref = 'x'",
      "DELETE FROM recording_registrations",
      "UPDATE recording_seals SET inventory = '[]'",
      "DELETE FROM recording_seals",
      "UPDATE recording_admissions SET outcome = 'admitted'",
      "DELETE FROM recording_admissions",
      "INSERT INTO platform_schema_migrations (version) VALUES (99)",
      "CREATE TEMP TABLE reviews (id int)",
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

test("the grant helper resets broad table grants and default ACLs for the app role", async () => {
  const db = await freshDatabase();
  try {
    await db.owner.query(
      "GRANT ALL ON ALL TABLES IN SCHEMA public TO stateaction_app",
    );
    await db.owner.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO stateaction_app",
    );
    await db.owner.query(
      "ALTER DEFAULT PRIVILEGES GRANT ALL ON SEQUENCES TO stateaction_app",
    );
    await db.owner.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO stateaction_app",
    );
    await migrateDatabase({ ownerUrl: db.ownerUrl });
    const acl = await db.owner.query(
      "SELECT defaclobjtype, defaclacl::text FROM pg_default_acl WHERE defaclacl::text LIKE '%stateaction_app=%'",
    );
    assert.deepEqual(acl.rows, []);
    await db.owner.query("CREATE TABLE releases_probe (id int)");
    const app = new pg.Client({ connectionString: db.appUrl });
    await app.connect();
    try {
      await expectCode(app.query("SELECT * FROM releases_probe"), "42501");
      await expectCode(app.query("DELETE FROM reviews"), "42501");
    } finally {
      await app.end();
    }
  } finally {
    await db.close();
  }
});

test("hosted path: migrateDatabase creates the restricted role, grants via the helper and is idempotent", async () => {
  const db = await freshDatabase({ migrate: false });
  const role = `sa_hosted_${db.name.slice(-12)}`;
  expectRole(role);
  const password = "hosted-password-0123456789";
  const hostedUrl = (() => {
    const u = new URL(db.appUrl);
    u.username = role;
    u.password = password;
    return u.toString();
  })();
  try {
    // Legacy state: version-1 row without checksum, role with broad grants.
    await db.owner.query(
      "CREATE TABLE platform_schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    await db.owner.query(
      "INSERT INTO platform_schema_migrations (version) VALUES (1)",
    );
    const first = await migrateDatabase({
      ownerUrl: db.ownerUrl,
      appRole: role,
      appRolePassword: password,
    });
    assert.deepEqual(first.adopted, [1]);
    assert.equal(first.appRoleGranted, true);
    const second = await migrateDatabase({
      ownerUrl: db.ownerUrl,
      appRole: role,
      appRolePassword: password,
    });
    assert.deepEqual(second.applied, []);
    const flags = await db.owner.query(
      "SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1",
      [role],
    );
    assert.deepEqual(flags.rows, [
      { rolsuper: false, rolcreatedb: false, rolcreaterole: false },
    ]);
    const app = new pg.Client({ connectionString: hostedUrl });
    await app.connect();
    try {
      await app.query("SELECT count(*) FROM reviews");
      await expectCode(app.query("CREATE TABLE nope (x int)"), "42501");
      await expectCode(app.query("DELETE FROM reviews"), "42501");
      await expectCode(app.query("UPDATE access SET enabled = true"), "42501");
    } finally {
      await app.end();
    }
    await assert.rejects(
      migrateDatabase({
        ownerUrl: db.ownerUrl,
        appRole: role,
        appRolePassword: "short",
      }),
      /at least 16/,
    );
  } finally {
    await db.owner.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await claimRole(db.owner, role); // still present: removed after its database
    await db.close();
  }
});

const roleSnapshot = async (pool: pg.Pool) =>
  (
    await pool.query(
      `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
       FROM pg_roles ORDER BY rolname`,
    )
  ).rows;

test("hostile app role names are rejected before any SQL reaches the database", async () => {
  const db = await freshDatabase({ migrate: false });
  try {
    const before = await roleSnapshot(db.owner);
    const hostile = [
      "x$role$; CREATE ROLE pwned SUPERUSER; --",
      "a$$; DROP TABLE platform_schema_migrations; $$",
      "app'; ALTER ROLE migration_owner SUPERUSER; --",
      'quoted"role',
      "UPPER",
      "",
      "a".repeat(64),
    ];
    const client = await db.owner.connect();
    const issued: unknown[] = [];
    const original = client.query.bind(client);
    // Spy: any query issued for a hostile name is a failure.
    (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
      issued.push(args[0]);
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    try {
      for (const name of hostile) {
        await assert.rejects(
          ensureAppRole(client, "hostile-password-0123456789", name),
          /plain unquoted identifier/,
        );
        await assert.rejects(
          grantAppRole(client, name),
          /plain unquoted identifier/,
        );
      }
    } finally {
      client.release();
    }
    assert.deepEqual(issued, [], "no SQL was issued for hostile names");
    for (const name of hostile)
      await assert.rejects(
        migrateDatabase({
          ownerUrl: db.ownerUrl,
          appRole: name,
          appRolePassword: "hostile-password-0123456789",
        }),
        /plain unquoted identifier/,
      );
    assert.deepEqual(await roleSnapshot(db.owner), before, "no role changes");
    const table = await db.owner.query(
      "SELECT to_regclass('public.platform_schema_migrations') AS t",
    );
    assert.equal(table.rows[0].t, null, "the failed migration rolled back");
  } finally {
    await db.close();
  }
});

test("pre-existing privileged or member app roles fail closed without rotation or schema changes", async () => {
  const db = await freshDatabase({ migrate: false });
  const admin = new pg.Client({
    connectionString: process.env.CATALOG_TEST_ADMIN_URL,
  });
  await admin.connect();
  const tag = db.name.slice(-12);
  // Only the bootstrap superuser can create REPLICATION/BYPASSRLS roles.
  const cases: [string, string][] = [
    [
      `sa_repl_${tag}`,
      `CREATE ROLE sa_repl_${tag} LOGIN REPLICATION PASSWORD 'old-password-0123456789'`,
    ],
    [
      `sa_brls_${tag}`,
      `CREATE ROLE sa_brls_${tag} LOGIN BYPASSRLS PASSWORD 'old-password-0123456789'`,
    ],
    [
      `sa_memb_${tag}`,
      `CREATE ROLE sa_memb_${tag} LOGIN PASSWORD 'old-password-0123456789'; GRANT pg_read_all_data TO sa_memb_${tag}`,
    ],
    [`sa_nolg_${tag}`, `CREATE ROLE sa_nolg_${tag} NOLOGIN`],
  ];
  try {
    for (const [, sql] of cases) await admin.query(sql);
    const before = await roleSnapshot(db.owner);
    for (const [role] of cases) {
      await assert.rejects(
        migrateDatabase({
          ownerUrl: db.ownerUrl,
          appRole: role,
          appRolePassword: "new-password-0123456789",
        }),
        /must be a plain LOGIN role|must not be a member/,
        role,
      );
    }
    assert.deepEqual(
      await roleSnapshot(db.owner),
      before,
      "role flags unchanged",
    );
    const members = await admin.query(
      `SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
       WHERE r.rolname = $1`,
      [`sa_memb_${tag}`],
    );
    assert.equal(members.rows[0].n, 1, "membership untouched");
    // The password was not rotated: the old one still logs in.
    const u = new URL(db.appUrl);
    u.username = `sa_repl_${tag}`;
    u.password = "old-password-0123456789";
    const old = new pg.Client({ connectionString: u.toString() });
    await old.connect();
    await old.end();
    const table = await db.owner.query(
      "SELECT to_regclass('public.platform_schema_migrations') AS t",
    );
    assert.equal(table.rows[0].t, null, "every refused migration rolled back");
    // A fresh role created by the CREATEROLE owner (which gets ADMIN on it,
    // the reverse membership direction) is accepted and stays plain.
    const fresh = `sa_fresh_${tag}`;
    expectRole(fresh);
    try {
      const report = await migrateDatabase({
        ownerUrl: db.ownerUrl,
        appRole: fresh,
        appRolePassword: "fresh-password-0123456789",
      });
      assert.equal(report.appRoleGranted, true);
      const flags = await admin.query(
        `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin,
                (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS member_of,
                (SELECT count(*)::int FROM pg_auth_members m WHERE m.roleid = r.oid) AS has_members
         FROM pg_roles r WHERE rolname = $1`,
        [fresh],
      );
      assert.deepEqual(flags.rows, [
        {
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
          rolcanlogin: true,
          member_of: 0,
          has_members: 1,
        },
      ]);
      // Rerun (rotation path) over the owner-created role still succeeds.
      await migrateDatabase({
        ownerUrl: db.ownerUrl,
        appRole: fresh,
        appRolePassword: "fresh-password-9876543210",
      });
    } finally {
      await db.owner.query(`DROP OWNED BY ${fresh}`).catch(() => undefined);
      await db.owner
        .query(`DROP ROLE IF EXISTS ${fresh}`)
        .catch(() => undefined);
      await claimRole(db.owner, fresh);
    }
  } finally {
    for (const [role] of cases)
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
    await db.close();
  }
});
