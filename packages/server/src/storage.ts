import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import type { ServerConfig } from "./config.js";
export function storageClient(
  config: ServerConfig,
  timeoutMs = 3000,
): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    maxAttempts: 1,
    requestHandler: {
      requestTimeout: timeoutMs,
      throwOnRequestTimeout: true,
      connectionTimeout: 1000,
    },
  });
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
