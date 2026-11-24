import pg from "pg";
import { importCachedProcessing } from "./cached-import.js";
import { serverConfig } from "./config.js";
import { storageClient } from "./storage.js";

const [command, root, staffEmail, ...flags] = process.argv.slice(2);
const hosted = flags.includes("--hosted");
const ownerUrl = process.env.CACHED_IMPORT_OWNER_DATABASE_URL;
const localHosts = ["127.0.0.1", "localhost", "[::1]"];
if (
  command !== "publish" ||
  !root ||
  !staffEmail ||
  !ownerUrl ||
  flags.some((flag) => !["--hosted", "--approve-for-data"].includes(flag))
) {
  throw new Error(
    "Use publish <bundle-dir> <operator-staff-email> [--approve-for-data] [--hosted] with CACHED_IMPORT_OWNER_DATABASE_URL",
  );
}
const db = new URL(ownerUrl);
const config = serverConfig(process.env);
const s3 = new URL(config.endpoint);
if (
  hosted
    ? !db.hostname.endsWith(".render.com") ||
      db.searchParams.get("sslmode") !== "verify-full" ||
      config.appEnv !== "production" ||
      config.bucket !== "stateaction-prod" ||
      s3.protocol !== "https:" ||
      !s3.hostname.endsWith(".r2.cloudflarestorage.com")
    : config.appEnv !== "local" ||
      !localHosts.includes(db.hostname) ||
      !localHosts.includes(s3.hostname)
) {
  throw new Error(
    "Import database and storage must both match the requested environment",
  );
}

const pool = new pg.Pool({
  connectionString: ownerUrl,
  max: 1,
  connectionTimeoutMillis: 10_000,
});
const client = storageClient(config, 60_000);
try {
  const report = await importCachedProcessing({
    root,
    pool,
    config,
    client,
    staffEmail,
    hosted,
    approve: flags.includes("--approve-for-data"),
  });
  console.log(JSON.stringify(report));
} catch (error) {
  const state = error as { code?: string; name?: string; message?: string };
  const message = state.name === "Error" ? state.message : state.name;
  console.error("Cached import failed.", state.code ?? "", message);
  process.exitCode = 1;
} finally {
  client.destroy();
  await pool.end();
}
