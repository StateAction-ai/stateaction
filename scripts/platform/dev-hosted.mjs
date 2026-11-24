import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  hostedDevProfile,
  HOSTED_DEV_READER,
} from "../../packages/server/src/hosted-dev.ts";
import { createOperatorIdentity } from "../../packages/server/test-auth/catalog-bootstrap.ts";
import { startCatalogPostgres } from "../../packages/server/test-auth/postgres.mjs";

const pg = createRequire(
  new URL("../../packages/server/package.json", import.meta.url),
)("pg");
const {
  HOSTED_DEV_STAFF_ID: staffId,
  HOSTED_DEV_AUTH_PASSWORD: password,
  DATABASE_URL,
} = process.env;
if (
  !staffId ||
  !password ||
  !DATABASE_URL ||
  !process.env.STATEACTION_LOCAL_FIXTURES
)
  throw new Error("Run through the hosted data launcher");

let db;
let next;
let signal = false;
const interrupt = () => {
  signal = true;
  next?.kill("SIGTERM");
};
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, interrupt);

try {
  db = await startCatalogPostgres();
  const env = {
    ...process.env,
    STATEACTION_HOSTED_DEV_AUTH_DATABASE_URL: db.appUrl,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  };
  delete env.HOSTED_DEV_AUTH_PASSWORD;
  const profile = hostedDevProfile(env);
  if (!profile) throw new Error("Hosted data profile is required");
  const hosted = new pg.Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 20_000,
  });
  try {
    await hosted.connect();
    const identity = await hosted.query(
      "SELECT current_user AS role, catalog_has_role($1, 'staff') AS staff",
      [staffId],
    );
    if (!identity.rows[0]?.staff)
      throw new Error("The mapped hosted identity no longer has staff access");
    if (profile.mode === "read-only") {
      if (identity.rows[0].role !== HOSTED_DEV_READER)
        throw new Error("Unexpected hosted database reader");
      await hosted.query("BEGIN READ WRITE");
      let refused = false;
      try {
        // Checks table permissions even with zero candidate rows.
        await hosted.query(
          "INSERT INTO access (user_id, role) SELECT 'no-rows', 'staff' WHERE false",
        );
      } catch (error) {
        refused = error.code === "42501";
      } finally {
        await hosted.query("ROLLBACK");
      }
      if (!refused)
        throw new Error("Hosted profile credentials permitted INSERT");
      console.error("Hosted Postgres refused the write probe.");
    }
  } finally {
    await hosted.end();
  }
  const local = new pg.Pool({ connectionString: db.ownerUrl, max: 1 });
  try {
    await createOperatorIdentity(local, {
      id: staffId,
      email: "hosted-preview@stateaction.local",
      name: "Local staff preview",
      password,
      grants: [{ role: "staff", enabled: true }],
    });
  } finally {
    await local.end();
  }
  if (!signal) {
    console.error(
      `Local sign-in at ${profile.origin}/login as hosted-preview@stateaction.local`,
    );
    next = spawn("pnpm", ["dev"], {
      cwd: fileURLToPath(new URL("../../apps/web", import.meta.url)),
      env,
      stdio: "inherit",
    });
    const [code] = await once(next, "exit");
    if (!signal) process.exitCode = code ?? 1;
  }
} catch (error) {
  console.error("Hosted development startup failed.", error.code ?? error.name);
  process.exitCode = 1;
} finally {
  await db?.stop();
}
