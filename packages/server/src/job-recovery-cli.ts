import pg from "pg";
import { parseArgs } from "node:util";
import {
  operatorGuidance,
  recoverySnapshot,
  reconcileJob,
  requestJobCancel,
  retryJob,
} from "./jobs/index.js";
import { operatorDatabaseUrl } from "./jobs/operator-db.js";

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
 *   reconcile <jobId> --expect <state> (use existing evidence without dispatch)
 *   retry  <jobId> --expect <state>   (new job + new output prefix; refused until terminated)
 */
const url = operatorDatabaseUrl();
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { expect: { type: "string" } },
});
const [command, jobId] = positionals;
if (!jobId)
  throw new Error(
    "Usage: status|cancel|reconcile|retry <jobId> [--expect <state>]",
  );
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
  } else if (command === "reconcile") {
    console.log(
      JSON.stringify(
        await reconcileJob(
          { pool, config: {} },
          {
            jobId,
            expectedState: expect(),
            recordedBy: "operator_cli",
          },
        ),
      ),
    );
  } else if (command === "retry") {
    console.log(
      JSON.stringify(
        await retryJob({ pool }, { jobId, expectedState: expect() }),
      ),
    );
  } else throw new Error("Expected status, cancel, reconcile or retry");
} finally {
  await pool.end();
}
