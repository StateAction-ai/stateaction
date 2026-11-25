import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { s3ObjectHasher } from "../acceptance/storage.js";
import { uuid, type Queryable } from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";
import { LEGACY_WHOLE_RECORDING_BINDING } from "./review-playable-media.js";
import {
  REVIEW_VIDEO_MAX_BYTES,
  REVIEW_VIDEO_SLOT,
} from "./review-video-policy.js";

type AcceptedSource = {
  clip_id: string;
  manifest_sha256: string;
  plan_sha256: string;
  source_key: string;
  source_sha256: string;
  source_size: string;
  task_input: Record<string, unknown>;
};

const DEADLINE_MS = 60 * 60 * 1000;

/** Operator procedure. The application role can only read the published row. */
export async function materializeReviewClipVideo(
  deps: {
    pool: Queryable;
    client: S3Client;
    bucket: string;
    python: string;
  },
  rawJobId: string,
) {
  const jobId = uuid(rawJobId, "jobId");
  if (!isAbsolute(deps.python))
    throw new Error("Use an absolute path to the locked processing Python");
  const {
    rows: [legacy],
  } = await deps.pool.query<{ sha256: string }>(
    `SELECT f.sha256 FROM jobs vj
     JOIN recordings r ON r.id = vj.recording_id AND r.deleted_at IS NULL
     JOIN review_clips vc ON vc.id = vj.clip_id
     JOIN clip_plans vp ON vp.recording_id = vc.recording_id AND vp.version = vc.plan_version
     JOIN job_output_slots s ON s.job_id = vj.id AND s.slot = 'recording.mp4'
     JOIN files f ON f.id = s.file_id AND f.job_id = s.job_id
       AND f.purpose = 'output' AND f.role = 'recording_mp4' AND f.state = 'verified'
     WHERE vj.id = $1 AND vj.kind = 'process_recording' AND vj.state = 'succeeded'
       AND vj.result_manifest_sha256 IS NOT NULL AND ${LEGACY_WHOLE_RECORDING_BINDING}`,
    [jobId],
  );
  if (legacy) return { jobId, sha256: legacy.sha256, alreadyAvailable: true };

  const {
    rows: [source],
  } = await deps.pool.query<AcceptedSource>(
    `SELECT c.id AS clip_id, j.result_manifest_sha256 AS manifest_sha256,
       p.manifest_sha256 AS plan_sha256, f.object_key AS source_key,
       f.sha256 AS source_sha256, f.size_bytes::text AS source_size, i.task_input
     FROM jobs j
     JOIN recordings r ON r.id = j.recording_id AND r.deleted_at IS NULL
     JOIN review_clips c ON c.id = j.clip_id AND c.recording_id = r.id
     JOIN clip_plans p ON p.recording_id = r.id AND p.version = c.plan_version
     JOIN job_inputs i ON i.job_id = j.id AND i.source_manifest_sha256 = j.source_manifest_sha256
     JOIN recording_admissions a ON a.recording_id = r.id AND a.outcome = 'admitted'
       AND a.source_manifest_sha256 = j.source_manifest_sha256
     JOIN LATERAL jsonb_array_elements(a.declared_files) doc ON doc ->> 'role' = 'source_mcap'
     JOIN files f ON f.id::text = doc ->> 'fileId' AND f.recording_id = r.id
       AND f.purpose = 'source' AND f.role = 'source_mcap' AND f.state IN ('completed', 'verified')
       AND f.sha256 = doc ->> 'sha256' AND f.size_bytes::text = doc ->> 'sizeBytes'
     WHERE j.id = $1 AND j.kind = 'clip_pipeline' AND j.state = 'succeeded'
       AND j.result_manifest_sha256 IS NOT NULL AND i.task_input ->> 'schemaVersion' = '4'
       AND i.task_input ->> 'jobId' = j.id::text AND i.task_input ->> 'targetId' = r.id::text
       AND i.task_input ->> 'sourceManifestSha256' = j.source_manifest_sha256
       AND i.task_input ->> 'rgbProfile' = a.rgb_profile
       AND i.task_input #>> '{clip,id}' = c.id::text
       AND i.task_input #>> '{clip,planSha256}' = p.manifest_sha256
       AND i.task_input #> '{clip,sourceRange}' = p.plan -> 'spans' -> c.ordinal`,
    [jobId],
  );
  if (!source)
    throw new CatalogError(
      "not_found",
      "Accepted clip or admitted source unavailable",
    );

  const {
    rows: [existing],
  } = await deps.pool.query<{ sha256: string }>(
    `SELECT b.sha256
     FROM review_clip_video_backfills b WHERE b.job_id = $1
     UNION ALL
     SELECT f.sha256 FROM job_output_slots s
     JOIN files f ON f.id = s.file_id AND f.job_id = s.job_id
       AND f.role = 'clip_mp4' AND f.state = 'verified'
     WHERE s.job_id = $1 AND s.slot = $2
     LIMIT 1`,
    [jobId, REVIEW_VIDEO_SLOT],
  );
  if (existing)
    return { jobId, sha256: existing.sha256, alreadyAvailable: true };

  const dir = await mkdtemp(join(tmpdir(), "stateaction-review-video-"));
  const output = join(dir, REVIEW_VIDEO_SLOT);
  const signal = AbortSignal.timeout(DEADLINE_MS);
  try {
    const raw = await deps.client.send(
      new GetObjectCommand({ Bucket: deps.bucket, Key: source.source_key }),
      { abortSignal: signal },
    );
    if (
      !(raw.Body instanceof Readable) ||
      String(raw.ContentLength) !== source.source_size
    ) {
      if (raw.Body instanceof Readable) raw.Body.destroy();
      throw new Error("Admitted source size does not match storage");
    }

    const child = spawn(
      deps.python,
      [
        "-m",
        "stateaction_processing.review_video",
        JSON.stringify(source.task_input),
        source.source_sha256,
        output,
      ],
      {
        signal,
        stdio: ["pipe", "ignore", "ignore"],
        env: { PYTHONNOUSERSITE: "1" },
      },
    );
    try {
      const [[code]] = await Promise.all([
        once(child, "close"),
        pipeline(raw.Body, child.stdin, { signal }),
      ]);
      if (code !== 0) throw new Error("Clip verification failed");
    } catch {
      child.kill();
      throw new Error("CPU clip verification failed for the admitted source");
    }

    const { size } = await stat(output);
    if (size < 1 || size > REVIEW_VIDEO_MAX_BYTES)
      throw new Error("Clip video exceeds its byte limit");
    const digest = createHash("sha256");
    for await (const bytes of createReadStream(output, { signal }))
      digest.update(bytes);
    const sha256 = digest.digest("hex");
    const key = `review-clip-video/${jobId}/${sha256}.mp4`;
    await deps.client.send(
      new PutObjectCommand({
        Bucket: deps.bucket,
        Key: key,
        Body: createReadStream(output),
        ContentLength: size,
        ContentType: "video/mp4",
      }),
      { abortSignal: signal },
    );
    const stored = await s3ObjectHasher(
      { bucket: deps.bucket },
      { client: deps.client },
    ).hash(key, size, DEADLINE_MS);
    if (stored.sha256 !== sha256)
      throw new Error("Stored clip video failed digest verification");

    const { rowCount } = await deps.pool.query(
      `INSERT INTO review_clip_video_backfills
         (job_id, clip_id, result_manifest_sha256, clip_plan_sha256, source_sha256, sha256, size_bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (job_id) DO NOTHING`,
      [
        jobId,
        source.clip_id,
        source.manifest_sha256,
        source.plan_sha256,
        source.source_sha256,
        sha256,
        size,
      ],
    );
    if (!rowCount) {
      const {
        rows: [published],
      } = await deps.pool.query<{ sha256: string }>(
        "SELECT sha256 FROM review_clip_video_backfills WHERE job_id = $1",
        [jobId],
      );
      if (published?.sha256 !== sha256)
        throw new Error(
          "A different verified clip video was already published for this result",
        );
    }
    return { jobId, sha256, alreadyAvailable: !rowCount };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
