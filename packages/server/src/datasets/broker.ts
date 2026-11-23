import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { uuid, type Queryable } from "../catalog/catalog.js";
import { CatalogError, toCatalogError } from "../catalog/errors.js";
import { memberGate } from "./queries.js";
import type { ReadGrantView, ReadRole } from "./types.js";

/**
 * Server-issued read broker (SA-35). A viewer or thumbnail URL is minted only
 * after the CURRENT rows authorize it, and only for the two derived output
 * roles. Raw MCAP, source files, recorder metadata, other derived artifacts
 * and files of an unaccepted or superseded job have no path through here: the
 * object key is read from the clip's own thumbnail/viewer file slot, which the
 * database constrains to a completed output of the clip's job with that role.
 *
 * A presigned URL already issued cannot be recalled before it expires, so the
 * TTL is short (default and hard maximum 60 s) and a response is never
 * cacheable. Revoking a grant, evidence, membership or approval stops NEW
 * URLs on the next request; it does not shorten a URL already handed out.
 * The browser-side viewer trust boundary (credential-free allowed-origin fetch
 * of a bounded RRD) is SA-38's and independent of this decision.
 */
export const READ_TTL_SECONDS = 60;
export const MAX_READ_TTL_SECONDS = 60;
/** Bounds mirror what the consumers accept (SA-38: 128 MiB RRD). */
export const READ_LIMITS: Readonly<Record<ReadRole, number>> = {
  thumbnail_jpeg: 5 * 1024 * 1024,
  viewer_rrd: 128 * 1024 * 1024,
};
export const READ_CONTENT_TYPES: Readonly<
  Record<ReadRole, "image/jpeg" | "application/octet-stream">
> = {
  thumbnail_jpeg: "image/jpeg",
  viewer_rrd: "application/octet-stream",
};
const SLOT: Record<ReadRole, string> = {
  thumbnail_jpeg: "thumbnail_file_id",
  viewer_rrd: "viewer_rrd_file_id",
};

/**
 * SA-98: the staff-only review video. `recording_mp4` is the full-recording
 * `recording.mp4` of the recording's ACCEPTED job (a recording-level output,
 * not a clip file), served as video/mp4 with the same 60 s TTL. Its size
 * limit is configurable (STATEACTION_RECORDING_MP4_MAX_BYTES, default 8 GiB);
 * a file above it is refused, never truncated.
 */
export type RecordingReadRole = "recording_mp4";
export const RECORDING_READ_ROLES: readonly RecordingReadRole[] = [
  "recording_mp4",
];
export const RECORDING_MP4_DEFAULT_MAX_BYTES = 8 * 1024 * 1024 * 1024;
export const RECORDING_MP4_CONTENT_TYPE = "video/mp4";

/** The configured recording_mp4 limit; an invalid setting fails closed (throws). */
export function recordingMp4MaxBytes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.STATEACTION_RECORDING_MP4_MAX_BYTES;
  if (raw === undefined || raw === "") return RECORDING_MP4_DEFAULT_MAX_BYTES;
  if (!/^[1-9][0-9]{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new RangeError(
      "STATEACTION_RECORDING_MP4_MAX_BYTES must be a positive integer byte count",
    );
  return Number(raw);
}

export type RecordingReadView = {
  url: string;
  role: RecordingReadRole;
  contentType: typeof RECORDING_MP4_CONTENT_TYPE;
  sizeBytes: string;
  expiresAt: string;
  ttlSeconds: number;
};

/** Injected storage presigner; credentials stay inside the server process. */
export interface ReadSigner {
  presignRead(request: {
    key: string;
    expiresInSeconds: number;
    contentType: string;
  }): Promise<string>;
}

/**
 * Production signer: the same S3-compatible client family as uploads
 * (SeaweedFS locally, R2 hosted), configured with the origin clients reach.
 */
export class S3ReadSigner implements ReadSigner {
  constructor(
    private readonly signing: S3Client,
    private readonly bucket: string,
  ) {}
  presignRead(request: {
    key: string;
    expiresInSeconds: number;
    contentType: string;
  }): Promise<string> {
    return getSignedUrl(
      this.signing,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: request.key,
        ResponseContentType: request.contentType,
        ResponseContentDisposition: "inline",
        ResponseCacheControl: "private, no-store",
      }),
      { expiresIn: request.expiresInSeconds },
    );
  }
}

export type BrokerDeps = {
  pool: Queryable;
  signer: ReadSigner;
  ttlSeconds?: number | undefined;
  now?: () => Date;
};

/**
 * Authorizes and signs one read. `datasetId` selects the exact dataset
 * context; omitted, a customer is authorized through any dataset currently
 * granted to them that holds the clip, and staff may read any accepted clip.
 * Every failure to authorize, including a missing or ineligible file, is the
 * same "not found" so existence is not disclosed.
 */
export async function issueRead(
  deps: BrokerDeps,
  input: {
    viewerUserId: string;
    clipId: string;
    role: ReadRole;
    datasetId?: string | undefined;
  },
): Promise<ReadGrantView> {
  if (input.role !== "thumbnail_jpeg" && input.role !== "viewer_rrd")
    throw new CatalogError(
      "invalid_request",
      "role must be thumbnail_jpeg or viewer_rrd",
    );
  const ttl = deps.ttlSeconds ?? READ_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_READ_TTL_SECONDS)
    throw new CatalogError(
      "invalid_request",
      `Read TTL must be an integer 1..${MAX_READ_TTL_SECONDS} seconds`,
    );
  const clipId = uuid(input.clipId, "clipId");
  const datasetId = input.datasetId ? uuid(input.datasetId, "datasetId") : null;
  let row: { object_key: string; size_bytes: string } | undefined;
  try {
    ({
      rows: [row],
    } = await deps.pool.query<{ object_key: string; size_bytes: string }>(
      `SELECT f.object_key, f.size_bytes::text
       FROM clips c
       JOIN jobs j ON j.id = c.job_id AND j.state = 'succeeded'
       JOIN recordings rec ON rec.id = c.recording_id
         AND rec.current_job_id = c.job_id AND rec.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT r.decision FROM reviews r
         WHERE r.clip_id = c.id ORDER BY r.revision DESC LIMIT 1
       ) lr ON true
       JOIN files f ON f.id = c.${SLOT[input.role]} AND f.job_id = c.job_id
         AND f.purpose = 'output' AND f.role = $4
         AND f.state IN ('completed', 'verified')
       WHERE c.id = $2 AND (
         ($3::uuid IS NULL AND catalog_has_role($1, 'staff'))
         OR EXISTS (
           SELECT 1 FROM dataset_clips dc
           WHERE dc.clip_id = c.id AND ($3::uuid IS NULL OR dc.dataset_id = $3)
             AND ${memberGate("dc.dataset_id")}))`,
      [input.viewerUserId, clipId, datasetId, input.role],
    ));
  } catch (error) {
    throw toCatalogError(error);
  }
  if (!row) throw new CatalogError("not_found", "Clip not found");
  if (BigInt(row.size_bytes) > BigInt(READ_LIMITS[input.role]))
    throw new CatalogError("conflict", "File exceeds the read limit");
  const contentType = READ_CONTENT_TYPES[input.role];
  const url = await deps.signer.presignRead({
    key: row.object_key,
    expiresInSeconds: ttl,
    contentType,
  });
  const issuedAt = (deps.now ?? (() => new Date()))();
  return {
    url,
    role: input.role,
    contentType,
    sizeBytes: row.size_bytes,
    expiresAt: new Date(issuedAt.getTime() + ttl * 1000).toISOString(),
    ttlSeconds: ttl,
  };
}

/**
 * Authorizes and signs one `recording_mp4` read. Staff only; the object key is
 * the `recording.mp4` slot of the recording's CURRENT accepted job (state
 * succeeded), restricted to a completed or verified output with that role, so
 * a superseded, failed or unaccepted job's file, a source file and any other
 * output have no path through here. Every failure to authorize, including a
 * missing file, is the same "not found".
 */
export async function issueRecordingRead(
  deps: BrokerDeps & { maxBytes?: number | undefined },
  input: {
    viewerUserId: string;
    recordingId: string;
    role: RecordingReadRole;
  },
): Promise<RecordingReadView> {
  if (input.role !== "recording_mp4")
    throw new CatalogError("invalid_request", "role must be recording_mp4");
  const ttl = deps.ttlSeconds ?? READ_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_READ_TTL_SECONDS)
    throw new CatalogError(
      "invalid_request",
      `Read TTL must be an integer 1..${MAX_READ_TTL_SECONDS} seconds`,
    );
  const limit = deps.maxBytes ?? recordingMp4MaxBytes();
  const recordingId = uuid(input.recordingId, "recordingId");
  let row: { object_key: string; size_bytes: string } | undefined;
  try {
    ({
      rows: [row],
    } = await deps.pool.query<{ object_key: string; size_bytes: string }>(
      `SELECT f.object_key, f.size_bytes::text
       FROM recordings rec
       JOIN jobs j ON j.id = rec.current_job_id AND j.state = 'succeeded'
       JOIN job_output_slots s ON s.job_id = j.id AND s.slot = 'recording.mp4'
       JOIN files f ON f.id = s.file_id AND f.job_id = j.id
         AND f.purpose = 'output' AND f.role = 'recording_mp4'
         AND f.state IN ('completed', 'verified')
       WHERE rec.id = $2 AND rec.deleted_at IS NULL
         AND catalog_has_role($1, 'staff')`,
      [input.viewerUserId, recordingId],
    ));
  } catch (error) {
    throw toCatalogError(error);
  }
  if (!row) throw new CatalogError("not_found", "Recording video not found");
  if (BigInt(row.size_bytes) > BigInt(limit))
    throw new CatalogError("conflict", "File exceeds the read limit");
  const url = await deps.signer.presignRead({
    key: row.object_key,
    expiresInSeconds: ttl,
    contentType: RECORDING_MP4_CONTENT_TYPE,
  });
  const issuedAt = (deps.now ?? (() => new Date()))();
  return {
    url,
    role: input.role,
    contentType: RECORDING_MP4_CONTENT_TYPE,
    sizeBytes: row.size_bytes,
    expiresAt: new Date(issuedAt.getTime() + ttl * 1000).toISOString(),
    ttlSeconds: ttl,
  };
}
