import pg from "pg";
import { parseArgs } from "node:util";
import {
  clearClips,
  disableDatasetAccess,
  grantDatasetAccess,
  listSharingPermissions,
  recordSharingPermission,
  revokeSharingPermission,
} from "./datasets/operator.js";

/**
 * Operator-only dataset sharing tool: recipient-sharing evidence, per-clip
 * clearance and view grants. Uses the migration-owner credential
 * (MIGRATION_DATABASE_URL, never present in web/workflow services; local
 * development may reuse the loopback DATABASE_URL owner). It prints no
 * secrets and no evidence document content, only references and counts.
 *
 *   record  --ref R --dataset D --recipient U --evidence E --by WHO
 *   clear   --ref R (--clips ID,ID | --all-members) --by WHO
 *   grant   --ref R --actor STAFF_USER_ID
 *   revoke  --ref R --by WHO --reason TEXT      (also disables the grant)
 *   disable --dataset D --recipient U --actor STAFF_USER_ID
 *   list    --dataset D
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
    dataset: { type: "string" },
    recipient: { type: "string" },
    evidence: { type: "string" },
    by: { type: "string" },
    actor: { type: "string" },
    reason: { type: "string" },
    clips: { type: "string" },
    "all-members": { type: "boolean", default: false },
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
  let result: unknown;
  if (command === "record")
    result = await recordSharingPermission(pool, {
      permissionRef: need("ref"),
      datasetId: need("dataset"),
      recipientUserId: need("recipient"),
      evidenceRef: need("evidence"),
      recordedBy: need("by"),
    });
  else if (command === "clear")
    result = await clearClips(pool, {
      permissionRef: need("ref"),
      ...(values["all-members"]
        ? { allCurrentMembers: true }
        : { clipIds: need("clips").split(",") }),
      clearedBy: need("by"),
    });
  else if (command === "grant")
    result = await grantDatasetAccess(pool, {
      permissionRef: need("ref"),
      actorUserId: need("actor"),
    });
  else if (command === "revoke")
    result = await revokeSharingPermission(pool, {
      permissionRef: need("ref"),
      revokedBy: need("by"),
      reason: need("reason"),
    });
  else if (command === "disable") {
    await disableDatasetAccess(pool, {
      datasetId: need("dataset"),
      userId: need("recipient"),
      actorUserId: need("actor"),
    });
    result = { disabled: true };
  } else if (command === "list")
    result = await listSharingPermissions(pool, need("dataset"));
  else
    throw new Error("Expected record, clear, grant, revoke, disable or list");
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
