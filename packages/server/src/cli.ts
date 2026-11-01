import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { serverConfig } from "./config.js";
import { initializeStorage, storageClient } from "./storage.js";
const config = serverConfig();
if (process.env.APP_ENV !== "local")
  throw new Error("This bootstrap CLI is local-only");
for (const address of [config.databaseUrl, config.endpoint]) {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(address).hostname))
    throw new Error("Local bootstrap refuses non-loopback endpoints");
}
if (process.argv[2] === "migrate") {
  const sql = await readFile(
    new URL("../migrations/001_platform.sql", import.meta.url),
    "utf8",
  );
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 3000,
  });
  try {
    await pool.query(sql);
    console.log("Platform schema version 1 ready");
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
} else throw new Error("Expected migrate, storage-init or storage-check");
