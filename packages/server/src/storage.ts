import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { hostedDevProfile } from "./hosted-dev.js";
import type { ServerConfig } from "./config.js";
export function storageClient(
  config: ServerConfig,
  timeoutMs = 3000,
  endpoint = config.endpoint,
): S3Client {
  const client = new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Presigned URLs must not bake in SDK-added checksum parameters a plain HTTP client cannot satisfy.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 1,
    requestHandler: {
      requestTimeout: timeoutMs,
      throwOnRequestTimeout: true,
      connectionTimeout: 1000,
    },
  });
  if (hostedDevProfile()?.mode === "read-only") {
    const reads = new Set([
      "GetObjectCommand",
      "HeadObjectCommand",
      "HeadBucketCommand",
      "ListObjectsV2Command",
    ]);
    client.middlewareStack.add(
      (next, context) => async (args) => {
        if (!context.commandName || !reads.has(context.commandName))
          throw new Error("Hosted data profile permits only storage reads");
        return next(args);
      },
      { step: "initialize", name: "hostedDevStorageReadOnly" },
    );
  }
  return client;
}
export async function initializeStorage(config: ServerConfig): Promise<void> {
  const client = storageClient(config);
  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode !== 404
      )
        throw error;
      await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
    }
  } finally {
    client.destroy();
  }
}
/**
 * Presign against the origin clients can reach (S3_PUBLIC_ENDPOINT), not the
 * backend-only endpoint. Signing is offline; the credentials never leave the server.
 */
export async function presignObject(
  config: ServerConfig,
  request: { method: "GET" | "PUT"; key: string; expiresInSeconds?: number },
): Promise<string> {
  const client = storageClient(config, 3000, config.publicEndpoint);
  try {
    const input = { Bucket: config.bucket, Key: request.key };
    return await getSignedUrl(
      client,
      request.method === "GET"
        ? new GetObjectCommand(input)
        : new PutObjectCommand(input),
      { expiresIn: Math.min(request.expiresInSeconds ?? 300, 900) },
    );
  } finally {
    client.destroy();
  }
}
