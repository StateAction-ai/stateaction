import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { authConfig } from "../src/auth/config.js";
import { createAuthRuntime, type AuthRuntime } from "../src/auth/runtime.js";
import { hostedDevMediaRoute } from "../src/datasets/hosted-dev-media.js";
import { freshDatabase } from "./harness.js";
import { HOSTED_DEV_DATABASE_HOST } from "../src/hosted-dev.js";
import { presignObject, storageClient } from "../src/storage.js";
import { freshBucket } from "./storage-harness.js";

const previewEnvironment = {
  STATEACTION_HOSTED_DEV_MODE: "read-only",
  NODE_ENV: "development",
  APP_ENV: "development",
  DATABASE_URL: `postgresql://stateaction_dev_reader:test@${HOSTED_DEV_DATABASE_HOST}/stateaction?sslmode=verify-full`,
  STATEACTION_HOSTED_DEV_AUTH_DATABASE_URL:
    "postgresql://stateaction_app:test@127.0.0.1/local",
  STATEACTION_WEB_HOST: "127.0.0.1",
  BETTER_AUTH_URL: "http://127.0.0.1:3008",
  AUTH_LOCAL_PASSWORD: "true",
  S3_BUCKET: "stateaction-prod",
  CI: "",
  RENDER: "",
  RENDER_SERVICE_ID: "",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
};

test("hosted development permits object reads and blocks direct and signed PUTs", async () => {
  const bucket = await freshBucket();
  const originalEnv = process.env;
  const readOnly = /Hosted data profile permits only storage reads/;
  let client: ReturnType<typeof storageClient> | undefined;
  try {
    const Key = "preview-test/recording.txt";
    const body = Buffer.from("read-only fixture");
    await bucket.put(Key, body);
    process.env = { ...originalEnv, ...previewEnvironment };

    const config = bucket.config;
    const Bucket = config.bucket;
    client = storageClient(config, 60_000);
    const listed = await client.send(new ListObjectsV2Command({ Bucket }));
    assert.deepEqual(
      listed.Contents?.map((object) => object.Key),
      [Key],
    );
    const object = await client.send(new GetObjectCommand({ Bucket, Key }));
    assert.deepEqual(
      await object.Body?.transformToByteArray(),
      Uint8Array.from(body),
    );

    await assert.rejects(
      client.send(new PutObjectCommand({ Bucket, Key, Body: "changed" })),
      readOnly,
    );
    await assert.rejects(
      presignObject(config, { method: "PUT", key: Key }),
      readOnly,
    );
    const signed = await presignObject(config, { method: "GET", key: Key });
    const response = await fetch(signed);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
  } finally {
    process.env = originalEnv;
    client?.destroy();
    await bucket.remove();
  }
});

test("hosted media rejects wrong Hosts and origins before the staff gate", async () => {
  const db = await freshDatabase();
  const originalEnv = process.env;
  const runtimeKey = Symbol.for("stateaction.auth.runtime");
  const holder = globalThis as { [runtimeKey]?: AuthRuntime };
  const previousRuntime = holder[runtimeKey];
  process.env = {
    ...previewEnvironment,
    STATEACTION_HOSTED_DEV_AUTH_DATABASE_URL: db.appUrl,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  };
  const ticket = "e5800b6e-2c65-4b43-8cbe-b8113615d58a";
  const incoming = (host: string, origin?: string) =>
    new Request(
      `http://localhost:3008/api/v1/development/hosted-media/${ticket}`,
      {
        headers: { Host: host, ...(origin ? { Origin: origin } : {}) },
      },
    );
  try {
    // Use the route's real guard with the disposable local auth pool. The
    // catalog connection is unused because every request is unauthenticated.
    holder[runtimeKey] = createAuthRuntime(
      authConfig(process.env, { resolveDatabaseUrl: () => db.appUrl }),
      { pool: db.app },
    );
    for (const request of [
      incoming("example.invalid:3008"),
      incoming("localhost:3008"),
      incoming("127.0.0.1:3008", "https://example.invalid"),
    ])
      assert.equal((await hostedDevMediaRoute(request, ticket)).status, 404);
    const reachedStaffGate = await hostedDevMediaRoute(
      incoming("127.0.0.1:3008", previewEnvironment.BETTER_AUTH_URL),
      ticket,
    );
    assert.equal(reachedStaffGate.status, 401);
  } finally {
    if (previousRuntime) holder[runtimeKey] = previousRuntime;
    else delete holder[runtimeKey];
    process.env = originalEnv;
    await db.close();
  }
});
