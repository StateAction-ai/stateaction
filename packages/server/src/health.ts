import { Pool } from "pg";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { serverConfig } from "./config.js";
import { storageClient } from "./storage.js";
export async function platformHealth() {
  try {
    const config = serverConfig();
    const pool = new Pool({
      connectionString: config.databaseUrl,
      max: 1,
      connectionTimeoutMillis: 1000,
      statement_timeout: 2000,
    });
    const client = storageClient(config);
    const results = await Promise.allSettled([
      pool
        .query(
          "SELECT version FROM platform_schema_migrations WHERE version = 1",
        )
        .then((result) => {
          if (result.rowCount !== 1) throw new Error("Migration missing");
        }),
      client.send(new HeadBucketCommand({ Bucket: config.bucket }), {
        abortSignal: AbortSignal.timeout(3000),
      }),
    ]);
    await pool.end();
    client.destroy();
    return {
      status: results.every((result) => result.status === "fulfilled")
        ? ("ok" as const)
        : ("degraded" as const),
      checks: {
        database: results[0]?.status === "fulfilled",
        storage: results[1]?.status === "fulfilled",
      },
    };
  } catch {
    return {
      status: "degraded" as const,
      checks: { database: false, storage: false },
    };
  }
}
