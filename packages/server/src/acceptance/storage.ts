import { createHash } from "node:crypto";
import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { ServerConfig } from "../config.js";
import { storageClient } from "../storage.js";

/**
 * Streams one stored object through SHA-256 without buffering it. The key is
 * always a catalog-generated object key (never a client value); the bucket is
 * server configuration. A body that is longer or shorter than the catalog size,
 * a missing object, or a deadline overrun is a verification failure.
 */
export type ObjectHasher = {
  hash(
    objectKey: string,
    expectedBytes: number,
    timeoutMs: number,
  ): Promise<{ bytes: number; sha256: string }>;
};

export class ObjectHashError extends Error {
  constructor(
    readonly code:
      | "object_missing"
      | "object_size_mismatch"
      | "object_read_failed",
    message: string,
  ) {
    super(message);
  }
}

export function s3ObjectHasher(
  config: Pick<ServerConfig, "bucket"> & Partial<ServerConfig>,
  options: { client?: S3Client } = {},
): ObjectHasher {
  return {
    async hash(objectKey, expectedBytes, timeoutMs) {
      const owned = options.client
        ? undefined
        : storageClient(config as ServerConfig, timeoutMs);
      const client = options.client ?? owned!;
      const abort = new AbortController();
      const timer = setTimeout(
        () => abort.abort(new Error("object verification timed out")),
        timeoutMs,
      );
      try {
        let response;
        try {
          response = await client.send(
            new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }),
            { abortSignal: abort.signal },
          );
        } catch (error) {
          const status = (error as { $metadata?: { httpStatusCode?: number } })
            .$metadata?.httpStatusCode;
          throw new ObjectHashError(
            status === 404 ? "object_missing" : "object_read_failed",
            "output object could not be read",
          );
        }
        const body = response.Body as AsyncIterable<Uint8Array> | undefined;
        if (!body) throw new ObjectHashError("object_read_failed", "no body");
        const hash = createHash("sha256");
        let bytes = 0;
        try {
          for await (const chunk of body) {
            bytes += chunk.byteLength;
            if (bytes > expectedBytes)
              throw new ObjectHashError(
                "object_size_mismatch",
                "stored object is larger than declared",
              );
            hash.update(chunk);
          }
        } catch (error) {
          if (error instanceof ObjectHashError) throw error;
          throw new ObjectHashError("object_read_failed", "stream failed");
        }
        if (bytes !== expectedBytes)
          throw new ObjectHashError(
            "object_size_mismatch",
            "stored object is shorter than declared",
          );
        return { bytes, sha256: hash.digest("hex") };
      } finally {
        clearTimeout(timer);
        abort.abort();
        owned?.destroy();
      }
    },
  };
}
