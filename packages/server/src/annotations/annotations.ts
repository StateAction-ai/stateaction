import type pg from "pg";
import {
  contractMaxBytes,
  validateBytes,
  validateValue,
  type CaptionsV1,
  type DagRunV1,
  type HandPresenceV1,
  type SegmentsV1,
} from "@stateaction/contracts";
import {
  ObjectTooLargeError,
  type ObjectReader,
} from "../admission/recordings.js";
import { ObjectReadUnavailableError } from "../admission/object-reader.js";
import { getDagRun } from "../jobs/stages.js";
import { TransportError } from "../transport/errors.js";
import { recordingTitle } from "../pipeline/model.js";

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

export type RecordingAnnotationsDocument = {
  schema: typeof ANNOTATIONS_SCHEMA;
  recording_id: string;
  job_id: string;
  segments: SegmentsV1 | null;
  captions: CaptionsV1 | null;
  hand_presence: HandPresenceV1 | null;
  dag_run: DagRunV1 | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PARTS = [
  {
    key: "segments",
    slot: "segments.json",
    role: "segments_json",
    contract: "artifacts.segments.v1",
  },
  {
    key: "captions",
    slot: "captions.json",
    role: "captions_json",
    contract: "artifacts.captions.v1",
  },
  {
    key: "hand_presence",
    slot: "hand-presence.json",
    role: "hand_presence_json",
    contract: "artifacts.hand-presence.v1",
  },
] as const;

export type AnnotationDeps = {
  pool: pg.Pool;
  reader: ObjectReader;
};

type Accepted = {
  job_id: string;
  recording_id: string;
};

/** The recording's accepted job, or null (unknown, deleted, not staff or not accepted). */
async function acceptedJob(
  pool: Pick<pg.Pool, "query">,
  staffUserId: string,
  recordingId: string,
): Promise<Accepted | null> {
  if (!UUID.test(recordingId)) return null;
  const { rows } = await pool.query<Accepted>(
    `SELECT j.id AS job_id, rec.id AS recording_id
     FROM recordings rec
     JOIN jobs j ON j.id = rec.current_job_id AND j.recording_id = rec.id
       AND j.state = 'succeeded'
     WHERE rec.id = $2 AND rec.deleted_at IS NULL
       AND catalog_has_role($1, 'staff')`,
    [staffUserId, recordingId],
  );
  return rows[0] ?? null;
}

async function readPart(
  deps: AnnotationDeps,
  part: (typeof PARTS)[number],
  file: { object_key: string; size_bytes: string },
  job: Accepted,
): Promise<unknown> {
  const max = contractMaxBytes(part.contract);
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
  const result = validateBytes(part.contract, bytes);
  if (!result.valid)
    throw new TransportError(
      "conflict",
      `${part.slot} is not a valid ${part.contract} document (${result.code})`,
    );
  const doc = result.value as { job_id?: unknown; recording_id?: unknown };
  if (doc.job_id !== job.job_id || doc.recording_id !== job.recording_id)
    throw new TransportError(
      "conflict",
      `${part.slot} belongs to a different job or recording`,
    );
  return result.value;
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
): Promise<RecordingAnnotationsDocument | null> {
  const job = await acceptedJob(deps.pool, staffUserId, recordingId);
  if (!job) return null;
  const { rows: files } = await deps.pool.query<{
    slot: string;
    object_key: string | null;
    size_bytes: string | null;
    stage_not_succeeded: boolean;
  }>(
    `SELECT s.slot, f.object_key, f.size_bytes::text,
            (r.state IS NOT NULL AND r.state <> 'succeeded') AS stage_not_succeeded
     FROM job_output_slots s
     LEFT JOIN job_stage_runs r ON r.job_id = s.job_id AND r.stage = CASE s.slot
       WHEN 'segments.json' THEN 'segment'
       WHEN 'captions.json' THEN 'caption'
       ELSE 'hand_pose' END
     LEFT JOIN files f ON f.id = s.file_id AND f.job_id = s.job_id
       AND f.purpose = 'output' AND f.state IN ('completed', 'verified')
       AND f.role = CASE s.slot
         WHEN 'segments.json' THEN 'segments_json'
         WHEN 'captions.json' THEN 'captions_json'
         WHEN 'hand-presence.json' THEN 'hand_presence_json' END
     WHERE s.job_id = $1 AND s.slot = ANY($2::text[])`,
    [job.job_id, PARTS.map((p) => p.slot)],
  );
  const bySlot = new Map(files.map((f) => [f.slot, f]));
  const parts: Record<string, unknown> = {};
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
    parts[part.key] =
      file && file.object_key !== null && file.size_bytes !== null
        ? await readPart(
            deps,
            part,
            { object_key: file.object_key, size_bytes: file.size_bytes },
            job,
          )
        : null;
  }
  let dagRun: DagRunV1 | null = null;
  try {
    dagRun = await getDagRun({ pool: deps.pool }, job.job_id);
  } catch (error) {
    // A job without a recipe has no recipe run; anything else is a real failure.
    if (!(error instanceof TransportError && error.code === "not_found"))
      throw error;
  }
  const document = {
    schema: ANNOTATIONS_SCHEMA,
    recording_id: job.recording_id,
    job_id: job.job_id,
    ...parts,
    dag_run: dagRun,
  } as RecordingAnnotationsDocument;
  const valid = validateValue(ANNOTATIONS_CONTRACT, document);
  if (!valid.valid)
    throw new TransportError(
      "conflict",
      `The annotations of this recording are inconsistent (${valid.code})`,
    );
  return document;
}

export type ReviewRecordingRow = { recordingId: string; title: string };

/**
 * Recordings staff can open in Review: the accepted job produced at least one
 * annotation document, newest first (bounded).
 */
export async function listReviewRecordings(
  pool: Pick<pg.Pool, "query">,
  staffUserId: string,
  limit = 100,
): Promise<ReviewRecordingRow[]> {
  const { rows } = await pool.query<{ id: string; started_at: Date }>(
    `SELECT rec.id, rec.started_at
     FROM recordings rec
     JOIN jobs j ON j.id = rec.current_job_id AND j.recording_id = rec.id
       AND j.state = 'succeeded'
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
    title: recordingTitle(r.started_at),
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
  const job = await acceptedJob(pool, staffUserId, recordingId);
  if (!job || job.job_id !== jobId) return null;
  const rec = (
    await pool.query<{ started_at: Date; has_video: boolean }>(
      `SELECT rec.started_at,
              EXISTS (
                SELECT 1 FROM job_output_slots s
                JOIN files f ON f.id = s.file_id AND f.job_id = s.job_id
                  AND f.purpose = 'output' AND f.role = 'recording_mp4'
                  AND f.state IN ('completed', 'verified')
                WHERE s.job_id = $2 AND s.slot = 'recording.mp4') AS has_video
       FROM recordings rec WHERE rec.id = $1`,
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
    title: recordingTitle(rec.started_at),
    hasVideo: rec.has_video,
    clips: clips.map((c) => ({ clipId: c.id, startNs: c.s, endNs: c.e })),
  };
}
