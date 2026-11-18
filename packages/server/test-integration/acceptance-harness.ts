import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { s3ObjectReader } from "../src/admission/object-reader.js";
import { acceptanceConfigFromEnv } from "../src/acceptance/config.js";
import type { AcceptanceDeps } from "../src/acceptance/service.js";
import { s3ObjectHasher } from "../src/acceptance/storage.js";
import { fixtureRunJob } from "../src/jobs/fixtures.js";
import {
  allocateJobOutput,
  completeTransport,
  journalReceipts,
  signParts,
  type Authority,
  type TransportDeps,
} from "../src/transport/index.js";
import {
  createActors,
  freshDatabase,
  type Actors,
  type TestDb,
} from "./harness.js";
import { queuedJob } from "./jobs-harness.js";
import {
  depsFor,
  putPart,
  realProvider,
  realS3,
  s3Config,
} from "./transport-harness.js";

export const sha = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");

export type AcceptanceDb = TestDb & { actors: Actors };

export async function acceptanceDatabase(): Promise<AcceptanceDb> {
  const db = await freshDatabase();
  return Object.assign(db, { actors: await createActors(db.owner) });
}

export async function acceptanceDeps(db: AcceptanceDb) {
  const config = s3Config();
  realS3();
  const transport: TransportDeps = depsFor(db, await realProvider());
  const accept: AcceptanceDeps = {
    pool: db.app,
    reader: s3ObjectReader(config, { timeoutMs: 15_000 }),
    hasher: s3ObjectHasher(config),
    config: acceptanceConfigFromEnv({}),
  };
  return { transport, accept };
}

export type RunningJob = {
  jobId: string;
  recordingId: string;
  nonce: string;
  authority: Extract<Authority, { kind: "job" }>;
};

export async function runningJob(
  db: AcceptanceDb,
  options: { deadlineSeconds?: number } = {},
): Promise<RunningJob> {
  const { jobId, recordingId } = await queuedJob(db);
  const { nonce } = await fixtureRunJob(db.owner, jobId, options);
  return { jobId, recordingId, nonce, authority: { kind: "job", jobId } };
}

export type Uploaded = {
  fileId: string;
  slot: string;
  role: string;
  size: number;
  sha: string;
  body: Buffer;
};

/** Real multipart upload of one output through the job-scoped transport. */
export async function uploadOutput(
  transport: TransportDeps,
  job: RunningJob,
  slot: string,
  role: string,
  body: Buffer,
  options: { declaredSha?: string } = {},
): Promise<Uploaded> {
  const declared = options.declaredSha ?? sha(body);
  const plan = await allocateJobOutput(transport, job.authority, {
    slot,
    role: role as never,
    sizeBytes: String(body.length),
    sha256: declared,
  });
  const signed = await signParts(transport, job.authority, plan.fileId, {
    expectedTransportEpoch: plan.transportEpoch,
    partNumbers: [1],
  });
  const put = await putPart(signed.parts[0]!, body);
  await journalReceipts(transport, job.authority, plan.fileId, {
    expectedTransportEpoch: plan.transportEpoch,
    receipts: [
      { partNumber: 1, etag: put.etag!, sizeBytes: String(body.length) },
    ],
  });
  await completeTransport(transport, job.authority, plan.fileId, {
    expectedTransportEpoch: plan.transportEpoch,
  });
  return {
    fileId: plan.fileId,
    slot,
    role,
    size: body.length,
    sha: declared,
    body,
  };
}

const CLIP_FILES: Array<[key: string, role: string, name: string]> = [
  ["rgb_mp4", "clip_mp4", "rgb.mp4"],
  ["hand_arrays_npz", "hand_arrays_npz", "hand-arrays.npz"],
  [
    "hand_observations_json",
    "hand_observations_json",
    "hand-observations.json",
  ],
  ["frame_map_json", "frame_map_json", "frame-map.json"],
  ["thumbnail_jpeg", "thumbnail_jpeg", "thumbnail.jpg"],
  ["viewer_rrd", "viewer_rrd", "viewer.rrd"],
];

const FIXTURE = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/conformance/fixtures/artifacts/processing-result.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, any>;

export async function uploadClip(
  transport: TransportDeps,
  job: RunningJob,
  ordinal: number,
  skip: string[] = [],
): Promise<Uploaded[]> {
  const dir = `clips/${String(ordinal).padStart(3, "0")}`;
  const out: Uploaded[] = [];
  for (const [, role, name] of CLIP_FILES) {
    if (skip.includes(role)) continue;
    out.push(
      await uploadOutput(
        transport,
        job,
        `${dir}/${name}`,
        role,
        Buffer.from(`${job.jobId}:${dir}/${name}:${randomUUID()}`),
      ),
    );
  }
  return out;
}

/** A contract-valid processing-result.v2 for the uploaded clips and the job's admitted identity. */
export async function manifestFor(
  db: AcceptanceDb,
  job: RunningJob,
  clips: Uploaded[][],
  mutate: (doc: Record<string, any>) => void = () => {},
): Promise<Buffer> {
  const inputs = (
    await db.owner.query("SELECT * FROM job_inputs WHERE job_id = $1", [
      job.jobId,
    ])
  ).rows[0];
  const mcap = (
    await db.owner.query(
      "SELECT id, size_bytes::text, sha256 FROM files WHERE recording_id = $1 AND role = 'source_mcap'",
      [job.recordingId],
    )
  ).rows[0];
  const doc: Record<string, any> = structuredClone(FIXTURE);
  doc.schema = "stateaction.processing_result.v2";
  doc.job_id = job.jobId;
  doc.recording_id = job.recordingId;
  doc.source_manifest_sha256 = inputs.source_manifest_sha256;
  doc.provenance = {
    ...doc.provenance,
    code_revision: inputs.code_revision,
    image_spec_sha256: inputs.image_spec_sha256,
    config_sha256: inputs.config_sha256,
    profile_revision: inputs.profile_revision,
    model: { ...doc.provenance.model, asset_sha256: inputs.model_sha256 },
  };
  doc.verified_sources = [
    { file_id: mcap.id, size_bytes: mcap.size_bytes, sha256: mcap.sha256 },
  ];
  doc.attestation = {
    invocation_nonce: job.nonce,
    rgb_profile: "h264_mcap_v1",
    source_file_id: mcap.id,
    source_eof_verified: true,
  };
  const template = doc.clips[0];
  doc.outputs = clips.flat().map((o) => ({
    file_id: o.fileId,
    role: o.role,
    relative_path: o.slot,
    size_bytes: String(o.size),
    sha256: o.sha,
  }));
  doc.clips = clips.map((files, i) => ({
    ...structuredClone(template),
    clip_id: randomUUID(),
    clip_ordinal: i,
    title: `Clip ${i + 1}`,
    files: Object.fromEntries(
      CLIP_FILES.map(([key, role]) => [
        key,
        files.find((f) => f.role === role)?.fileId ?? randomUUID(),
      ]),
    ),
  }));
  mutate(doc);
  return Buffer.from(JSON.stringify(doc));
}

export const checksSummary = (doc: Record<string, any>) => {
  const c = { pass: 0, warn: 0, fail: 0, measured: 0, notEvaluated: 0 };
  for (const check of doc.checks)
    if (check.status === "not_evaluated") c.notEvaluated += 1;
    else (c as Record<string, number>)[check.status] += 1;
  return c;
};

export function candidateBody(
  job: RunningJob,
  manifest: Uploaded,
  doc: Record<string, any>,
  over: Record<string, unknown> = {},
) {
  return {
    schemaVersion: 1 as const,
    jobId: job.jobId,
    invocationNonce: job.nonce,
    manifestFileId: manifest.fileId,
    manifestSha256: manifest.sha,
    summary: {
      outcome: "succeeded" as const,
      clipCount: doc.clips.length,
      checks: checksSummary(doc),
      errorCode: null,
    },
    ...over,
  };
}
