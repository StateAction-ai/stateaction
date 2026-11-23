import { sha256Hex } from "@stateaction/contracts";
import type {
  SegmentMark,
  SegmentMarkCommand,
  SegmentMarks,
} from "@stateaction/contracts";
import {
  inTransaction,
  requireRole,
  TS,
  uuid,
  type Queryable,
  type Tx,
} from "../catalog/catalog.js";
import { CatalogError, toCatalogError } from "../catalog/errors.js";
import type { ObjectReader } from "../admission/recordings.js";

/**
 * Staff Good/Issue marks per segment (SA-99, migration 012). Marks are
 * append-only revisions pinned to the recording's current accepted job and the
 * SHA-256 of its segments.json. Nothing here writes model output.
 *
 * Whether a segment id belongs to that job is decided from the stored
 * segments.json, read with a hard byte bound and accepted only when its bytes
 * hash to the accepted digest (the ids exist only in storage). The database
 * trigger independently pins job, digest, staff role and revision.
 */
export const SEGMENTS_MAX_BYTES = 32 * 1024 ** 2;
const ts = (column: string) => TS.replace("%s", column);
const MAX_NOTE = 2000;

/** Resolves the segment ids of one accepted segments.json (digest-verified). */
export type SegmentIdSource = (input: {
  jobId: string;
  segmentsSha256: string;
}) => Promise<ReadonlySet<string>>;

/** Storage-backed source with a small digest-keyed cache (content-addressed). */
export function storedSegmentIds(
  pool: Queryable,
  reader: ObjectReader,
): SegmentIdSource {
  const cache = new Map<string, ReadonlySet<string>>();
  return async ({ jobId, segmentsSha256 }) => {
    const hit = cache.get(`${jobId}:${segmentsSha256}`);
    if (hit) return hit;
    const { rows } = await pool.query<{ object_key: string; size: string }>(
      `SELECT object_key, size_bytes::text AS size FROM files
       WHERE job_id = $1 AND role = 'segments_json' AND purpose = 'output'
         AND sha256 = $2 AND state IN ('completed', 'verified')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [jobId, segmentsSha256],
    );
    const file = rows[0];
    if (!file) throw new CatalogError("conflict", "Segments file not found");
    let bytes: Uint8Array;
    try {
      bytes = await reader.read(file.object_key, SEGMENTS_MAX_BYTES);
    } catch {
      // Too large, missing or a storage failure: the pin cannot be verified.
      throw new CatalogError("conflict", "Segments are unreadable");
    }
    if (
      bytes.byteLength !== Number(file.size) ||
      sha256Hex(bytes) !== segmentsSha256
    )
      throw new CatalogError("conflict", "Segments file failed verification");
    const ids = new Set<string>();
    try {
      const doc = JSON.parse(new TextDecoder().decode(bytes)) as {
        rows?: { segment_id?: unknown }[];
      };
      if (!Array.isArray(doc.rows)) throw new Error("rows");
      for (const row of doc.rows)
        if (typeof row?.segment_id === "string") ids.add(row.segment_id);
    } catch {
      throw new CatalogError("conflict", "Segments file failed verification");
    }
    if (cache.size >= 8) cache.delete(cache.keys().next().value as string);
    cache.set(`${jobId}:${segmentsSha256}`, ids);
    return ids;
  };
}

type Accepted = {
  jobId: string;
  segmentsSha256: string;
  segmentsFileId: string;
  segmentCount: number;
};

/**
 * The recording's current accepted result: current succeeded job with accepted
 * annotation counts and its completed segments.json. null = nothing to mark.
 */
async function currentAccepted(
  db: Queryable | Tx,
  recordingId: string,
): Promise<{ found: boolean; accepted: Accepted | null }> {
  const { rows } = await db.query<{
    job_id: string | null;
    segment_count: number | null;
    sha: string | null;
    file_id: string | null;
  }>(
    `SELECT j.id AS job_id, j.segment_count, f.sha256 AS sha, f.id AS file_id
     FROM recordings r
     LEFT JOIN jobs j ON j.id = r.current_job_id AND j.recording_id = r.id
       AND j.state = 'succeeded' AND j.segment_count IS NOT NULL
     LEFT JOIN LATERAL (
       SELECT x.id, x.sha256 FROM files x
       WHERE x.job_id = j.id AND x.role = 'segments_json'
         AND x.purpose = 'output' AND x.state IN ('completed', 'verified')
       ORDER BY x.created_at DESC, x.id DESC LIMIT 1) f ON true
     WHERE r.id = $1 AND r.deleted_at IS NULL`,
    [recordingId],
  );
  const row = rows[0];
  if (!row) return { found: false, accepted: null };
  return {
    found: true,
    accepted:
      row.job_id && row.sha && row.file_id
        ? {
            jobId: row.job_id,
            segmentsSha256: row.sha,
            segmentsFileId: row.file_id,
            segmentCount: row.segment_count ?? 0,
          }
        : null,
  };
}

type MarkRow = {
  id: string;
  job_id: string;
  segments_sha256: string;
  segment_id: string;
  revision: number;
  reviewer_user_id: string;
  recording_id?: string;
  verdict: "good" | "issue";
  issue_type: "boundary" | "caption" | "hand_pose" | null;
  note: string | null;
  created_at: string;
};
const COLUMNS = `id, job_id, segments_sha256, segment_id, revision, reviewer_user_id,
  verdict, issue_type, note, ${ts("created_at")} AS created_at`;

const BY_ID = `SELECT m.id, m.job_id, m.segments_sha256, m.segment_id, m.revision,
  m.reviewer_user_id, m.verdict, m.issue_type, m.note, j.recording_id,
  ${ts("m.created_at")} AS created_at
  FROM segment_marks m JOIN jobs j ON j.id = m.job_id WHERE m.id = $1`;

const record = (row: MarkRow, replayed: boolean): SegmentMark => ({
  markId: row.id,
  jobId: row.job_id,
  segmentsSha256: row.segments_sha256,
  segmentId: row.segment_id,
  revision: row.revision,
  verdict: row.verdict,
  issueType: row.issue_type,
  note: row.note,
  createdAt: row.created_at,
  replayed,
});

/**
 * Appends one mark revision. The command is checked again by the database;
 * here the pin (current accepted job and digest), the segment id and the
 * expected revision are decided with typed errors.
 */
export async function recordSegmentMark(
  pool: Queryable,
  segmentIds: SegmentIdSource,
  input: {
    recordingId: string;
    segmentId: string;
    reviewerUserId: string;
    command: SegmentMarkCommand;
  },
): Promise<SegmentMark> {
  const recordingId = uuid(input.recordingId, "recordingId");
  const segmentId = uuid(input.segmentId, "segmentId");
  const c = input.command;
  const note = c.note?.trim() ? c.note : null;
  // Code points, like the schema maxLength and Postgres length().
  if (note && [...note].length > MAX_NOTE)
    throw new CatalogError("invalid_request", "Note is too long");
  const issueType = c.verdict === "issue" ? (c.issueType ?? null) : null;
  if (c.verdict === "issue" && !issueType)
    throw new CatalogError("invalid_request", "An issue requires a type");
  if (c.verdict === "good" && c.issueType)
    throw new CatalogError("invalid_request", "Good carries no issue type");

  const replayOf = (prior: MarkRow): SegmentMark => {
    if (
      prior.recording_id !== recordingId ||
      prior.job_id !== c.jobId ||
      prior.segments_sha256 !== c.segmentsSha256 ||
      prior.segment_id !== segmentId ||
      prior.reviewer_user_id !== input.reviewerUserId ||
      prior.revision !== c.expectedRevision + 1 ||
      prior.verdict !== c.verdict ||
      prior.issue_type !== issueType ||
      prior.note !== note
    )
      throw new CatalogError(
        "idempotency_conflict",
        "markId was already used with a different request",
      );
    return record(prior, true);
  };

  try {
    await requireRole(pool, input.reviewerUserId, "staff");
    // A replayed markId returns the stored mark even after the accepted result
    // changed (the mark is immutable); a changed body is an idempotency conflict.
    const stored = (await pool.query<MarkRow>(BY_ID, [c.markId])).rows[0];
    if (stored) return replayOf(stored);
    const { found, accepted } = await currentAccepted(pool, recordingId);
    if (!found) throw new CatalogError("not_found", "Recording not found");
    if (!accepted)
      throw new CatalogError("conflict", "Recording has no accepted segments");
    if (
      accepted.jobId !== c.jobId ||
      accepted.segmentsSha256 !== c.segmentsSha256
    )
      throw new CatalogError("conflict", "Segment result identity changed");
    const ids = await segmentIds({
      jobId: accepted.jobId,
      segmentsSha256: accepted.segmentsSha256,
    });
    if (!ids.has(segmentId))
      throw new CatalogError("not_found", "Segment not found");

    const appended = inTransaction(pool, async (tx) => {
      await tx.query("SET LOCAL lock_timeout = '5s'");
      const prior = (await tx.query<MarkRow>(BY_ID, [c.markId])).rows[0];
      if (prior) return replayOf(prior);
      const latest = await tx.query<{ revision: number | null }>(
        "SELECT max(revision) AS revision FROM segment_marks WHERE job_id = $1 AND segment_id = $2",
        [c.jobId, segmentId],
      );
      if ((latest.rows[0]?.revision ?? 0) !== c.expectedRevision)
        throw new CatalogError("conflict", "Stale mark revision");
      const inserted = await tx.query<MarkRow>(
        `INSERT INTO segment_marks
           (id, job_id, segments_sha256, segments_file_id, segment_id, revision,
            reviewer_user_id, verdict, issue_type, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${COLUMNS}`,
        [
          c.markId,
          c.jobId,
          c.segmentsSha256,
          accepted.segmentsFileId,
          segmentId,
          c.expectedRevision + 1,
          input.reviewerUserId,
          c.verdict,
          issueType,
          note,
        ],
      );
      return record(inserted.rows[0]!, false);
    });
    try {
      return await appended;
    } catch (error) {
      // The same markId sent twice at once: the loser hits the revision guard or the
      // primary key (both surface as a conflict). It is a replay of the winner when the stored request matches.
      const failure = toCatalogError(error) as CatalogError;
      if (failure.code !== "conflict") throw error;
      const winner = (await pool.query<MarkRow>(BY_ID, [c.markId])).rows[0];
      if (!winner) throw error;
      return replayOf(winner);
    }
  } catch (error) {
    throw toCatalogError(error);
  }
}

/** The newest mark of each marked segment of the recording's accepted result. */
export async function getSegmentMarks(
  pool: Queryable,
  input: { viewerUserId: string; recordingId: string },
): Promise<SegmentMarks> {
  const recordingId = uuid(input.recordingId, "recordingId");
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await requireRole(tx, input.viewerUserId, "staff");
    const { found, accepted } = await currentAccepted(tx, recordingId);
    if (!found) throw new CatalogError("not_found", "Recording not found");
    const marks = accepted
      ? (
          await tx.query<MarkRow>(
            `SELECT DISTINCT ON (segment_id) ${COLUMNS}
             FROM segment_marks WHERE job_id = $1 AND segments_sha256 = $2
             ORDER BY segment_id, revision DESC`,
            [accepted.jobId, accepted.segmentsSha256],
          )
        ).rows
      : [];
    await tx.query("COMMIT");
    marks.sort((a, b) =>
      a.created_at === b.created_at
        ? a.segment_id < b.segment_id
          ? -1
          : 1
        : a.created_at < b.created_at
          ? -1
          : 1,
    );
    return {
      jobId: accepted?.jobId ?? null,
      segmentsSha256: accepted?.segmentsSha256 ?? null,
      segmentCount: accepted?.segmentCount ?? 0,
      checkedCount: marks.length,
      issueCount: marks.filter((m) => m.verdict === "issue").length,
      marks: marks.map((m) => ({
        segmentId: m.segment_id,
        revision: m.revision,
        verdict: m.verdict,
        issueType: m.issue_type,
        note: m.note,
        createdAt: m.created_at,
      })),
    };
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw toCatalogError(error);
  } finally {
    tx.release();
  }
}
