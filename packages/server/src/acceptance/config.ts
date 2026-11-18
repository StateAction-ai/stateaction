/**
 * Finite, explicit budgets for the API's streaming verification of worker
 * outputs. Every bound has a safe default and an optional validated override;
 * none is unbounded. The same values apply locally and hosted.
 */
export type AcceptanceConfig = {
  /** Aggregate bytes the API will stream and hash for ONE job (all outputs). */
  verifyMaxBytes: number;
  /** Most output objects hashed for one job. */
  verifyMaxFiles: number;
  /** Wall deadline for streaming one object. */
  verifyObjectTimeoutMs: number;
  /**
   * Soft budget of one advance call, checked BEFORE starting each object. The hard
   * per-call upper bound is the manifest read + this slice + one object in flight
   * (itself capped by verifyObjectTimeoutMs and the remaining verification wall);
   * unfinished files resume from durable per-file progress via reconcile.
   */
  verifySliceMs: number;
  /**
   * Total wall time from candidate receipt. Checked at entry and after every slow
   * or failed step: once elapsed the candidate is rejected `verification_timeout`
   * (a deterministic failed diagnostic); before that a transient outage only
   * leaves it provisional.
   */
  verifyWallSeconds: number;
  /** After terminal execution evidence with no candidate, wait this long, then fail. */
  graceSeconds: number;
};

const DEFAULTS: AcceptanceConfig = {
  verifyMaxBytes: 4 * 1024 ** 3,
  verifyMaxFiles: 600,
  verifyObjectTimeoutMs: 120_000,
  verifySliceMs: 25_000,
  verifyWallSeconds: 3600,
  graceSeconds: 120,
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

export function acceptanceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AcceptanceConfig {
  return {
    verifyMaxBytes: bounded(
      env,
      "ACCEPTANCE_VERIFY_MAX_BYTES",
      DEFAULTS.verifyMaxBytes,
      1,
      64 * 1024 ** 3,
    ),
    verifyMaxFiles: bounded(
      env,
      "ACCEPTANCE_VERIFY_MAX_FILES",
      DEFAULTS.verifyMaxFiles,
      1,
      2000,
    ),
    verifyObjectTimeoutMs: bounded(
      env,
      "ACCEPTANCE_VERIFY_OBJECT_TIMEOUT_MS",
      DEFAULTS.verifyObjectTimeoutMs,
      1000,
      900_000,
    ),
    verifySliceMs: DEFAULTS.verifySliceMs,
    verifyWallSeconds: DEFAULTS.verifyWallSeconds,
    graceSeconds: bounded(
      env,
      "ACCEPTANCE_RESULT_GRACE_SECONDS",
      DEFAULTS.graceSeconds,
      1,
      3600,
    ),
  };
}
