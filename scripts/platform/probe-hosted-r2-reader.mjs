import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../packages/server/package.json", import.meta.url),
);
const {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const endpoint = new URL(process.env.S3_ENDPOINT ?? "");
if (
  endpoint.protocol !== "https:" ||
  !endpoint.hostname.endsWith(".r2.cloudflarestorage.com")
)
  throw new Error("The probe requires a private R2 endpoint");
const client = new S3Client({
  endpoint: endpoint.origin,
  region: "auto",
  forcePathStyle: true,
  maxAttempts: 1,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});
const Bucket = "stateaction-prod";
const Key = `operator-probes/hosted-dev-reader/${randomUUID()}`;
try {
  const source = process.env.S3_PROBE_OBJECT_KEY;
  const listed = await client.send(
    new ListObjectsV2Command({
      Bucket,
      MaxKeys: 1,
      ...(source ? { Prefix: source } : {}),
    }),
  );
  const stored = listed.Contents?.[0]?.Key;
  if (!stored || (source && stored !== source))
    throw new Error("The stored R2 probe object is missing");
  const range = await client.send(
    new GetObjectCommand({ Bucket, Key: stored, Range: "bytes=0-127" }),
  );
  const bytes = await range.Body?.transformToByteArray();
  if (range.$metadata.httpStatusCode !== 206 || !bytes?.length)
    throw new Error("The reader could not read an R2 object range");
  let denied = false;
  try {
    await client.send(
      new PutObjectCommand({
        Bucket,
        Key,
        Body: new Uint8Array(),
        IfNoneMatch: "*",
      }),
    );
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 403) throw error;
    denied = true;
  }
  if (!denied) {
    await client.send(new DeleteObjectCommand({ Bucket, Key }));
    throw new Error(
      "The reader token unexpectedly permitted PUT. The probe object was removed.",
    );
  }
  console.log(
    "R2 Object Read token can list and read objects and was refused PUT.",
  );
} catch (error) {
  console.error(
    "R2 reader probe failed.",
    error.$metadata?.httpStatusCode ?? "",
    error.name,
  );
  process.exitCode = 1;
} finally {
  client.destroy();
}
