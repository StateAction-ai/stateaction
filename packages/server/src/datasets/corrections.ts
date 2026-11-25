import {
  inTransaction,
  requireRole,
  TS,
  uuid,
  type Queryable,
  type Tx,
} from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";
import {
  loadRecordingAnnotations,
  type AnnotationDeps,
} from "../annotations/annotations.js";
import {
  digest,
  lockStaffReview,
  requireSelectedResult,
  resultParams,
  revision,
  validateReviewResult,
  type ReviewResult,
} from "./review-result.js";

export type CaptionCorrectionCommandV2 = ReviewResult & {
  correctionId: string;
  segmentsSha256: string;
  expectedRevision: number;
  expectedMarkRevision: number;
} & (
    | { action: "edit"; text: string }
    | { action: "omit" }
    | { action: "undo" }
  );

export type CaptionCorrection = {
  correctionId: string;
  segmentId: string;
  revision: number;
  markRevision: number;
  text: string | null;
  notNeeded: boolean;
  undoRevision: number | null;
  reviewerName: string;
  createdAt: string;
};

type CaptionSegmentInput = ReviewResult & {
  clipId: string;
  recordingId: string;
  reviewerUserId: string;
  segmentId: string;
  segmentsSha256: string;
};
export type CaptionSegmentSource = (
  input: CaptionSegmentInput,
) => Promise<{ originalText: string | null } | null>;

/** Read the acceptance index, with verified storage-backed reads for older results. */
export function storedCaptionSegments(
  deps: AnnotationDeps,
): CaptionSegmentSource {
  return async (input) => {
    const indexed = (
      await deps.pool.query<{
        segment_id: string | null;
        original_text: string | null;
      }>(
        "SELECT c.segment_id, c.original_text FROM review_result_search r " +
          "LEFT JOIN review_caption_search c ON c.job_id = r.job_id AND c.segment_id = $4 " +
          "WHERE r.job_id = $1 AND r.result_manifest_sha256 = $2 AND r.segments_sha256 = $3",
        [
          input.jobId,
          input.resultManifestSha256,
          input.segmentsSha256,
          input.segmentId,
        ],
      )
    ).rows[0];
    if (indexed)
      return indexed.segment_id
        ? { originalText: indexed.original_text }
        : null;

    const doc = await loadRecordingAnnotations(
      deps,
      input.reviewerUserId,
      input.recordingId,
      input.jobId,
    );
    if (
      !doc?.segments?.rows.some(
        (row) => row.segment_id === input.segmentId && row.status === "ok",
      )
    )
      return null;
    if (doc.captions && doc.captions.segments_sha256 !== input.segmentsSha256)
      throw new CatalogError(
        "conflict",
        "The caption document has a different segment digest",
      );
    const row = doc.captions?.rows.find(
      (caption) => caption.segment_id === input.segmentId,
    );
    return { originalText: row?.status === "complete" ? row.text : null };
  };
}

type CorrectionRow = {
  id: string;
  clip_id: string;
  job_id: string;
  result_manifest_sha256: string;
  selection_revision: number;
  segments_sha256: string;
  segment_id: string;
  revision: number;
  mark_revision: number;
  text: string | null;
  not_needed: boolean;
  undo_revision: number | null;
  reviewer_user_id: string;
  reviewer_name: string;
  at: string;
};
type MarkRow = {
  revision: number;
  verdict: "good" | "issue";
  issue_type: "boundary" | "caption" | "hand_pose" | null;
  note: string | null;
};

const COLUMNS =
  "c.*, m.revision AS mark_revision, u.name AS reviewer_name, " +
  TS.replace("%s", "c.created_at") +
  " AS at";
const FROM =
  ' FROM caption_corrections c JOIN segment_marks m ON m.id = c.mark_id JOIN "user" u ON u.id = c.reviewer_user_id';
const PIN =
  "c.clip_id = $1 AND c.job_id = $2 AND c.result_manifest_sha256 = $3 AND c.selection_revision = $4";

function record(row: CorrectionRow): CaptionCorrection {
  return {
    correctionId: row.id,
    segmentId: row.segment_id,
    revision: row.revision,
    markRevision: row.mark_revision,
    text: row.text,
    notNeeded: row.not_needed,
    undoRevision: row.undo_revision,
    reviewerName: row.reviewer_name,
    createdAt: row.at,
  };
}

const conflict = (message: string) => new CatalogError("conflict", message);

async function acceptedSegments(
  db: Queryable | Tx,
  clipId: string,
  result: CaptionCorrectionCommandV2,
) {
  const match = (
    await db.query<{ recording_id: string; file_id: string }>(
      "SELECT j.recording_id, f.id AS file_id FROM jobs j " +
        "JOIN job_output_slots s ON s.job_id = j.id AND s.slot = 'segments.json' " +
        "JOIN files f ON f.id = s.file_id AND f.job_id = j.id AND f.role = 'segments_json' " +
        "AND f.purpose = 'output' AND f.state IN ('completed','verified') " +
        "WHERE j.id = $1 AND j.clip_id = $2 AND j.state = 'succeeded' AND j.segment_count IS NOT NULL " +
        "AND j.result_manifest_sha256 = $3 AND f.sha256 = $4",
      [
        result.jobId,
        clipId,
        result.resultManifestSha256,
        result.segmentsSha256,
      ],
    )
  ).rows[0];
  if (!match) throw conflict("Accepted segments changed");
  return match;
}

export async function commitCaptionCorrection(
  pool: Queryable,
  source: CaptionSegmentSource,
  {
    clipId,
    segmentId,
    reviewerUserId,
    command: c,
  }: {
    clipId: string;
    segmentId: string;
    reviewerUserId: string;
    command: CaptionCorrectionCommandV2;
  },
): Promise<{ correction: CaptionCorrection; replayed: boolean }> {
  uuid(clipId, "clipId");
  uuid(segmentId, "segmentId");
  uuid(c.correctionId, "correctionId");
  validateReviewResult(c);
  digest(c.segmentsSha256, "segmentsSha256");
  revision(c.expectedRevision + 1, "expectedRevision", 1);
  revision(c.expectedMarkRevision + 1, "expectedMarkRevision", 1);
  const edit = c.action === "edit" ? c.text.trim() : null;
  if (
    (edit !== null &&
      (!edit || [...edit].length > 2000 || edit.includes("\0"))) ||
    (c.action !== "edit" && c.action !== "omit" && c.action !== "undo")
  )
    throw new CatalogError(
      "invalid_request",
      "Enter changed caption text of 1 to 2000 characters or choose an action",
    );

  const priorById = async (db: Queryable | Tx) =>
    (
      await db.query<CorrectionRow>(
        "SELECT " + COLUMNS + FROM + " WHERE c.id = $1",
        [c.correctionId],
      )
    ).rows[0];
  const replay = (row: CorrectionRow) => {
    const matchesAction =
      c.action === "undo"
        ? row.undo_revision !== null
        : row.undo_revision === null &&
          row.text === edit &&
          row.not_needed === (c.action === "omit");
    if (
      !matchesAction ||
      row.clip_id !== clipId ||
      row.segment_id !== segmentId ||
      row.job_id !== c.jobId ||
      row.result_manifest_sha256 !== c.resultManifestSha256 ||
      row.selection_revision !== c.selectionRevision ||
      row.segments_sha256 !== c.segmentsSha256 ||
      row.reviewer_user_id !== reviewerUserId ||
      row.revision !== c.expectedRevision + 1 ||
      row.mark_revision !== c.expectedMarkRevision + 1
    )
      throw new CatalogError(
        "idempotency_conflict",
        "correctionId already identifies a different request",
      );
    return { correction: record(row), replayed: true };
  };

  await requireRole(pool, reviewerUserId, "staff");
  const prior = await priorById(pool);
  if (prior) return replay(prior);
  const accepted = await acceptedSegments(pool, clipId, c);
  const input = {
    ...c,
    clipId,
    segmentId,
    reviewerUserId,
    recordingId: accepted.recording_id,
  };
  const segment = await source(input);
  if (!segment)
    throw new CatalogError("not_found", "Accepted segment not found");

  try {
    return await inTransaction(pool, async (tx) => {
      await lockStaffReview(tx, reviewerUserId, clipId);
      const stored = await priorById(tx);
      if (stored) return replay(stored);
      await requireSelectedResult(tx, clipId, c);
      const { file_id } = await acceptedSegments(tx, clipId, c);
      const pin = [...resultParams(clipId, c), segmentId];
      const byRevision = (r: number) =>
        tx
          .query<CorrectionRow>(
            "SELECT " +
              COLUMNS +
              FROM +
              " WHERE " +
              PIN +
              " AND c.segment_id = $5 AND c.revision = $6",
            [...pin, r],
          )
          .then(({ rows }) => rows[0]);
      const latest = (
        await tx.query<CorrectionRow>(
          "SELECT " +
            COLUMNS +
            FROM +
            " WHERE " +
            PIN +
            " AND c.segment_id = $5 ORDER BY c.revision DESC LIMIT 1",
          pin,
        )
      ).rows[0];
      if ((latest?.revision ?? 0) !== c.expectedRevision)
        throw conflict("Stale caption correction revision");
      const mark = (
        await tx.query<MarkRow>(
          "SELECT revision, verdict, issue_type, note FROM segment_marks WHERE job_id = $1 AND segment_id = $2 ORDER BY revision DESC LIMIT 1",
          [c.jobId, segmentId],
        )
      ).rows[0];
      if ((mark?.revision ?? 0) !== c.expectedMarkRevision)
        throw conflict("Stale segment mark revision");
      let text = edit;
      let notNeeded = c.action === "omit";
      let undoRevision: number | null = null;
      let newMark: Omit<MarkRow, "revision"> = {
        verdict: "issue",
        issue_type: "caption",
        note: null,
      };

      if (c.action === "undo") {
        const active =
          latest?.undo_revision === null
            ? latest
            : latest?.undo_revision
              ? await byRevision(latest.undo_revision)
              : undefined;
        if (!active) throw conflict("There is no caption edit to undo");
        if (mark?.revision !== latest?.mark_revision)
          throw conflict(
            "The segment was marked again after the caption correction",
          );
        const prev = await byRevision(active.revision - 1);
        undoRevision = prev?.undo_revision ?? prev?.revision ?? 0;
        text = prev?.text ?? null;
        notNeeded = prev?.not_needed ?? false;
        newMark = (
          await tx.query<MarkRow>(
            "SELECT verdict, issue_type, note, revision FROM segment_marks WHERE job_id = $1 AND segment_id = $2 AND revision = $3",
            [c.jobId, segmentId, active.mark_revision - 1],
          )
        ).rows[0] ?? { verdict: "good", issue_type: null, note: null };
      } else if (
        notNeeded
          ? latest?.not_needed
          : !latest?.not_needed &&
            edit === (latest?.text ?? segment.originalText)
      ) {
        throw new CatalogError("invalid_request", "Caption is unchanged");
      }

      await tx.query(
        "INSERT INTO segment_marks (id, job_id, segments_sha256, segments_file_id, segment_id, revision, reviewer_user_id, verdict, issue_type, note) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          c.correctionId,
          c.jobId,
          c.segmentsSha256,
          file_id,
          segmentId,
          c.expectedMarkRevision + 1,
          reviewerUserId,
          newMark.verdict,
          newMark.issue_type,
          newMark.note,
        ],
      );
      await tx.query(
        "INSERT INTO caption_corrections (clip_id, job_id, result_manifest_sha256, selection_revision, segment_id, id, segments_sha256, revision, text, not_needed, undo_revision, reviewer_user_id, mark_id) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$6)",
        [
          ...pin,
          c.correctionId,
          c.segmentsSha256,
          c.expectedRevision + 1,
          text,
          notNeeded,
          undoRevision,
          reviewerUserId,
        ],
      );
      return { correction: record((await priorById(tx))!), replayed: false };
    });
  } catch (error) {
    if (error instanceof CatalogError && error.code === "conflict") {
      const stored = await priorById(pool);
      if (stored) return replay(stored);
    }
    throw error;
  }
}

/** Staff-only history for a segment in the exact result already open in Review. */
export async function getCaptionCorrectionHistory(
  pool: Queryable,
  input: ReviewResult & {
    clipId: string;
    segmentId: string;
    viewerUserId: string;
    beforeRevision?: number;
  },
): Promise<CaptionCorrection[]> {
  uuid(input.clipId, "clipId");
  uuid(input.segmentId, "segmentId");
  validateReviewResult(input);
  return (
    await pool.query<CorrectionRow>(
      "SELECT " +
        COLUMNS +
        FROM +
        " WHERE " +
        PIN +
        " AND c.segment_id = $5 AND catalog_has_role($6, 'staff') AND ($7::integer IS NULL OR c.revision < $7) " +
        "ORDER BY c.revision DESC LIMIT 50",
      [
        ...resultParams(input.clipId, input),
        input.segmentId,
        input.viewerUserId,
        input.beforeRevision ?? null,
      ],
    )
  ).rows.map(record);
}

/** For an already-authorized selected result. Only visible overrides or omissions are returned. */
export async function listEffectiveCaptionOverrides(
  pool: Pick<Queryable, "query">,
  input: ReviewResult & { clipId: string },
): Promise<{ segmentId: string; text: string | null }[]> {
  return (
    await pool.query<{ segment_id: string; text: string | null }>(
      "SELECT segment_id, text FROM (" +
        "SELECT DISTINCT ON (c.segment_id) c.segment_id, c.text, c.not_needed " +
        "FROM caption_corrections c WHERE " +
        PIN +
        " ORDER BY c.segment_id, c.revision DESC" +
        ") effective WHERE text IS NOT NULL OR not_needed",
      [...resultParams(input.clipId, input)],
    )
  ).rows.map(({ segment_id, text }) => ({ segmentId: segment_id, text }));
}
