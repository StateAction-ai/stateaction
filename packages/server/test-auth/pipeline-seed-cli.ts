// Used by the Pipeline browser/HTTP E2E: writes real catalog rows through the
// access layer as the restricted app role (processing, completed with clips,
// failed) for the seeded collector, and prints their recording IDs.
import { fixtureAcceptResult } from "../src/jobs/fixtures.js";
import { ownerPoolFor } from "../test-integration/harness.js";
import pg from "pg";
import { processedRecording } from "../test-integration/harness.js";

const appUrl = process.env.CATALOG_APP_URL;
const users = JSON.parse(process.env.SEED_USERS ?? "{}");
if (!appUrl || !users.collector)
  throw new Error("CATALOG_APP_URL and SEED_USERS are required");
const app = new pg.Pool({ connectionString: appUrl, max: 4 });
const actors = {
  collector: users.collector.id,
  staff: users.staff.id,
  customer: users.customer.id,
  outsider: users.outsider.id,
};
const completed = await processedRecording(app, actors, 2);
await fixtureAcceptResult(ownerPoolFor(app), app, {
  jobId: completed.jobId,
  manifestFileId: completed.manifestFileId,
  manifestSha256: completed.manifestSha256,
  clips: completed.clips,
});
const failed = await processedRecording(app, actors, 1);
await app.query(
  `UPDATE jobs SET state = 'failed', error_code = 'source_checksum_mismatch',
     error_message = 'bad bytes at /srv/objects/jobs/x/outputs/y.bin', finished_at = now()
   WHERE id = $1`,
  [failed.jobId],
);
// Seed the in-flight job last so a later fixture cannot retire it.
const processing = await processedRecording(app, actors, 1);
await app.end();
process.stdout.write(
  JSON.stringify({
    processing: processing.recordingId,
    completed: completed.recordingId,
    failed: failed.recordingId,
  }),
);
process.exit(0);
