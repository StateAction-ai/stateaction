import { randomUUID } from "node:crypto";
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import pg from "pg";
import { recordIngestPermission } from "../src/admission/permissions.js";
import { registerRecording } from "../src/admission/recordings.js";
import { storageClient } from "../src/storage.js";
import type { ServerConfig } from "../src/config.js";
import {
  S3MultipartProvider,
  type MultipartProvider,
  type SignedPart,
  type TransportDeps,
} from "../src/transport/index.js";
import { bucketName, ledgerRun, recordCreated } from "./fixture-ledger.js";
import {
  createActors,
  freshDatabase,
  type Actors,
  type TestDb,
} from "./harness.js";

const env = (key: string) => {
  const value = process.env[key];
  if (!value)
    throw new Error(`${key} is set by scripts/catalog-integration.sh`);
  return value;
};

// Ledger-recorded before creation (bounded external fixtures), so the launcher
// reaps this exact bucket; without a ledger the name stays run-unique.
const ledger = ledgerRun();
export const BUCKET = ledger
  ? bucketName(ledger)
  : `transport-${randomUUID().slice(0, 8)}`;
if (ledger) recordCreated(ledger, "bucket", BUCKET);
export function s3Config(): ServerConfig {
  const endpoint = env("TRANSPORT_TEST_S3_ENDPOINT");
  return {
    appEnv: "local",
    databaseUrl: "unused",
    endpoint,
    publicEndpoint: endpoint,
    region: "us-east-1",
    bucket: BUCKET,
    accessKeyId: env("TRANSPORT_TEST_S3_ACCESS_KEY"),
    secretAccessKey: env("TRANSPORT_TEST_S3_SECRET_KEY"),
  };
}
let bucketReady: Promise<void> | undefined;
export function realS3(): S3Client {
  const client = storageClient(s3Config(), 30_000);
  bucketReady ??= client
    .send(new CreateBucketCommand({ Bucket: BUCKET }))
    .then(() => undefined);
  return client;
}
export async function realProvider(): Promise<S3MultipartProvider> {
  const control = realS3();
  await bucketReady;
  return new S3MultipartProvider(
    control,
    storageClient(s3Config(), 30_000),
    BUCKET,
  );
}
export async function uploadsAt(key: string) {
  const client = realS3();
  const out = await client.send(
    new ListMultipartUploadsCommand({ Bucket: BUCKET, Prefix: key }),
  );
  return (out.Uploads ?? []).filter((u) => u.Key === key);
}

/** Fully migrated database (001-005, with the app grants) plus seeded actors. */
export async function transportDatabase(): Promise<
  TestDb & { actors: Actors }
> {
  const db = await freshDatabase();
  const actors = await createActors(db.owner);
  return Object.assign(db, { actors });
}

export async function openSession(
  db: TestDb,
  userId: string,
  expiresInMs = 3600_000,
): Promise<string> {
  const id = `sess_${randomUUID()}`;
  await db.owner.query(
    `INSERT INTO "session" (id, "expiresAt", token, "updatedAt", "userId")
     VALUES ($1, now() + ($2 || ' milliseconds')::interval, $3, now(), $4)`,
    [id, String(expiresInMs), `tok_${randomUUID()}`, userId],
  );
  return id;
}

/** Operator-recorded capture permission evidence for the owner (idempotent). */
export async function ensurePermission(db: TestDb, ownerUserId: string) {
  const active = await db.owner.query(
    "SELECT 1 FROM ingest_permissions WHERE owner_user_id = $1 AND status = 'active'",
    [ownerUserId],
  );
  if (active.rowCount) return;
  await recordIngestPermission(db.owner, {
    permissionRef: `pilot-${randomUUID().slice(0, 8)}`,
    ownerUserId,
    pilotScope: "sa20-integration",
    coversCapture: true,
    coversProcessing: true,
    evidenceRef: "doc://pilot/consent-and-processing",
    recordedBy: "operator@test",
  });
}

/** A recording registered through the real SA-19 admission path. */
export async function newRecording(db: TestDb, ownerUserId: string) {
  await ensurePermission(db, ownerUserId);
  const { recording } = await registerRecording(
    { pool: db.app },
    { userId: ownerUserId },
    {
      clientRecordingId: randomUUID(),
      captureFormat: "stateaction.capture.v1",
      rgbProfile: "h264_mcap_v1",
      startedAt: new Date().toISOString(),
      device: { model: "emulator", osVersion: "16", appVersion: "test" },
    },
  );
  return recording.recordingId;
}

export function depsFor(
  db: TestDb,
  provider: MultipartProvider,
  extra: Partial<TransportDeps> = {},
): TransportDeps {
  return { pool: db.app, provider, ...extra };
}

/** Plain HTTP PUT to a presigned URL; the only data path. */
export async function putPart(part: SignedPart, body: Buffer) {
  const response = await fetch(part.url, {
    method: "PUT",
    body,
    headers: part.headers,
  });
  return { status: response.status, etag: response.headers.get("etag") };
}

/** Test-only provider completion (SA-21 owns the real one) to prove usable receipts. */
export async function completeAndRead(
  key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
) {
  const client = realS3();
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: BUCKET,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
      },
    }),
  );
  const object = await client.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  return Buffer.from(await object.Body!.transformToByteArray());
}

/** Delegating provider with one-shot fault injection. */
export class FaultProvider implements MultipartProvider {
  failNext = new Set<
    "listUploadsForKey" | "createUpload" | "listParts" | "presignUploadPart"
  >();
  /** Create at the provider, then fail as if the response was lost. */
  loseCreateResponse = false;
  calls: string[] = [];
  constructor(private readonly inner: MultipartProvider) {}
  private gate(
    name:
      | "listUploadsForKey"
      | "createUpload"
      | "listParts"
      | "presignUploadPart",
  ) {
    this.calls.push(name);
    if (this.failNext.delete(name)) throw new Error(`injected ${name} failure`);
  }
  async listUploadsForKey(key: string) {
    this.gate("listUploadsForKey");
    return this.inner.listUploadsForKey(key);
  }
  async createUpload(key: string) {
    this.gate("createUpload");
    const created = await this.inner.createUpload(key);
    if (this.loseCreateResponse) {
      this.loseCreateResponse = false;
      throw new Error("injected lost create response");
    }
    return created;
  }
  abortUpload(key: string, uploadId: string) {
    this.calls.push("abortUpload");
    return this.inner.abortUpload(key, uploadId);
  }
  async listParts(key: string, uploadId: string, from: number, to: number) {
    this.gate("listParts");
    return this.inner.listParts(key, uploadId, from, to);
  }
  async presignUploadPart(
    request: Parameters<MultipartProvider["presignUploadPart"]>[0],
  ) {
    this.gate("presignUploadPart");
    return this.inner.presignUploadPart(request);
  }
}
