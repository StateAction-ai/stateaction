import pg from "pg";
import { parseArgs } from "node:util";
import {
  operatorGuidance,
  recoverySnapshot,
  requestJobCancel,
  retryJob,
} from "./jobs/index.js";

/**
 * Operator-only manual recovery (SA-27): status with exact instructions,
 * cancel and retry bound to the job and state the operator saw. Uses the
 * migration-owner credential (MIGRATION_DATABASE_URL, never present in the web,
 * workflow or cron services; local development may reuse the loopback
 * DATABASE_URL owner). It never records evidence, never clears the admission
 * slot and never edits a job row directly: every change goes through the same
 * guarded service functions the repair pass uses. Prints no secrets.
 *
 *   status <jobId>
 *   cancel <jobId> --expect <state>   (becomes cancelled only after exact termination evidence)
 *   retry  <jobId> --expect <state>   (new job + new output prefix; refused until terminated)
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
  options: { expect: { type: "string" } },
});
const [command, jobId] = positionals;
if (!jobId)
  throw new Error("Usage: status|cancel|retry <jobId> [--expect <state>]");
const expect = () => {
  if (!values.expect)
    throw new Error("--expect <state> is required (the state you saw)");
  return values.expect;
};
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  if (command === "status") {
    const snapshot = await recoverySnapshot(pool, jobId);
    console.log(
      JSON.stringify({ ...snapshot, guidance: operatorGuidance(snapshot) }),
    );
  } else if (command === "cancel") {
    console.log(
      JSON.stringify(
        await requestJobCancel({ pool }, jobId, {
          expectedState: expect(),
          requireCurrent: true,
        }),
      ),
    );
  } else if (command === "retry") {
    console.log(
      JSON.stringify(
        await retryJob({ pool }, { jobId, expectedState: expect() }),
      ),
    );
  } else throw new Error("Expected status, cancel or retry");
} finally {
  await pool.end();
}
