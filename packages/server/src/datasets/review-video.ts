import { uuid } from "../catalog/catalog.js";
import { CatalogError, toCatalogError } from "../catalog/errors.js";
import {
  MAX_READ_TTL_SECONDS,
  READ_TTL_SECONDS,
  RECORDING_MP4_CONTENT_TYPE,
  recordingMp4MaxBytes,
  type BrokerDeps,
} from "./broker.js";
import { REVIEW_MEMBERS, SELECTED_REVIEW_CLIPS } from "./review-scope.js";
import { verifiedReviewVideoSql } from "./review-playable-media.js";

type VideoRow = { object_key: string; size_bytes: string };

/** Resolve the exact shared result and its verified media in one database snapshot. */
export async function issueReviewClipVideo(
  deps: BrokerDeps & { maxBytes?: number },
  input: {
    viewerUserId: string;
    clipId: string;
    datasetId: string;
    expectedSelection?: {
      jobId: string;
      resultManifestSha256: string;
      selectionRevision: number;
    };
  },
) {
  const ttl = deps.ttlSeconds ?? READ_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_READ_TTL_SECONDS)
    throw new CatalogError("invalid_request", "Invalid video read TTL");

  const clipId = uuid(input.clipId, "clipId");
  const datasetId = uuid(input.datasetId, "datasetId");
  const expected = input.expectedSelection;
  let file: VideoRow | undefined;
  try {
    ({
      rows: [file],
    } = await deps.pool.query<VideoRow>(
      `WITH selected AS (${SELECTED_REVIEW_CLIPS} WHERE c.id = $3),
         members AS (${REVIEW_MEMBERS})
       SELECT video.object_key, video.size_bytes::text
       FROM members m
       JOIN LATERAL (${verifiedReviewVideoSql("m")}) video ON true
       WHERE ($4::uuid IS NULL OR (
         m.job_id = $4 AND m.manifest = $5 AND m.selection_revision = $6::integer
       ))`,
      [
        input.viewerUserId,
        datasetId,
        clipId,
        expected?.jobId ?? null,
        expected?.resultManifestSha256 ?? null,
        expected?.selectionRevision ?? null,
      ],
    ));
  } catch (error) {
    throw toCatalogError(error);
  }
  if (!file || BigInt(file.size_bytes) <= 0n)
    throw new CatalogError("not_found", "Clip video not found");
  if (BigInt(file.size_bytes) > BigInt(deps.maxBytes ?? recordingMp4MaxBytes()))
    throw new CatalogError("conflict", "File exceeds the read limit");

  const contentType = RECORDING_MP4_CONTENT_TYPE;
  const url = await deps.signer.presignRead({
    key: file.object_key,
    expiresInSeconds: ttl,
    contentType,
  });
  return {
    url,
    role: "clip_mp4" as const,
    contentType,
    sizeBytes: file.size_bytes,
    expiresAt: new Date(
      (deps.now?.() ?? new Date()).getTime() + ttl * 1000,
    ).toISOString(),
    ttlSeconds: ttl,
  };
}
