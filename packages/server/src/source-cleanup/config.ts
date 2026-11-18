/**
 * Finite, explicit budgets for streaming and hashing sealed source originals.
 * The defaults suit the short pilot samples; every bound is validated and none
 * is unbounded. A recording above a cap gets an actionable "no proof" answer,
 * never a partial verification or a large allocation.
 */
export type SourceCleanupConfig = {
  /** Aggregate bytes streamed and hashed for ONE verification (all originals). */
  maxTotalBytes: number;
  /** Largest single original object that may be verified. */
  maxObjectBytes: number;
  /** Most sealed files in one verification. */
  maxFiles: number;
  /** Wall deadline for streaming one object. */
  objectTimeoutMs: number;
  /** Wall deadline for the whole verification (all objects). */
  wallMs: number;
  /** Lifetime of an issued owner proof (server clock). */
  proofTtlSeconds: number;
  /** Finite wait for a pool connection, every statement and every lock. */
  dbTimeoutMs: number;
  /** Finite wall for receiving the (<= 1 KiB) request body. */
  bodyTimeoutMs: number;
};

export const SOURCE_CLEANUP_PROOF_TTL_CAP_SECONDS = 120;

const DEFAULTS: SourceCleanupConfig = {
  maxTotalBytes: 128 * 1024 ** 2,
  maxObjectBytes: 128 * 1024 ** 2,
  maxFiles: 64,
  objectTimeoutMs: 30_000,
  wallMs: 60_000,
  proofTtlSeconds: 60,
  dbTimeoutMs: 10_000,
  bodyTimeoutMs: 5_000,
};

function bounded(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid server setting: ${name}`);
  return value;
}

export function sourceCleanupConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SourceCleanupConfig {
  const config: SourceCleanupConfig = {
    maxTotalBytes: bounded(
      env,
      "SOURCE_COPY_VERIFY_MAX_BYTES",
      DEFAULTS.maxTotalBytes,
      1,
      64 * 1024 ** 3,
    ),
    maxObjectBytes: bounded(
      env,
      "SOURCE_COPY_VERIFY_MAX_OBJECT_BYTES",
      DEFAULTS.maxObjectBytes,
      1,
      64 * 1024 ** 3,
    ),
    maxFiles: bounded(
      env,
      "SOURCE_COPY_VERIFY_MAX_FILES",
      DEFAULTS.maxFiles,
      3,
      600,
    ),
    objectTimeoutMs: bounded(
      env,
      "SOURCE_COPY_VERIFY_OBJECT_TIMEOUT_MS",
      DEFAULTS.objectTimeoutMs,
      1000,
      900_000,
    ),
    wallMs: bounded(
      env,
      "SOURCE_COPY_VERIFY_WALL_MS",
      DEFAULTS.wallMs,
      1000,
      1_800_000,
    ),
    proofTtlSeconds: bounded(
      env,
      "SOURCE_CLEANUP_PROOF_TTL_SECONDS",
      DEFAULTS.proofTtlSeconds,
      5,
      SOURCE_CLEANUP_PROOF_TTL_CAP_SECONDS,
    ),
    dbTimeoutMs: bounded(
      env,
      "SOURCE_COPY_DB_TIMEOUT_MS",
      DEFAULTS.dbTimeoutMs,
      200,
      60_000,
    ),
    bodyTimeoutMs: bounded(
      env,
      "SOURCE_COPY_BODY_TIMEOUT_MS",
      DEFAULTS.bodyTimeoutMs,
      100,
      30_000,
    ),
  };
  return config;
}
