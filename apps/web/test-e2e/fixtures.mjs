// Fixture selection for the real-stack web E2E harness.
//
// Default: throwaway Docker containers (test-auth/postgres.mjs, seaweedfs.mjs).
// Bounded external mode, only when `E2E_EXTERNAL_FIXTURES` names an env file:
// the run uses an already-running user-process Postgres and S3-compatible
// store. It never starts Docker and never reads credentials from anywhere but
// that explicit file (plus the process environment). Isolation is the same
// role layout as `scripts/catalog-integration.sh` / `freshDatabase()`:
//   * each run creates its own `e2e_<random>` database owned by the existing
//     non-superuser `migration_owner`, and drops it afterwards;
//   * Next connects only as the existing restricted `stateaction_app` role;
//   * each run uses its own bucket, emptied and removed afterwards.
// Nothing here is R2 or hosted; secrets are never printed.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { startCatalogPostgres } from "../../../packages/server/test-auth/postgres.mjs";
import { startSeaweedfs } from "./seaweedfs.mjs";

const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const serverRequire = createRequire(`${serverDir}package.json`);

let loaded;
/** Parsed KEY=VALUE pairs of the explicit env file, or null for Docker mode. */
export function externalFixtures() {
  const file = process.env.E2E_EXTERNAL_FIXTURES;
  if (!file) return null;
  if (loaded) return loaded;
  const values = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!m) continue;
    values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  for (const key of [
    "CATALOG_TEST_ADMIN_URL",
    "CATALOG_TEST_OWNER_URL",
    "CATALOG_TEST_APP_URL",
    "STORAGE_TEST_ENDPOINT",
    "STORAGE_TEST_ACCESS_KEY_ID",
    "STORAGE_TEST_SECRET_ACCESS_KEY",
  ])
    if (!values[key])
      throw new Error(`${key} missing from E2E_EXTERNAL_FIXTURES`);
  for (const key of [
    "CATALOG_TEST_ADMIN_URL",
    "CATALOG_TEST_OWNER_URL",
    "CATALOG_TEST_APP_URL",
    "STORAGE_TEST_ENDPOINT",
  ]) {
    const host = new URL(values[key]).hostname;
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host))
      throw new Error(
        `${key} must be loopback; external fixtures are local only`,
      );
  }
  return (loaded = values);
}

const withDb = (url, db) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

/**
 * {ownerUrl, appUrl, stop} for a fresh, isolated database. `stop()` is async.
 */
export async function startCatalogFixture() {
  const ext = externalFixtures();
  if (!ext) {
    const db = await startCatalogPostgres();
    return { ...db, stop: async () => db.stop(), mode: "docker" };
  }
  const { Client } = serverRequire("pg");
  const name = `e2e_${randomBytes(8).toString("hex")}`;
  const admin = async (sql) => {
    const client = new Client({ connectionString: ext.CATALOG_TEST_ADMIN_URL });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  await admin(`CREATE DATABASE ${name} OWNER migration_owner`);
  return {
    name,
    mode: "external",
    ownerUrl: withDb(ext.CATALOG_TEST_OWNER_URL, name),
    appUrl: withDb(ext.CATALOG_TEST_APP_URL, name),
    stop: async () => {
      try {
        await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } catch {
        // Best effort; the name is unique to this run.
      }
    },
  };
}

/**
 * {endpoint, accessKeyId, secretAccessKey, bucket?, name?, stop} for an
 * S3-compatible store. In external mode there is no container to pause (`name`
 * is undefined) and `bucket` is unique to this run.
 */
export async function startStorageFixture() {
  const ext = externalFixtures();
  if (!ext) {
    const s3 = await startSeaweedfs();
    return { ...s3, stop: async () => s3.stop(), mode: "docker" };
  }
  const bucket = `e2e-${randomBytes(6).toString("hex")}`;
  return {
    mode: "external",
    endpoint: ext.STORAGE_TEST_ENDPOINT,
    accessKeyId: ext.STORAGE_TEST_ACCESS_KEY_ID,
    secretAccessKey: ext.STORAGE_TEST_SECRET_ACCESS_KEY,
    bucket,
    stop: async () => {
      const {
        S3Client,
        ListObjectsV2Command,
        DeleteObjectCommand,
        ListMultipartUploadsCommand,
        AbortMultipartUploadCommand,
        DeleteBucketCommand,
      } = serverRequire("@aws-sdk/client-s3");
      const client = new S3Client({
        endpoint: ext.STORAGE_TEST_ENDPOINT,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: {
          accessKeyId: ext.STORAGE_TEST_ACCESS_KEY_ID,
          secretAccessKey: ext.STORAGE_TEST_SECRET_ACCESS_KEY,
        },
      });
      try {
        const uploads = await client.send(
          new ListMultipartUploadsCommand({ Bucket: bucket }),
        );
        for (const u of uploads.Uploads ?? [])
          await client.send(
            new AbortMultipartUploadCommand({
              Bucket: bucket,
              Key: u.Key,
              UploadId: u.UploadId,
            }),
          );
        const listed = await client.send(
          new ListObjectsV2Command({ Bucket: bucket }),
        );
        for (const o of listed.Contents ?? [])
          await client.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: o.Key }),
          );
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      } catch {
        // Best effort; the bucket name is unique to this run.
      } finally {
        client.destroy();
      }
    },
  };
}
