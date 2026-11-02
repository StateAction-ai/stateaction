import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { ServerConfig } from "../config.js";
import { storageClient } from "../storage.js";
import { ObjectTooLargeError, type ObjectReader } from "./recordings.js";

/**
 * The stored object is absent or the store is temporarily unavailable
 * (timeout, connection reset, 5xx, throttling, truncated body). Admission
 * treats every non-size failure as pending/retryable; it never decides a
 * durable outcome from a failed read.
 */
export class ObjectReadUnavailableError extends Error {
  readonly code = "object_read_unavailable";
  constructor(
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export type S3ObjectReaderOptions = {
  /** Injected client (tests, connection reuse). Default: one per read. */
  client?: S3Client;
  /** Whole-request deadline including the body stream. */
  timeoutMs?: number;
};

type Body = AsyncIterable<Uint8Array> & { destroy?: (e?: Error) => void };

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
}

/**
 * Storage-backed ObjectReader for the <= 1 MiB recording source manifest only.
 * MCAP/media are never read through the API. A Content-Length or
 * Content-Range total above maxBytes is refused before any body byte is
 * consumed; an unknown-length body is counted and the stream cancelled as
 * soon as it would exceed maxBytes. Exact bytes/hash/size are then verified by
 * checkSourceDeclaration against the pinned digest.
 */
export function s3ObjectReader(
  config: Pick<ServerConfig, "bucket"> & Partial<ServerConfig>,
  options: S3ObjectReaderOptions = {},
): ObjectReader {
  const timeoutMs = options.timeoutMs ?? 5000;
  return {
    async read(objectKey: string, maxBytes: number): Promise<Uint8Array> {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
        throw new RangeError("maxBytes must be a non-negative safe integer");
      const owned = options.client
        ? undefined
        : storageClient(config as ServerConfig, timeoutMs);
      const client = options.client ?? owned!;
      const abort = new AbortController();
      const timer = setTimeout(
        () => abort.abort(new Error("storage read timed out")),
        timeoutMs,
      );
      let body: Body | undefined;
      try {
        let response;
        try {
          response = await client.send(
            new GetObjectCommand({
              Bucket: config.bucket,
              Key: objectKey,
              // Ask for at most maxBytes + 1: a compliant store never sends
              // more, and the extra byte (or the Content-Range total) proves an
              // oversized object without transferring it.
              Range: `bytes=0-${maxBytes}`,
            }),
            { abortSignal: abort.signal },
          );
        } catch (error) {
          const status = statusOf(error);
          // 416: zero-length object (no satisfiable range).
          if (status === 416) return new Uint8Array(0);
          throw new ObjectReadUnavailableError(
            status === 404 ? "stored object not found" : "storage read failed",
            status,
            { cause: error },
          );
        }
        body = response.Body as Body | undefined;
        const total = totalLength(response.ContentRange);
        if (total !== undefined && total > maxBytes)
          throw new ObjectTooLargeError("stored object exceeds limit");
        if (
          response.ContentLength !== undefined &&
          response.ContentLength > maxBytes
        )
          throw new ObjectTooLargeError("stored object exceeds limit");
        if (!body) return new Uint8Array(0);
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for await (const chunk of body) {
            size += chunk.byteLength;
            if (size > maxBytes)
              throw new ObjectTooLargeError("stored object exceeds limit");
            chunks.push(chunk);
          }
        } catch (error) {
          if (error instanceof ObjectTooLargeError) throw error;
          throw new ObjectReadUnavailableError(
            "storage body stream failed",
            undefined,
            { cause: error },
          );
        }
        // A declared length the stream did not deliver is a truncated read.
        if (
          response.ContentLength !== undefined &&
          size !== response.ContentLength
        )
          throw new ObjectReadUnavailableError("storage body truncated");
        body = undefined;
        const out = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return out;
      } finally {
        clearTimeout(timer);
        if (body) {
          // Stop an oversized or failed stream; never drain it.
          abort.abort(new Error("storage read cancelled"));
          body.destroy?.();
        }
        owned?.destroy();
      }
    },
  };
}

function totalLength(contentRange: string | undefined): number | undefined {
  const match = /^bytes \d+-\d+\/(\d+)$/.exec(contentRange ?? "");
  return match ? Number(match[1]) : undefined;
}
