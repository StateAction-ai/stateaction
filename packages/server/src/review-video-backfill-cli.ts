import pg from "pg";
import { serverConfig } from "./config.js";
import { materializeReviewClipVideo } from "./datasets/review-video-backfill.js";
import { storageClient } from "./storage.js";

const [jobId, python, ...extra] = process.argv.slice(2);
const ownerUrl = process.env.REVIEW_VIDEO_OWNER_DATABASE_URL;
if (!jobId || !python || extra.length || !ownerUrl)
  throw new Error(
    "Provide <job-id> <absolute-processing-python> and REVIEW_VIDEO_OWNER_DATABASE_URL",
  );
const config = serverConfig();
const loopback = ["127.0.0.1", "localhost", "[::1]"];
if (
  config.appEnv !== "local" ||
  !loopback.includes(new URL(ownerUrl).hostname) ||
  !loopback.includes(new URL(config.endpoint).hostname) ||
  !loopback.includes(new URL(config.publicEndpoint).hostname) ||
  new URL(ownerUrl).pathname !== new URL(config.databaseUrl).pathname
)
  throw new Error(
    "Review video backfill requires a local owner connection and local storage",
  );

const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
const client = storageClient(config, 60_000);
try {
  console.log(
    await materializeReviewClipVideo(
      { pool, client, bucket: config.bucket, python },
      jobId,
    ),
  );
} finally {
  client.destroy();
  await pool.end();
}
