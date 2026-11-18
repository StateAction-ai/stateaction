// Used by the SA-27 job-control E2E: after the Pipeline seed, adds one recording whose
// current job is RUNNING (holds the admission slot) for the seeded collector and prints its ID.
import pg from "pg";
import { processedRecording } from "../test-integration/harness.js";

const appUrl = process.env.CATALOG_APP_URL;
const users = JSON.parse(process.env.SEED_USERS ?? "{}");
if (!appUrl || !users.collector)
  throw new Error("CATALOG_APP_URL and SEED_USERS are required");
const app = new pg.Pool({ connectionString: appUrl, max: 2 });
const actors = {
  collector: users.collector.id,
  staff: users.staff.id,
  customer: users.customer.id,
  outsider: users.outsider.id,
};
const live = await processedRecording(app, actors, 1);
await app.end();
process.stdout.write(JSON.stringify({ live: live.recordingId }));
process.exit(0);
