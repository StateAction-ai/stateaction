// One parallel test worker for worker-isolation.e2e.test.mjs: holds the same
// resources a real e2e world owns (a cloned database, a run role with its
// database, a bucket and a claimed port), reports them, then waits. A line on
// stdin stops it cleanly; the test may instead SIGKILL it.
import { freePort } from "../../../scripts/platform/free-port.mjs";
import {
  startCatalogPostgres,
  startPostgres,
} from "../../../packages/server/test-auth/postgres.mjs";
import { startSeaweedfs } from "./seaweedfs.mjs";

const world = await startCatalogPostgres();
const roleDb = await startPostgres();
const bucket = await startSeaweedfs();
const port = await freePort();
console.log(
  JSON.stringify({
    ready: true,
    pid: process.pid,
    port,
    database: world.name,
    roleDatabase: roleDb.name,
    bucket: bucket.bucket,
  }),
);
process.stdin.once("data", async () => {
  await world.stop();
  await roleDb.stop();
  await bucket.stop();
  process.exit(0);
});
