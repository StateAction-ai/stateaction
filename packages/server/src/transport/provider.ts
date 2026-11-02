import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
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

/**
 * The only provider surface the transport service uses. Completion, abort and
 * restart belong to the reconciliation layer (SA-21) and are intentionally
 * absent except best-effort abort of an upload this process just created.
 */
export interface MultipartProvider {
  /** Uploads in flight for exactly this key (exact-key filter applied). */
  listUploadsForKey(key: string): Promise<ProviderUpload[]>;
  createUpload(key: string): Promise<ProviderUpload>;
  abortUpload(key: string, uploadId: string): Promise<void>;
  /** Parts with numbers in [fromPart, toPart], fully paginated. */
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
  ) {}

  async listUploadsForKey(key: string): Promise<ProviderUpload[]> {
    const found: ProviderUpload[] = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const out = await this.control.send(
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
    await this.control.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
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
      const out = await this.control.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
          MaxParts: 1000,
        }),
      );
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
