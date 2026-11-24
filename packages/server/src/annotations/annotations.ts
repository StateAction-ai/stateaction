import type pg from "pg";
import {
  contractMaxBytes,
  sha256Hex,
  validateBytes,
  validateValue,
  type DagRunV1,
  type RecordingAnnotations,
  type Producer,
  type Stage,
} from "@stateaction/contracts";
import {
  ObjectTooLargeError,
  type ObjectReader,
} from "../admission/recordings.js";
import { ObjectReadUnavailableError } from "../admission/object-reader.js";
import {
  getDagRun,
  getDagRunWithLineage,
  type DagRunWithLineage,
} from "../jobs/stages.js";
import { TransportError } from "../transport/errors.js";
import { formatBytes, recordingTitle } from "../pipeline/model.js";

/**
 * SA-98: the annotations document of one recording, read from the recording's
 * ACCEPTED job (`recordings.current_job_id`, state succeeded). The three stage
 * outputs are fixed job output slots (`segments.json`, `captions.json`,
 * `hand-presence.json`); each is read server-side through a bounded reader
 * (never more than its published contract byte bound), validated against its
 * own contract and checked against the job and recording it was read for. A
 * stage that wrote no file contributes `null`; the recipe run (`dag_run`)
 * says why, and so does a stage whose run did not succeed even if it left a
 * file. A file that exists but cannot be read or validated is an error,
 * never an empty result.
 */

export const ANNOTATIONS_SCHEMA = "stateaction.recording-annotations.v1";
export const ANNOTATIONS_CONTRACT = "http.recording-annotations.v1";

export type RecordingAnnotationsDocument = RecordingAnnotations;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PARTS = [
  {
    key: "segments",
    stage: "segment",
    slot: "segments.json",
    role: "segments_json",
    contract: "artifacts.segments.v1",
    importedContract: "artifacts.segments.v2",
  },
  {
    key: "captions",
    stage: "caption",
    slot: "captions.json",
    role: "captions_json",
    contract: "artifacts.captions.v1",
    importedContract: "artifacts.captions.v2",
  },
  {
    key: "hand_presence",
    stage: "hand_pose",
    slot: "hand-presence.json",
    role: "hand_presence_json",
    contract: "artifacts.hand-presence.v1",
    importedContract: "artifacts.hand-presence.v2",
  },
] as const;

export type AnnotationDeps = {
  pool: pg.Pool;
  reader: ObjectReader;
};

type Accepted = {
  job_id: string;
  recording_id: string;
  kind: string;
  derived: boolean;
  source_manifest_sha256: string;
};

/** The recording's accepted job, or null (unknown, deleted, not staff or not accepted). */
async function acceptedJob(
  pool: Pick<pg.Pool, "query">,
  staffUserId: string,
  recordingId: string,
  viewJobId?: string,
): Promise<Accepted | null> {
  if (!UUID.test(recordingId) || (viewJobId && !UUID.test(viewJobId)))
    return null;
  const { rows } = await pool.query<Accepted>(
    `SELECT j.id AS job_id, rec.id AS recording_id, j.kind,
              (j.derived_from_job_id IS NOT NULL) AS derived, j.source_manifest_sha256
     FROM recordings rec
     JOIN jobs j ON j.id = coalesce($3::uuid, recording_selected_job(rec.id), rec.current_job_id) AND j.recording_id = rec.id
       AND j.state = 'succeeded' AND j.kind <> 'clip_plan'
     WHERE rec.id = $2 AND rec.deleted_at IS NULL
       AND catalog_has_role($1, 'staff')`,
    [staffUserId, recordingId, viewJobId ?? null],
  );
  return rows[0] ?? null;
}

async function readPart(
  deps: AnnotationDeps,
  part: (typeof PARTS)[number],
  file: {
    object_key: string;
    size_bytes: string;
    sha256: string;
    producer_job_id: string;
  },
  job: Pick<Accepted, "recording_id" | "source_manifest_sha256"> &
    Partial<Pick<Accepted, "kind">>,
): Promise<unknown> {
  const contract =
    job.kind === "cached_import" ? part.importedContract : part.contract;
  const max = contractMaxBytes(contract);
  if (BigInt(file.size_bytes) > BigInt(max))
    throw new TransportError(
      "conflict",
      `${part.slot} exceeds the ${max} byte read limit`,
    );
  let bytes: Uint8Array;
  try {
    bytes = await deps.reader.read(file.object_key, max);
  } catch (error) {
    if (error instanceof ObjectTooLargeError)
      throw new TransportError(
        "conflict",
        `${part.slot} exceeds the ${max} byte read limit`,
      );
    if (error instanceof ObjectReadUnavailableError) {
      // Cause for the operator (status or timeout text only; never the key or a URL).
      console.error(
        "[annotations] storage read failed:",
        part.slot,
        error.status ?? "",
        error.message.slice(0, 120),
      );
      throw new TransportError(
        "provider_unavailable",
        `${part.slot} could not be read from storage`,
        { cause: error },
      );
    }
    throw error;
  }
  if (
    sha256Hex(bytes) !== file.sha256 ||
    String(bytes.byteLength) !== file.size_bytes
  )
    throw new TransportError(
      "conflict",
      `${part.slot} does not match the stored file digest`,
    );
  const result = validateBytes(contract, bytes);
  if (!result.valid)
    throw new TransportError(
      "conflict",
      `${part.slot} is not a valid ${contract} document (${result.code})`,
    );
  const doc = result.value as {
    job_id?: unknown;
    recording_id?: unknown;
    source_manifest_sha256?: unknown;
  };
  if (
    doc.job_id !== file.producer_job_id ||
    doc.recording_id !== job.recording_id ||
    doc.source_manifest_sha256 !== job.source_manifest_sha256
  )
    throw new TransportError(
      "conflict",
      `${part.slot} belongs to a different job or recording`,
    );
  return result.value;
}

async function annotationFiles(pool: AnnotationDeps["pool"], jobId: string) {
  const { rows: files } = await pool.query<{
    slot: string;
    object_key: string | null;
    size_bytes: string | null;
    stage_not_succeeded: boolean;
    sha256: string | null;
    producer_job_id: string | null;
  }>(
    `SELECT s.slot, f.object_key, f.size_bytes::text, f.sha256, coalesce(c.original_job_id, f.job_id) AS producer_job_id,
            (r.state IS NOT NULL AND r.state <> 'succeeded') AS stage_not_succeeded
     FROM job_output_slots s
     LEFT JOIN job_effective_stage_runs r ON r.job_id = s.job_id AND r.stage = CASE s.slot
       WHEN 'segments.json' THEN 'segment'
       WHEN 'captions.json' THEN 'caption'
       ELSE 'hand_pose' END
     LEFT JOIN files f ON f.id = s.file_id AND f.job_id = s.job_id
       AND f.purpose = 'output' AND f.state IN ('completed', 'verified')
       AND f.role = CASE s.slot
         WHEN 'segments.json' THEN 'segments_json'
         WHEN 'captions.json' THEN 'captions_json'
         WHEN 'hand-presence.json' THEN 'hand_presence_json' END
     LEFT JOIN job_rerun_copies c ON c.file_id = f.id AND c.job_id = f.job_id AND c.sha256 = f.sha256
     WHERE s.job_id = $1 AND s.slot = ANY($2::text[])`,
    [jobId, PARTS.map((p) => p.slot)],
  );
  return new Map(files.map((f) => [f.slot, f]));
}

/** Read provenance for the already-authorized exact run, including historical jobs. */
export async function loadRecipeProducers(
  deps: AnnotationDeps,
  run: Pick<DagRunV1, "jobId" | "recordingId" | "stages">,
  sourceSha256: string,
): Promise<Partial<Record<Stage, Producer | "unavailable">>> {
  const stages = run.stages.filter((node) => node.state === "succeeded");
  if (!stages.length) return {};
  const files = await annotationFiles(deps.pool, run.jobId);
  const job = {
    recording_id: run.recordingId,
    source_manifest_sha256: sourceSha256,
  };
  const producers: Partial<Record<Stage, Producer | "unavailable">> = {};
  for (const node of stages) {
    const part = PARTS.find((item) => item.stage === node.stage);
    if (!part) continue;
    const file = files.get(part.slot);
    if (!file || file.stage_not_succeeded) continue;
    try {
      if (
        file.object_key === null ||
        file.size_bytes === null ||
        file.sha256 === null ||
        file.producer_job_id === null
      ) {
        producers[node.stage] = "unavailable";
        continue;
      }
      const { producer } = (await readPart(
        deps,
        part,
        {
          object_key: file.object_key,
          size_bytes: file.size_bytes,
          sha256: file.sha256,
          producer_job_id: file.producer_job_id,
        },
        job,
      )) as { producer: Producer };
      producers[node.stage] =
        file.producer_job_id !== run.jobId ||
        `${producer.module_id}@${producer.module_version}` === node.module
          ? producer
          : "unavailable";
    } catch {
      producers[node.stage] = "unavailable";
    }
  }
  return producers;
}

/**
 * The annotations of a recording's accepted job; null when the recording does
 * not exist, is not visible to staff, or has no accepted job (the same answer
 * for each, so existence is not disclosed).
 */
export async function loadRecordingAnnotations(
  deps: AnnotationDeps,
  staffUserId: string,
  recordingId: string,
  viewJobId?: string,
): Promise<RecordingAnnotationsDocument | null> {
  const job = await acceptedJob(deps.pool, staffUserId, recordingId, viewJobId);
  if (!job) return null;
  const bySlot = await annotationFiles(deps.pool, job.job_id);
  const parts: Record<string, unknown> = {};
  const producers: Extract<
    RecordingAnnotationsDocument,
    { schema: "stateaction.recording-annotations.v3" }
  >["producer_jobs"] = {
    segments: null,
    captions: null,
    hand_presence: null,
  };
  for (const part of PARTS) {
    const file = bySlot.get(part.slot);
    // A file left by a stage whose run did not succeed (for example a receipt the server rejected)
    // is not that stage's result: it contributes null and `dag_run` says why (SA-100).
    if (file?.stage_not_succeeded) {
      parts[part.key] = null;
      continue;
    }
    if (file && (file.object_key === null || file.size_bytes === null))
      // The slot exists but its file is not a usable output: that is a failure, not "no result".
      throw new TransportError(
        "conflict",
        `${part.slot} is reserved but its file is not usable`,
      );
    producers[part.key] = file?.producer_job_id ?? null;
    parts[part.key] =
      file &&
      file.object_key !== null &&
      file.size_bytes !== null &&
      file.sha256 &&
      file.producer_job_id
        ? await readPart(
            deps,
            part,
            {
              object_key: file.object_key,
              size_bytes: file.size_bytes,
              sha256: file.sha256,
              producer_job_id: file.producer_job_id,
            },
            job,
          )
        : null;
  }
  const imported = job.kind === "cached_import";
  let dagRun: DagRunV1 | DagRunWithLineage | null = null;
  try {
    if (!imported)
      dagRun = await (job.derived ? getDagRunWithLineage : getDagRun)(
        { pool: deps.pool },
        job.job_id,
      );
  } catch (error) {
    // A job without a recipe has no recipe run; anything else is a real failure.
    if (!(error instanceof TransportError && error.code === "not_found"))
      throw error;
  }
  const document = {
    schema: job.derived
      ? "stateaction.recording-annotations.v3"
      : imported
        ? "stateaction.recording-annotations.v2"
        : ANNOTATIONS_SCHEMA,
    ...(job.derived ? { producer_jobs: producers } : {}),
    recording_id: job.recording_id,
    job_id: job.job_id,
    ...(imported ? { source: "imported" } : {}),
    ...parts,
    dag_run: dagRun,
  } as RecordingAnnotationsDocument;
  const valid = validateValue(
    job.derived
      ? "http.recording-annotations.v3"
      : imported
        ? "http.recording-annotations.v2"
        : ANNOTATIONS_CONTRACT,
    document,
  );
  if (!valid.valid)
    throw new TransportError(
      "conflict",
      `The annotations of this recording are inconsistent (${valid.code})`,
    );
  return document;
}

export type ReviewRecordingRow = {
  recordingId: string;
  title: string;
  source?: "imported";
  collector: string;
  sourceSize: string | null;
};

/**
 * Recordings staff can open in Review: the accepted job produced at least one
 * annotation document, newest first (bounded).
 */
export async function listReviewRecordings(
  pool: Pick<pg.Pool, "query">,
  staffUserId: string,
  limit = 100,
): Promise<ReviewRecordingRow[]> {
  const { rows } = await pool.query<{
    id: string;
    started_at: Date;
    import_title: string | null;
    collector: string;
    size: string | null;
  }>(
    `SELECT rec.id, rec.started_at, i.evidence -> 'attribution' ->> 'title' AS import_title, u.name AS collector,
       (SELECT coalesce(sum(f.size_bytes) FILTER (WHERE f.role = 'source_mcap'),
         sum(f.size_bytes))::text FROM files f
        WHERE f.recording_id = rec.id AND f.purpose = 'source'
          AND f.state NOT IN ('cancelled', 'failed', 'expired')) AS size
     FROM recordings rec
     JOIN "user" u ON u.id = rec.owner_user_id
     JOIN jobs j ON j.id = coalesce(recording_selected_job(rec.id), rec.current_job_id) AND j.recording_id = rec.id
       AND j.state = 'succeeded' AND j.kind <> 'clip_plan'
     LEFT JOIN cached_processing_imports i ON i.job_id = j.id
     WHERE rec.deleted_at IS NULL AND catalog_has_role($1, 'staff')
       AND EXISTS (
         SELECT 1 FROM job_output_slots s
         JOIN files f ON f.id = s.file_id AND f.job_id = s.job_id
           AND f.purpose = 'output' AND f.state IN ('completed', 'verified')
         WHERE s.job_id = j.id AND s.slot = ANY($2::text[]))
     ORDER BY rec.created_at DESC, rec.id DESC LIMIT $3`,
    [staffUserId, PARTS.map((p) => p.slot), limit],
  );
  return rows.map((r) => ({
    recordingId: r.id,
    title: r.import_title ?? recordingTitle(r.started_at),
    ...(r.import_title ? { source: "imported" as const } : {}),
    collector: r.collector,
    sourceSize: formatBytes(r.size === null ? null : Number(r.size)),
  }));
}

export type ReviewExtras = {
  title: string;
  /** The accepted job has a completed recording.mp4 (the review video). */
  hasVideo: boolean;
  /** Clips of the accepted job, for the Hand pose tab. */
  clips: { clipId: string; startNs: string; endNs: string }[];
};

/** Non-annotation facts the review page needs for the same accepted job. */
export async function loadReviewExtras(
  pool: Pick<pg.Pool, "query">,
  staffUserId: string,
  recordingId: string,
  /** The job the annotations were read from: extras of any other job are refused. */
  jobId: string,
): Promise<ReviewExtras | null> {
  const job = await acceptedJob(pool, staffUserId, recordingId, jobId);
  if (!job || job.job_id !== jobId) return null;
  const rec = (
    await pool.query<{
      started_at: Date;
      has_video: boolean;
      import_title: string | null;
    }>(
      `SELECT rec.started_at, i.evidence -> 'attribution' ->> 'title' AS import_title,
              EXISTS (
                SELECT 1 FROM job_output_slots s
                JOIN files f ON f.id = s.file_id AND f.job_id = s.job_id
                  AND f.purpose = 'output' AND f.role = 'recording_mp4'
                  AND f.state IN ('completed', 'verified')
                WHERE s.job_id = coalesce(p.plan_job_id, $2) AND s.slot = 'recording.mp4') AS has_video
       FROM recordings rec
       LEFT JOIN jobs j ON j.id = $2 AND j.recording_id = rec.id
       LEFT JOIN review_clips c ON c.id = j.clip_id
       LEFT JOIN clip_plans p ON p.recording_id = c.recording_id AND p.version = c.plan_version
       LEFT JOIN cached_processing_imports i ON i.job_id = rec.current_job_id WHERE rec.id = $1`,
      [job.recording_id, job.job_id],
    )
  ).rows[0]!;
  const clips = (
    await pool.query<{ id: string; s: string; e: string }>(
      `SELECT id, source_start_ns::text AS s, source_end_ns::text AS e
       FROM clips WHERE job_id = $1 ORDER BY ordinal LIMIT 5000`,
      [job.job_id],
    )
  ).rows;
  return {
    title: rec.import_title ?? recordingTitle(rec.started_at),
    hasVideo: rec.has_video,
    clips: clips.map((c) => ({ clipId: c.id, startNs: c.s, endNs: c.e })),
  };
}
