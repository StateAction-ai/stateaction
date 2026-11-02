import pg from "pg";
import { parseArgs } from "node:util";
import {
  listIngestPermissions,
  recordIngestPermission,
  revokeIngestPermission,
} from "./admission/permissions.js";

/**
 * Operator-only pilot permission evidence tool. Uses the migration-owner
 * credential (MIGRATION_DATABASE_URL, never present in web/workflow services;
 * local development may reuse the loopback DATABASE_URL owner).
 */
const env = process.env.APP_ENV ?? "local";
const url =
  process.env.MIGRATION_DATABASE_URL ??
  (env === "local" ? process.env.DATABASE_URL : undefined);
if (!url) throw new Error("Missing server setting: MIGRATION_DATABASE_URL");
if (
  env === "local" &&
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)
)
  throw new Error("Local operator tooling refuses non-loopback databases");
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    ref: { type: "string" },
    owner: { type: "string" },
    scope: { type: "string" },
    evidence: { type: "string" },
    by: { type: "string" },
    reason: { type: "string" },
    "capture-only": { type: "boolean", default: false },
  },
});
const need = (key: keyof typeof values) => {
  const value = values[key];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`--${key} is required`);
  return value;
};
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const command = positionals[0];
  if (command === "record")
    console.log(
      JSON.stringify(
        await recordIngestPermission(pool, {
          permissionRef: need("ref"),
          ownerUserId: need("owner"),
          pilotScope: need("scope"),
          coversCapture: true,
          coversProcessing: !values["capture-only"],
          evidenceRef: need("evidence"),
          recordedBy: need("by"),
        }),
      ),
    );
  else if (command === "revoke")
    console.log(
      JSON.stringify(
        await revokeIngestPermission(pool, {
          permissionRef: need("ref"),
          revokedBy: need("by"),
          reason: need("reason"),
        }),
      ),
    );
  else if (command === "list")
    console.log(
      JSON.stringify(await listIngestPermissions(pool, need("owner"))),
    );
  else throw new Error("Expected record, revoke or list");
} finally {
  await pool.end();
}
