// Throwaway Postgres for auth runtime tests: a uniquely named, labelled
// container on an ephemeral loopback port with tmpfs data. It shares no
// Compose project, port, volume or data with other work and is always removed.
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

// Same pinned image as infra/compose.yaml.
export const POSTGRES_IMAGE =
  "postgres:17.9-alpine3.23@sha256:c7526c0f6c3f30260a563d7bcf8ad778effac59a44f8ffa86678c35418338609";

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

export async function startPostgres() {
  const name = `stateaction-sa15-auth-${randomBytes(6).toString("hex")}`;
  const password = randomBytes(18).toString("base64url");
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--label",
    "stateaction.owner=sa-15-auth-test",
    "--tmpfs",
    "/var/lib/postgresql/data",
    "-e",
    "POSTGRES_USER=auth_test",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_DB=auth_test",
    "-p",
    "127.0.0.1::5432",
    POSTGRES_IMAGE,
  ]);
  const stop = () => {
    try {
      docker(["rm", "-f", "-v", name]);
    } catch {
      // Already gone.
    }
  };
  try {
    const port = docker(["port", name, "5432/tcp"])
      .split("\n")[0]
      .split(":")
      .pop();
    for (let i = 0; i < 120; i++) {
      try {
        // Ready only after the init scripts finish and TCP accepts queries.
        docker([
          "exec",
          name,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "auth_test",
          "-d",
          "auth_test",
        ]);
        docker([
          "exec",
          name,
          "psql",
          "-h",
          "127.0.0.1",
          "-U",
          "auth_test",
          "-d",
          "auth_test",
          "-c",
          "select 1",
        ]);
        return {
          name,
          url: `postgresql://auth_test:${password}@127.0.0.1:${port}/auth_test`,
          stop,
        };
      } catch {
        await sleep(500);
      }
    }
    throw new Error("Postgres did not become ready");
  } catch (error) {
    stop();
    throw error;
  }
}

/**
 * Throwaway Postgres laid out like a managed deployment (mirrors
 * scripts/catalog-integration.sh): a bootstrap superuser only provisions; a
 * NOSUPERUSER/NOCREATEDB migration owner with CREATEROLE owns the database and
 * creates the restricted `stateaction_app` login. Tests migrate and seed with
 * the owner and run Better Auth and the access store as `stateaction_app`.
 */
export async function startCatalogPostgres() {
  if (process.env.CATALOG_TEST_ADMIN_URL) return externalCatalogPostgres();
  const name = `stateaction-sa15-catalog-${randomBytes(6).toString("hex")}`;
  const secret = () => randomBytes(18).toString("hex");
  const admin = secret();
  const owner = secret();
  const app = secret();
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--label",
    "stateaction.owner=sa-15-auth-test",
    "--tmpfs",
    "/var/lib/postgresql/data",
    "-e",
    "POSTGRES_USER=bootstrap",
    "-e",
    `POSTGRES_PASSWORD=${admin}`,
    "-e",
    "POSTGRES_DB=postgres",
    "-p",
    "127.0.0.1::5432",
    POSTGRES_IMAGE,
  ]);
  const stop = () => {
    try {
      docker(["rm", "-f", "-v", name]);
    } catch {
      // Already gone.
    }
  };
  const psql = (user, password, db, sql) =>
    execFileSync(
      "docker",
      [
        "exec",
        "-e",
        `PGPASSWORD=${password}`,
        name,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-qAt",
        "-h",
        "127.0.0.1",
        "-U",
        user,
        "-d",
        db,
        "-c",
        sql,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  try {
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      try {
        psql("bootstrap", admin, "postgres", "select 1");
        ready = true;
      } catch {
        await sleep(500);
      }
    }
    if (!ready) throw new Error("Postgres did not become ready");
    psql(
      "bootstrap",
      admin,
      "postgres",
      `CREATE ROLE migration_owner LOGIN CREATEROLE NOSUPERUSER NOCREATEDB NOBYPASSRLS PASSWORD '${owner}'`,
    );
    psql(
      "migration_owner",
      owner,
      "postgres",
      `CREATE ROLE stateaction_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${app}'`,
    );
    psql(
      "bootstrap",
      admin,
      "postgres",
      "CREATE DATABASE stateaction OWNER migration_owner",
    );
    const port = docker(["port", name, "5432/tcp"])
      .split("\n")[0]
      .split(":")
      .pop();
    const url = (user, password) =>
      `postgresql://${user}:${password}@127.0.0.1:${port}/stateaction`;
    return {
      name,
      ownerUrl: url("migration_owner", owner),
      appUrl: url("stateaction_app", app),
      /** Owner-credential SQL (operator actions), returning unaligned rows. */
      ownerSql: (sql) => psql("migration_owner", owner, "stateaction", sql),
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}

/**
 * Same layout on an already running, resource-guarded local Postgres (no
 * Docker): CATALOG_TEST_{ADMIN,OWNER,APP}_URL point at a server where the
 * migration_owner and stateaction_app roles exist. A uniquely named database
 * owned by migration_owner is created and force-dropped on stop.
 */
async function externalCatalogPostgres() {
  const { default: pg } = await import("pg");
  const name = `sa_e2e_${randomBytes(6).toString("hex")}`;
  const withDb = (url) => {
    const u = new URL(url);
    u.pathname = `/${name}`;
    return u.toString();
  };
  const admin = new pg.Client({
    connectionString: process.env.CATALOG_TEST_ADMIN_URL,
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name} OWNER migration_owner`);
  await admin.end();
  const ownerUrl = withDb(process.env.CATALOG_TEST_OWNER_URL);
  const appUrl = withDb(process.env.CATALOG_TEST_APP_URL);
  let stopped = false;
  return {
    name,
    ownerUrl,
    appUrl,
    /** Owner-credential SQL; unaligned rows like `psql -qAt`. */
    ownerSql: (sql) => {
      // Synchronous like the Docker psql helper (existing tests rely on it).
      const out = spawnSync(
        process.execPath,
        [
          "-e",
          `const pg=require("pg");(async()=>{const c=new pg.Client({connectionString:process.env.OWNER_URL});await c.connect();try{const r=await c.query({text:process.env.SQL,rowMode:"array"});process.stdout.write((r.rows??[]).map(x=>x.join("|")).join("\\n"))}finally{await c.end()}})().catch(e=>{console.error(e.message);process.exit(1)})`,
        ],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: { PATH: process.env.PATH, OWNER_URL: ownerUrl, SQL: sql },
          encoding: "utf8",
        },
      );
      if (out.status !== 0) throw new Error(out.stderr);
      return out.stdout.trim();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      const a = new pg.Client({
        connectionString: process.env.CATALOG_TEST_ADMIN_URL,
      });
      a.connect()
        .then(() => a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`))
        .catch(() => undefined)
        .finally(() => a.end().catch(() => undefined));
    },
  };
}
