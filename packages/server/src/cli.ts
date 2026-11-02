import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { serverConfig } from "./config.js";
import { initializeStorage, storageClient } from "./storage.js";
import { migrateDatabase } from "./migrations.js";
import { seedLocalCatalog } from "./catalog/seed.js";
const config = serverConfig();
if (process.env.APP_ENV !== "local")
  throw new Error("This bootstrap CLI is local-only");
for (const address of [config.databaseUrl, config.endpoint]) {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(address).hostname))
    throw new Error("Local bootstrap refuses non-loopback endpoints");
}
if (process.argv[2] === "migrate") {
  // Local owner path; hosted runs use the separate owner URL (SA-14 wiring).
  const report = await migrateDatabase({ ownerUrl: config.databaseUrl });
  console.log(
    `Schema ready: applied [${report.applied.join(",")}], already applied [${report.alreadyApplied.join(",")}], checksum adopted [${report.adopted.join(",")}], app role grants ${report.appRoleGranted ? "applied" : "skipped (role absent)"}`,
  );
} else if (process.argv[2] === "seed") {
  const password = process.env.LOCAL_SEED_PASSWORD;
  if (password !== undefined && password.length < 12)
    throw new Error("LOCAL_SEED_PASSWORD must have at least 12 characters");
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
  try {
    const report = await seedLocalCatalog(pool, password ? { password } : {});
    console.log(
      report.seeded
        ? `Local catalog seeded${report.credentialAccounts ? " with credential accounts" : " (identities only; set LOCAL_SEED_PASSWORD for sign-in accounts)"}`
        : "Local catalog seed already present",
    );
  } finally {
    await pool.end();
  }
} else if (process.argv[2] === "storage-init") {
  await initializeStorage(config);
  console.log("Local bucket ready");
} else if (process.argv[2] === "storage-check") {
  const client = storageClient(config, 30000);
  const key = `platform-check/${randomUUID()}`;
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: "stateaction-platform",
      }),
    );
    const object = await client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    );
    if ((await object.Body?.transformToString()) !== "stateaction-platform")
      throw new Error("Stored bytes changed");
    console.log("Local S3 Put/Get verified");
  } finally {
    await client.send(
      new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
    );
    client.destroy();
  }
} else throw new Error("Expected migrate, seed, storage-init or storage-check");
