// SA-98 browser e2e seed: runs two recipe jobs (segment, caption, hand_pose seal)
// through the REAL services on the e2e stack's own Postgres (restricted app role
// plus owner fixture steps) and bucket, then accepts them. The documents are the
// published conformance fixtures stamped with each job (the shared recipe
// harness), uploaded with real multipart transfers. Prints the recording, job and
// clip ids and the object keys the test overwrites with media (recording.mp4, the
// golden clip RRD).
import pg from "pg";
import { acceptanceConfigFromEnv } from "../src/acceptance/config.js";
import { advanceResult } from "../src/acceptance/service.js";
import { s3ObjectHasher } from "../src/acceptance/storage.js";
import { s3ObjectReader } from "../src/admission/object-reader.js";
import { storageClient } from "../src/storage.js";
import { S3MultipartProvider } from "../src/transport/index.js";
import type { ServerConfig } from "../src/config.js";
import type { AcceptanceDb } from "../test-integration/acceptance-harness.js";
import {
  recipeJobOn,
  runRecipe,
  seal,
} from "../test-integration/recipe-harness.js";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const users = JSON.parse(need("SEED_USERS")) as Record<string, { id: string }>;
const config: ServerConfig = {
  appEnv: "local",
  databaseUrl: "unused",
  endpoint: need("S3_ENDPOINT"),
  publicEndpoint: need("S3_ENDPOINT"),
  region: "us-east-1",
  bucket: need("S3_BUCKET"),
  accessKeyId: need("S3_ACCESS_KEY_ID"),
  secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
};
const owner = new pg.Pool({
  connectionString: need("CATALOG_TEST_OWNER_URL"),
  max: 2,
});
const app = new pg.Pool({ connectionString: need("CATALOG_APP_URL"), max: 3 });
const db = {
  name: "e2e",
  ownerUrl: need("CATALOG_TEST_OWNER_URL"),
  appUrl: need("CATALOG_APP_URL"),
  owner,
  app,
  actors: {
    collector: users.collector!.id,
    staff: users.staff!.id,
    customer: users.customer!.id,
    outsider: users.outsider!.id,
  },
  close: async () => {},
} as unknown as AcceptanceDb;
const deps = {
  transport: {
    pool: app,
    provider: new S3MultipartProvider(
      storageClient(config, 30_000),
      storageClient(config, 30_000),
      config.bucket,
    ),
  },
  accept: {
    pool: app,
    reader: s3ObjectReader(config, { timeoutMs: 15_000 }),
    hasher: s3ObjectHasher(config),
    config: acceptanceConfigFromEnv({}),
  },
};

// The clip covers 8-16 s of the first decoded frame's clock (origin 5 s).
const CLIP = { sourceStartNs: "13000000000", sourceEndNs: "21000000000" };
async function seed(withClip: boolean) {
  const s = await recipeJobOn(db, deps, {}, `review-seed-${withClip ? 1 : 2}`);
  // The first recording also has a second failed caption (a model failure, not a missing row).
  const run = await runRecipe(
    s,
    (captions) => {
      if (!withClip) return;
      const row = captions.rows[1];
      captions.rows[1] = {
        segment_id: row.segment_id,
        status: "failed",
        error_code: "engine_timeout",
      };
    },
    withClip ? { clip: CLIP } : {},
  );
  await seal(s, run);
  const ack = await advanceResult(s.accept, s.jobId);
  if (ack?.candidateStatus !== "accepted")
    throw new Error(`job not accepted: ${JSON.stringify(ack)}`);
  const key = async (id: string) =>
    (
      await owner.query<{ object_key: string }>(
        "SELECT object_key FROM files WHERE id = $1",
        [id],
      )
    ).rows[0]!.object_key;
  const clip = withClip
    ? (
        await owner.query<{ id: string; viewer: string }>(
          `SELECT c.id, f.object_key AS viewer FROM clips c
           JOIN files f ON f.id = c.viewer_rrd_file_id WHERE c.job_id = $1`,
          [s.jobId],
        )
      ).rows[0]!
    : null;
  return {
    recordingId: s.recordingId,
    jobId: s.jobId,
    mp4Key: await key(run.mp4.fileId),
    clipId: clip?.id ?? null,
    clipViewerKey: clip?.viewer ?? null,
  };
}

const withClip = await seed(true);
const withoutClip = await seed(false);
await owner.end();
await app.end();
process.stdout.write(JSON.stringify({ withClip, withoutClip }));
process.exit(0);
