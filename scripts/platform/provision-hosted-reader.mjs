import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const pg = createRequire(
  new URL("../../packages/server/package.json", import.meta.url),
)("pg");
const [staffEmail] = process.argv.slice(2);
const ownerUrl = process.env.CACHED_IMPORT_OWNER_DATABASE_URL;
const host = "dpg-dc2bek3rjlhs73ae5qg0-a.ohio-postgres.render.com";
if (!ownerUrl || !staffEmail || new URL(ownerUrl).hostname !== host)
  throw new Error(
    "Use the temporary Render Postgres session with a staff email",
  );
const owner = new pg.Client({
  connectionString: ownerUrl,
  connectionTimeoutMillis: 20_000,
});
const password = randomBytes(32).toString("base64url");
const url = new URL(ownerUrl);
url.username = "stateaction_dev_reader";
url.password = password;
try {
  await owner.connect();
  // The password is a parameter and is never printed or included in argv.
  await owner.query("BEGIN");
  const staff = (
    await owner.query(
      "SELECT id FROM \"user\" WHERE lower(email) = lower($1) AND catalog_has_role(id, 'staff')",
      [staffEmail],
    )
  ).rows;
  if (staff.length !== 1)
    throw new Error("An enabled hosted staff identity is required");
  await owner.query(
    "SELECT set_config('stateaction.hosted_dev_reader_password', $1, true)",
    [password],
  );
  await owner.query(`DO $$
    BEGIN
      EXECUTE format('CREATE ROLE stateaction_dev_reader LOGIN PASSWORD %L',
                     current_setting('stateaction.hosted_dev_reader_password'));
    END $$`);
  await owner.query(`
    ALTER ROLE stateaction_dev_reader SET default_transaction_read_only = 'on';
    GRANT CONNECT ON DATABASE stateaction TO stateaction_dev_reader;
    GRANT USAGE ON SCHEMA public TO stateaction_dev_reader;
    GRANT SELECT (id, name) ON public."user" TO stateaction_dev_reader;
    GRANT SELECT ON public.access, public.recordings, public.jobs, public.files,
      public.recording_admissions, public.job_output_slots, public.job_stage_runs,
      public.job_stage_claims, public.job_stage_evidence, public.job_result_candidates,
      public.job_execution_evidence, public.segment_marks, public.clips, public.reviews,
      public.datasets, public.dataset_clips, public.dataset_access,
      public.dataset_sharing_permissions, public.dataset_sharing_clearances,
      public.cached_processing_imports TO stateaction_dev_reader;
    GRANT SELECT (job_id, closed_at, outcome) ON public.job_output_closures
      TO stateaction_dev_reader;
    DO $$
    BEGIN
      IF to_regprocedure('public.stateaction_grant_stage_rerun_reads(name)') IS NOT NULL THEN
        PERFORM public.stateaction_grant_stage_rerun_reads('stateaction_dev_reader');
      END IF;
    END $$;
  `);
  const undesired = (
    await owner.query(`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
        AND has_any_column_privilege('stateaction_dev_reader', c.oid, 'INSERT, UPDATE, REFERENCES')
    ) OR EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
        AND has_table_privilege('stateaction_dev_reader', c.oid, 'DELETE, TRUNCATE, TRIGGER')
    ) OR EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef
        AND has_function_privilege('stateaction_dev_reader', p.oid, 'EXECUTE')
    ) OR has_schema_privilege('stateaction_dev_reader', 'public', 'CREATE')
      OR has_database_privilege('stateaction_dev_reader', current_database(), 'CREATE, TEMPORARY')
      AS can_write`)
  ).rows[0];
  if (undesired.can_write)
    throw new Error(
      "Existing database grants are incompatible with the reader",
    );
  const path = join(homedir(), ".config/stateaction/hosted-dev-db.env");
  await writeFile(
    path,
    `DATABASE_URL=${url}\nHOSTED_DEV_STAFF_ID=${staff[0].id}\n`,
    { mode: 0o600, flag: "wx" },
  );
  await owner.query("COMMIT");
  const check = new pg.Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 10000,
  });
  try {
    await check.connect();
    await check.query("BEGIN READ WRITE");
    let refused = false;
    try {
      await check.query(
        "INSERT INTO access (user_id, role) SELECT 'no-rows', 'staff' WHERE false",
      );
    } catch (error) {
      refused = error.code === "42501";
    }
    await check.query("ROLLBACK");
    await check.query("BEGIN READ ONLY");
    let largeObjectDenied = false;
    try {
      await check.query("SELECT pg_catalog.lo_create(0)");
    } catch (error) {
      largeObjectDenied = error.code === "25006" || error.code === "42501";
    }
    await check.query("ROLLBACK");
    if (!largeObjectDenied)
      throw new Error("The read-only session permits creating a large object");
    if (!refused)
      throw new Error(
        "The reader's INSERT privilege probe unexpectedly succeeded",
      );
  } finally {
    await check.end();
  }
  console.log(
    "Created stateaction_dev_reader. INSERT was refused. Private settings are in hosted-dev-db.env.",
  );
} catch (error) {
  await owner.query("ROLLBACK").catch(() => undefined);
  console.error(
    "Hosted reader provisioning stopped.",
    error.code ?? error.name,
  );
  process.exitCode = 1;
} finally {
  await owner.end();
}
