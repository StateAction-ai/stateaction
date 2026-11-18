import pg from "pg";
import { parseArgs } from "node:util";
import { s3ObjectHasher } from "./acceptance/storage.js";
import { loadMigrations } from "./migrations.js";
import { readRegularFile } from "./ops/bounded-read.js";
import {
  parseExpectedGrants,
  RestoreVerifyError,
  verifyRestoredCatalog,
  type VerifyLimits,
} from "./recovery/index.js";
import type { ServerConfig } from "./config.js";

/**
 * Read-only verification of a RESTORED catalog copy (SA-46). Prints ONE JSON
 * report; writes nothing to the database or to object storage; sends nothing
 * to a provider. Every failure prints a fixed message (never an input value,
 * URL, credential, host or raw exception) and exits non-zero.
 *
 *   restore-check [--expected-grants grants.json] [--max-files N]
 *                 [--max-gib N] [--object-timeout-s N] [--wall-s N]
 *
 * The database comes ONLY from RESTORE_CHECK_DATABASE_URL (the isolated
 * restored copy). It is refused when its host:port/database equals any live
 * identity this process can see: DATABASE_URL, MIGRATION_DATABASE_URL or the
 * component form DATABASE_HOST/DATABASE_PORT/DATABASE_NAME. That is a
 * best-effort guard against passing the wrong database, not proof of isolation:
 * the report says how many live identities were compared and never claims
 * isolation. Objects are read through the S3_* settings (GET only, streamed
 * through SHA-256, bounded). readyToReenable is always false.
 */
class CliError extends Error {}
const fail = (message: string): never => {
  throw new CliError(message);
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
function identity(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const u = new URL(value);
    const host = LOOPBACK.has(u.hostname)
      ? "loopback"
      : u.hostname.toLowerCase();
    return `${host}:${u.port || "5432"}/${decodeURIComponent(u.pathname.slice(1))}`;
  } catch {
    return fail("a database URL is not valid");
  }
}
function componentIdentity(): string | undefined {
  const {
    DATABASE_HOST: host,
    DATABASE_PORT: port,
    DATABASE_NAME: name,
  } = process.env;
  if (!host || !name) return undefined;
  const h = LOOPBACK.has(host) ? "loopback" : host.toLowerCase();
  return `${h}:${port || "5432"}/${name}`;
}

const required = (key: string): string => {
  const value = process.env[key];
  return value ? value : fail(`missing setting ${key}`);
};

async function main(): Promise<void> {
  const url = required("RESTORE_CHECK_DATABASE_URL");
  const target = identity(url)!;
  const live = [
    identity(process.env.DATABASE_URL),
    identity(process.env.MIGRATION_DATABASE_URL),
    componentIdentity(),
  ].filter((x): x is string => x !== undefined);
  if (live.includes(target))
    fail("refusing to verify a live database identity");
  if (
    (process.env.APP_ENV ?? "local") === "local" &&
    !target.startsWith("loopback:")
  )
    fail("local tooling refuses non-loopback databases");

  let values;
  try {
    values = parseArgs({
      options: {
        "expected-grants": { type: "string" },
        "max-files": { type: "string" },
        "max-gib": { type: "string" },
        "object-timeout-s": { type: "string" },
        "wall-s": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    return fail("invalid arguments");
  }
  const num = (key: string, scale = 1): number | undefined => {
    const raw = values[key as keyof typeof values] as string | undefined;
    if (raw === undefined) return undefined;
    if (!/^\d{1,9}(\.\d{1,3})?$/.test(raw)) fail(`--${key} must be a number`);
    return Number(raw) * scale;
  };
  const limits: Partial<VerifyLimits> = {};
  const set = <K extends keyof VerifyLimits>(k: K, v: number | undefined) => {
    if (v !== undefined) limits[k] = v as VerifyLimits[K];
  };
  set("maxFiles", num("max-files"));
  set("maxTotalBytes", num("max-gib", 1024 ** 3));
  set("perObjectTimeoutMs", num("object-timeout-s", 1000));
  set("totalWallMs", num("wall-s", 1000));

  const grantsPath = values["expected-grants"];
  const expectedGrants = grantsPath
    ? parseExpectedGrants(
        JSON.parse(readRegularFile(grantsPath).toString("utf8")),
      )
    : undefined;
  const storage = {
    endpoint: required("S3_ENDPOINT"),
    region: required("S3_REGION"),
    bucket: required("S3_BUCKET"),
    accessKeyId: required("S3_ACCESS_KEY_ID"),
    secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
  } as ServerConfig;

  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 5000,
    query_timeout: 30_000,
    application_name: "stateaction-restore-check",
  });
  try {
    await client.connect();
    const report = await verifyRestoredCatalog({
      client,
      hasher: s3ObjectHasher(storage),
      expectedMigrations: (await loadMigrations()).map((m) => ({
        version: m.version,
        sha256: m.sha256,
      })),
      ...(expectedGrants ? { expectedGrants } : {}),
      limits,
    });
    console.log(
      JSON.stringify({
        ...report,
        isolation: {
          status: live.length
            ? "target_differs_from_visible_live_identities"
            : "unverified_no_live_identity_visible",
          liveIdentitiesCompared: live.length,
          note: "Best-effort wrong-database guard only; network and instance isolation are not verified here.",
        },
      }),
    );
  } finally {
    await Promise.race([
      client.end().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3000).unref()),
    ]);
  }
}

try {
  await main();
} catch (error) {
  const sqlstate =
    typeof (error as { code?: unknown })?.code === "string" &&
    /^[0-9A-Z]{5}$|^E[A-Z]{3,12}$/.test((error as { code: string }).code)
      ? ` (${(error as { code: string }).code})`
      : "";
  const message =
    error instanceof CliError || error instanceof RestoreVerifyError
      ? error.message
      : `unreadable input, storage or database error${sqlstate}`;
  console.error(`restore-check failed: ${message}`);
  process.exitCode = 2;
}
