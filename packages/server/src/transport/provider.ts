import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  UploadPartCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { normalizeEtag } from "./plan.js";

export type ProviderUpload = { uploadId: string; initiatedAt: Date | null };
export type ProviderPart = {
  partNumber: number;
  etag: string;
  sizeBytes: bigint;
};

export type ProviderObject = {
  sizeBytes: bigint;
  /** Provider receipt only; never a content digest. */
  etag: string | null;
  /** x-amz-mp-parts-count when the provider reports it. */
  partsCount: number | null;
};

/** The persisted multipart upload no longer exists at the provider. */
export class ProviderUploadGone extends Error {
  constructor(message = "Provider multipart upload does not exist") {
    super(message);
    this.name = "ProviderUploadGone";
  }
}

/**
 * The only provider surface the transport service uses. Every state decision
 * is made from authoritative reads (exact-key listing, ListParts, HEAD) rather
 * than from the journal or from comparing opaque upload IDs.
 */
export interface MultipartProvider {
  /** Uploads in flight for exactly this key (exact-key filter applied). */
  listUploadsForKey(key: string): Promise<ProviderUpload[]>;
  createUpload(key: string): Promise<ProviderUpload>;
  /** Idempotent: an upload that is already gone is not an error. */
  abortUpload(key: string, uploadId: string): Promise<void>;
  /**
   * Completes with the exact ordered part list. Success may be reported by a
   * lost response, so callers verify with headObject rather than repeating.
   */
  completeUpload(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void>;
  /** HEAD of the exact key; null when the object does not exist. */
  headObject(key: string): Promise<ProviderObject | null>;
  /**
   * Streams the completed object (optionally a byte range) for the later
   * full-EOF SHA-256 verification. Completion and reconcile never call it:
   * HEAD length and ETags cannot prove content, and nothing here marks a
   * file verified.
   */
  readObject(
    key: string,
    range?: { start: bigint; endInclusive: bigint },
  ): Promise<AsyncIterable<Uint8Array>>;
  /**
   * Parts with numbers in [fromPart, toPart], fully paginated. Throws
   * ProviderUploadGone when the upload does not exist.
   */
  listParts(
    key: string,
    uploadId: string,
    fromPart: number,
    toPart: number,
  ): Promise<ProviderPart[]>;
  presignUploadPart(request: {
    key: string;
    uploadId: string;
    partNumber: number;
    lengthBytes: bigint;
    expiresInSeconds: number;
  }): Promise<string>;
}

const MAX_LIST_PAGES = 20;

function isGone(error: unknown): boolean {
  const e = error as { name?: string; Code?: string };
  return e?.name === "NoSuchUpload" || e?.Code === "NoSuchUpload";
}

/**
 * S3-compatible provider (SeaweedFS locally, Cloudflare R2 hosted). `control`
 * performs backend calls; `signing` is configured with the origin clients can
 * reach, so presigned URLs carry the right host. Credentials never leave the
 * server: only the scoped presigned PUT URL is returned.
 */
export class S3MultipartProvider implements MultipartProvider {
  constructor(
    private readonly control: S3Client,
    private readonly signing: S3Client,
    private readonly bucket: string,
    private readonly metadata: S3Client = control,
  ) {}

  async listUploadsForKey(key: string): Promise<ProviderUpload[]> {
    const found: ProviderUpload[] = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const out = await this.metadata.send(
        new ListMultipartUploadsCommand({
          Bucket: this.bucket,
          Prefix: key,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      );
      for (const u of out.Uploads ?? [])
        if (u.Key === key && u.UploadId)
          found.push({
            uploadId: u.UploadId,
            initiatedAt: u.Initiated ?? null,
          });
      if (!out.IsTruncated) return found;
      keyMarker = out.NextKeyMarker;
      uploadIdMarker = out.NextUploadIdMarker;
    }
    throw new Error("Provider upload listing did not terminate");
  }

  async createUpload(key: string): Promise<ProviderUpload> {
    const out = await this.control.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: "application/octet-stream",
      }),
    );
    if (!out.UploadId) throw new Error("Provider returned no upload ID");
    return { uploadId: out.UploadId, initiatedAt: new Date() };
  }

  async abortUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.control.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }

  async completeUpload(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void> {
    await this.control.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({
            PartNumber: p.partNumber,
            ETag: p.etag,
          })),
        },
      }),
    );
  }

  async readObject(
    key: string,
    range?: { start: bigint; endInclusive: bigint },
  ): Promise<AsyncIterable<Uint8Array>> {
    const out = await this.control.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.endInclusive}` : undefined,
      }),
    );
    if (!out.Body) throw new Error("Provider returned no object body");
    return out.Body as unknown as AsyncIterable<Uint8Array>;
  }

  async headObject(key: string): Promise<ProviderObject | null> {
    try {
      const out = await this.metadata.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (out.ContentLength === undefined)
        throw new Error("Provider HEAD returned no length");
      return {
        sizeBytes: BigInt(out.ContentLength),
        etag: out.ETag ? normalizeEtag(out.ETag) : null,
        partsCount: out.PartsCount ?? null,
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404 || (error as Error).name === "NotFound") return null;
      throw error;
    }
  }

  async listParts(
    key: string,
    uploadId: string,
    fromPart: number,
    toPart: number,
  ): Promise<ProviderPart[]> {
    const parts: ProviderPart[] = [];
    let marker = String(Math.max(0, fromPart - 1));
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      let out;
      try {
        out = await this.metadata.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
            MaxParts: 1000,
          }),
        );
      } catch (error) {
        if (isGone(error)) throw new ProviderUploadGone();
        throw error;
      }
      for (const p of out.Parts ?? []) {
        if (p.PartNumber === undefined || p.ETag === undefined) continue;
        if (p.PartNumber < fromPart || p.PartNumber > toPart) continue;
        parts.push({
          partNumber: p.PartNumber,
          etag: normalizeEtag(p.ETag),
          sizeBytes: BigInt(p.Size ?? -1),
        });
      }
      const next = out.NextPartNumberMarker;
      if (!out.IsTruncated || next === undefined) return parts;
      if (Number(next) >= toPart) return parts;
      marker = String(next);
    }
    throw new Error("Provider part listing did not terminate");
  }

  presignUploadPart(request: {
    key: string;
    uploadId: string;
    partNumber: number;
    lengthBytes: bigint;
    expiresInSeconds: number;
  }): Promise<string> {
    return getSignedUrl(
      this.signing,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: request.key,
        UploadId: request.uploadId,
        PartNumber: request.partNumber,
        ContentLength: Number(request.lengthBytes),
      }),
      {
        expiresIn: request.expiresInSeconds,
        // Bind the exact part length into the signature.
        signableHeaders: new Set(["content-length"]),
      },
    );
  }
}
