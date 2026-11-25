// SA-98 browser e2e seed: runs two recipe jobs (segment, caption, hand_pose seal)
// through the REAL services on the e2e stack's own Postgres (restricted app role
// plus owner fixture steps) and bucket, then accepts them. The documents are the
// published conformance fixtures stamped with each job (the shared recipe
// harness), uploaded with real multipart transfers. Prints the recording, job and
// clip ids and the object keys the test overwrites with media (recording.mp4, the
// golden clip RRD).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { acceptanceConfigFromEnv } from "../src/acceptance/config.js";
import { advanceResult } from "../src/acceptance/service.js";
import { s3ObjectHasher } from "../src/acceptance/storage.js";
import { s3ObjectReader } from "../src/admission/object-reader.js";
import { recordExecutionEvidence, type JobsDeps } from "../src/jobs/service.js";
import { recordStageRun, startParallelRecipe } from "../src/jobs/stages.js";
import { JOBS_CONFIG } from "../test-integration/jobs-harness.js";
import { storageClient } from "../src/storage.js";
import { S3MultipartProvider } from "../src/transport/index.js";
import type { ServerConfig } from "../src/config.js";
import type { AcceptanceDb } from "../test-integration/acceptance-harness.js";
import {
  claimed,
  MODULES,
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
const seedRun = randomUUID();
const CLIP = { sourceStartNs: "13000000000", sourceEndNs: "21000000000" };
async function seed(withClip: boolean) {
  const s = await recipeJobOn(
    db,
    deps,
    {},
    `review-seed-${seedRun}-${withClip ? 1 : 2}`,
  );
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
    segmentsKey: await key(run.segFile.fileId),
    clipId: clip?.id ?? null,
    clipViewerKey: clip?.viewer ?? null,
  };
}

const [mode, jobId] = process.argv.slice(2);
let output;
try {
  if (mode === "--recipe-visualization" && jobId) {
    const {
      rows: [row],
    } = await owner.query<{ controller_lease_owner: string; call_id: string }>(
      `SELECT j.controller_lease_owner, r.call_id
       FROM jobs j JOIN job_stage_runs r ON r.job_id = j.id
       WHERE j.id = $1 AND r.stage = 'segment' AND r.state = 'running'`,
      [jobId],
    );
    if (!row) throw new Error("Fixture stage is not running");
    const jobs = { pool: app, config: JOBS_CONFIG } satisfies Pick<
      JobsDeps,
      "pool" | "config"
    >;
    const evidence = await recordExecutionEvidence(jobs, {
      jobId,
      recordedBy: "recipe-visualization-fixture",
      evidence: { kind: "local_child_reaped", executionRef: row.call_id },
    });
    if (!evidence.recorded)
      throw new Error("Fixture terminal evidence rejected");
    await recordStageRun(jobs, {
      jobId,
      owner: row.controller_lease_owner,
      stage: "segment",
      state: "failed",
      module: MODULES.segment,
      callId: row.call_id,
      errorCode: "receipt_missing",
    });
    output = { jobId };
  } else if (mode === "--recipe-visualization") {
    const succeeded = await seed(true);
    const s = await recipeJobOn(
      db,
      deps,
      { captionEnabled: false },
      "recipe-visualization",
    );
    if (!(await startParallelRecipe(app, s.jobId, s.ctl)))
      throw new Error("The fixture job did not select parallel execution");
    for (const stage of ["segment", "hand_pose"] as const) {
      const c = await claimed(s, stage);
      await recordStageRun(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage,
        state: "running",
        module: MODULES[stage],
        callId: c.callId,
      });
    }
    output = {
      succeeded,
      active: { jobId: s.jobId, recordingId: s.recordingId },
    };
  } else {
    output = { withClip: await seed(true), withoutClip: await seed(false) };
  }
} finally {
  await owner.end();
  await app.end();
}
process.stdout.write(JSON.stringify(output));
process.exit(0);
