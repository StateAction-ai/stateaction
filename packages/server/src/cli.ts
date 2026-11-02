import pg from "pg";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { issueControllerCapability } from "./jobs/credentials.js";
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { appEnv, serverConfig } from "./config.js";
import { migrateDatabase } from "./migrations.js";
import { admissionConfigFromEnv } from "./admission/recordings.js";
import { seedLocalCatalog } from "./catalog/seed.js";
import { initializeStorage, presignObject, storageClient } from "./storage.js";
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
const command = process.argv[2];
const env = appEnv();
const requireLoopback = (addresses: string[]) => {
  for (const address of addresses)
    if (!LOOPBACK.includes(new URL(address).hostname))
      throw new Error("Local bootstrap refuses non-loopback endpoints");
};
if (command === "migrate") {
  // Owner path. Hosted/dev use MIGRATION_DATABASE_URL (never present in the web
  // or workflow services); local bootstrap reuses the single local DATABASE_URL.
  const ownerUrl =
    process.env.MIGRATION_DATABASE_URL ??
    (env === "local" ? process.env.DATABASE_URL : undefined);
  if (!ownerUrl)
    throw new Error("Missing server setting: MIGRATION_DATABASE_URL");
  if (env === "local") requireLoopback([ownerUrl]);
  else if (!process.env.APP_DB_PASSWORD)
    throw new Error("Missing server setting: APP_DB_PASSWORD");
  const appRolePassword = process.env.APP_DB_PASSWORD;
  const report = await migrateDatabase(
    appRolePassword ? { ownerUrl, appRolePassword } : { ownerUrl },
  );
  console.log(
    `Schema ready: applied [${report.applied.join(",")}], already applied [${report.alreadyApplied.join(",")}], checksum adopted [${report.adopted.join(",")}], app role grants ${report.appRoleGranted ? "applied" : "skipped (role absent)"}`,
  );
} else if (command === "seed") {
  // Local-only fixtures through the single local DATABASE_URL.
  if (env !== "local") throw new Error("Seeding is local-only");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing server setting: DATABASE_URL");
  requireLoopback([url]);
  const password = process.env.LOCAL_SEED_PASSWORD;
  if (password !== undefined && password.length < 12)
    throw new Error("LOCAL_SEED_PASSWORD must have at least 12 characters");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
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
} else if (command === "preflight") {
  // Configuration and environment-isolation check before a hosted web process
  // listens. Database readiness is reported by /api/v1/health, not startup.
  serverConfig();
  admissionConfigFromEnv(process.env);
  console.log(`Preflight passed (${env})`);
} else if (command === "storage-init") {
  const config = serverConfig();
  if (env !== "local")
    throw new Error("Buckets are created out of band outside local");
  requireLoopback([config.endpoint]);
  await initializeStorage(config);
  console.log("Local bucket ready");
} else if (command === "storage-check") {
  const config = serverConfig();
  if (env === "local") requireLoopback([config.endpoint]);
  const client = storageClient(config, 30000);
  // Tiny owned prefix, removed even on failure.
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
    console.log(`${env} S3 Put/Get verified`);
  } finally {
    await client.send(
      new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
    );
    client.destroy();
  }
} else if (command === "presign-check") {
  // Proves URLs are signed for the origin clients use and honoured by the store.
  const config = serverConfig();
  const key = `platform-check/${randomUUID()}`;
  const body = "stateaction-presign";
  const put = await presignObject(config, { method: "PUT", key });
  const get = await presignObject(config, { method: "GET", key });
  for (const url of [put, get])
    if (new URL(url).origin !== new URL(config.publicEndpoint).origin)
      throw new Error("Presigned URL does not use the public endpoint origin");
  const client = storageClient(config, 30000);
  try {
    const stored = await fetch(put, { method: "PUT", body });
    if (!stored.ok)
      throw new Error(
        `Presigned PUT failed: ${stored.status} ${(await stored.text()).slice(0, 200)}`,
      );
    const read = await fetch(get);
    if (!read.ok || (await read.text()) !== body)
      throw new Error(`Presigned GET failed: ${read.status}`);
    const unsigned = new URL(get);
    unsigned.search = "";
    if ((await fetch(unsigned)).ok)
      throw new Error("Unsigned access to the private object succeeded");
    // A URL signed for one origin must not validate at another (the host is
    // part of the SigV4 signature). Only possible where an alias exists
    // (loopback localhost <-> 127.0.0.1); real R2 has a single host.
    const signed = new URL(get);
    const alias =
      signed.hostname === "localhost"
        ? "127.0.0.1"
        : signed.hostname === "127.0.0.1"
          ? "localhost"
          : undefined;
    if (alias) {
      const crossOrigin = new URL(get);
      crossOrigin.hostname = alias;
      if ((await fetch(crossOrigin)).ok)
        throw new Error("URL signed for another origin was accepted");
    }
    console.log(`${env} presigned PUT/GET verified at ${new URL(put).origin}`);
  } finally {
    await client.send(
      new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
    );
    client.destroy();
  }
} else if (command === "issue-service-capability") {
  // Operator setup with the OWNER credential, never a request path: mints one
  // workflow-controller or repair-cron credential. The token is written once to
  // a new 0600 file (--out); only its SHA-256 is stored and nothing is printed.
  const flag = (name: string) => {
    const at = process.argv.indexOf(`--${name}`);
    return at > 2 ? process.argv[at + 1] : undefined;
  };
  const kind = flag("kind");
  const scopes = (flag("scopes") ?? "").split(",").filter(Boolean);
  const label = flag("label");
  const out = flag("out");
  const hours = Number(flag("ttl-hours") ?? "24");
  if (
    (kind !== "workflow" && kind !== "cron") ||
    !label ||
    !out ||
    !scopes.length
  )
    throw new Error(
      "Usage: issue-service-capability --kind workflow|cron --scopes jobs:status,jobs:reconcile --label <text> --out <new file> [--ttl-hours <1-24>]",
    );
  const allowed = ["jobs:status", "jobs:reconcile", "jobs:repair"] as const;
  type Allowed = (typeof allowed)[number];
  if (
    !scopes.every((x): x is Allowed =>
      (allowed as readonly string[]).includes(x),
    )
  )
    throw new Error("Unsupported scope");
  const ownerUrl =
    process.env.MIGRATION_DATABASE_URL ??
    (env === "local" ? process.env.DATABASE_URL : undefined);
  if (!ownerUrl)
    throw new Error("Missing server setting: MIGRATION_DATABASE_URL");
  if (env === "local") requireLoopback([ownerUrl]);
  const pool = new pg.Pool({ connectionString: ownerUrl, max: 1 });
  try {
    const issued = await issueControllerCapability(pool, {
      kind,
      scopes,
      label,
      ttlSeconds: Math.round(hours * 3600),
    });
    await writeFile(out, issued.token, { mode: 0o600, flag: "wx" });
    console.log(
      `Issued ${kind} capability ${issued.credentialId} (expires ${issued.expiresAt.toISOString()}); token written to the requested file`,
    );
  } finally {
    await pool.end();
  }
} else
  throw new Error(
    "Expected migrate, seed, preflight, storage-init, storage-check, presign-check or issue-service-capability",
  );
