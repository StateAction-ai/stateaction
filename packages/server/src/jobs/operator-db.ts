import pg from "pg";

export function operatorDatabaseUrl(env = process.env): string {
  const local = (env.APP_ENV ?? "local") === "local";
  const value =
    env.MIGRATION_DATABASE_URL ?? (local ? env.DATABASE_URL : undefined);
  if (!value) throw new Error("Missing server setting: MIGRATION_DATABASE_URL");
  if (
    local &&
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname)
  )
    throw new Error("Local operator tooling refuses non-loopback databases");
  return value;
}

export type ModalRecoveryIdentity = {
  jobId: string;
  runRef: string;
  stage?: string;
};

/** Reads only the original claim digest from the owner connection. */
export async function modalRecoveryBootstrapHash(
  db: Pick<pg.Pool, "query">,
  { jobId, runRef, stage }: ModalRecoveryIdentity,
): Promise<string> {
  const { rows } = await db.query<{ digest: string | null }>(
    `SELECT CASE WHEN $3::text IS NULL THEN j.bootstrap_token_sha256
                  ELSE c.bootstrap_token_sha256 END AS digest
     FROM jobs j
     JOIN recordings r ON r.id = j.recording_id AND r.current_job_id = j.id
     JOIN dispatch_admission a ON a.slot = 1 AND a.job_id = j.id
     LEFT JOIN job_stage_claims c ON c.job_id = j.id AND c.stage = $3::text
     WHERE j.id = $1 AND j.workflow_run_ref = $2 AND j.state = 'cancel_requested'
       AND j.execution_backend = 'modal' AND j.submission_intent_at IS NOT NULL
       AND ((j.recipe IS NULL) = ($3::text IS NULL))`,
    [jobId, runRef, stage ?? null],
  );
  const digest = rows[0]?.digest;
  if (!digest)
    throw new Error("Original Modal submission cannot be identified");
  return digest;
}

export async function readModalRecoveryBootstrapHash(
  identity: ModalRecoveryIdentity,
): Promise<string> {
  const pool = new pg.Pool({
    connectionString: operatorDatabaseUrl(),
    max: 1,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });
  try {
    return await modalRecoveryBootstrapHash(pool, identity);
  } finally {
    await pool.end();
  }
}
