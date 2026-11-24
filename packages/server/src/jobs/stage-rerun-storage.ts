import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import type { ServerConfig } from "../config.js";
import { storageClient } from "../storage.js";

export const copyPartBytes = 64 * 1024 ** 2;
const requestTimeoutMs = 30_000;

type CopyProgress = {
  uploadId: string | null;
  partTags: string[];
  targetReady: boolean;
};

interface CopyObjects {
  source: string;
  target: string;
  size: number;
}

export interface RerunCopy {
  advance(objects: CopyObjects, progress: CopyProgress): Promise<CopyProgress>;
  abort(targetKey: string, uploadId: string): Promise<void>;
}

const httpStatus = (error: unknown) =>
  (error as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;

/** Advances at most one provider operation after checking for a lost acknowledgement. */
export function s3RerunCopy(
  config: ServerConfig,
  provider?: ReturnType<typeof storageClient>,
): RerunCopy {
  const bucket = config.bucket;
  return {
    async advance({ source, target, size }, progress) {
      const client = provider ?? storageClient(config, requestTimeoutMs);
      const signal = { abortSignal: AbortSignal.timeout(requestTimeoutMs) };
      const object = { Bucket: bucket, Key: target };
      const copySource = [bucket, ...source.split("/")]
        .map(encodeURIComponent)
        .join("/");
      const targetReady = { uploadId: null, partTags: [], targetReady: true };
      try {
        if (
          size <= copyPartBytes ||
          progress.partTags.length === Math.ceil(size / copyPartBytes)
        ) {
          // The reserved destination only exists after Put/Complete. A later
          // streaming hash verifies those bytes before the file is published.
          const existing = await client
            .send(new HeadObjectCommand(object), signal)
            .catch((error: unknown) => {
              if (httpStatus(error) === 404) return undefined;
              throw error;
            });
          if (existing?.ContentLength === size) return targetReady;
          if (size <= copyPartBytes) {
            await client.send(
              new CopyObjectCommand({ ...object, CopySource: copySource }),
              signal,
            );
            return targetReady;
          }
        }
        if (!progress.uploadId) {
          const result = await client.send(
            new CreateMultipartUploadCommand(object),
            signal,
          );
          if (!result.UploadId) throw new Error("Missing multipart identity");
          return { ...progress, uploadId: result.UploadId };
        }
        const upload = { ...object, UploadId: progress.uploadId };
        const start = progress.partTags.length * copyPartBytes;
        try {
          if (start >= size) {
            await client.send(
              new CompleteMultipartUploadCommand({
                ...upload,
                MultipartUpload: {
                  Parts: progress.partTags.map((ETag, index) => ({
                    ETag,
                    PartNumber: index + 1,
                  })),
                },
              }),
              signal,
            );
            return targetReady;
          }
          const end = Math.min(size, start + copyPartBytes) - 1;
          const result = await client.send(
            new UploadPartCopyCommand({
              ...upload,
              CopySource: copySource,
              CopySourceRange: `bytes=${start}-${end}`,
              PartNumber: progress.partTags.length + 1,
            }),
            signal,
          );
          const tag = result.CopyPartResult?.ETag;
          if (!tag) throw new Error("Missing copied part proof");
          return { ...progress, partTags: [...progress.partTags, tag] };
        } catch (error) {
          // An expired multipart upload must be reinitialized. After a lost
          // Complete response the HEAD above finds the object on re-entry.
          if (httpStatus(error) !== 404) throw error;
          return { uploadId: null, partTags: [], targetReady: false };
        }
      } finally {
        if (!provider) client.destroy();
      }
    },
    async abort(targetKey, uploadId) {
      const client = provider ?? storageClient(config, requestTimeoutMs);
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: targetKey,
            UploadId: uploadId,
          }),
          { abortSignal: AbortSignal.timeout(requestTimeoutMs) },
        );
      } finally {
        if (!provider) client.destroy();
      }
    },
  };
}
