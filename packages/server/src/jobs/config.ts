/**
 * Explicit, fail-closed job orchestration settings. Identical locally,
 * in development and on Render: only the injected environment differs. The
 * values are the permanent input identity recorded on every admitted job.
 */
export type JobsConfig = {
  executionBackend: "local" | "modal";
  codeRevision: string;
  imageSpecSha256: string;
  modelSha256: string;
  configSha256: string;
  limits: {
    maxOutputFiles: number;
    maxOutputBytes: string;
    maxControlDocumentBytes: number;
  };
  /** Absolute job deadline anchored to first admission, never reset. */
  executionDeadlineSeconds: number;
  /** Time a submitted worker has to win its physical claim. */
  startDeadlineSeconds: number;
  /** Controller lease length (renew about every 30 seconds). */
  leaseSeconds: number;
  /** Signed source read URL lifetime (capped by the execution deadline). */
  readUrlSeconds: number;
  /** Repair pass bounds; every field has an explicit finite default. */
  repair?: Partial<RepairLimits>;
};

/** Hard bounds for one minute repair pass (SA-27). Nothing waits or retries unboundedly. */
export type RepairLimits = {
  /** Max jobs touched per repair step and Render starts per pass. */
  batchLimit: number;
  /** Wall-clock budget for the whole pass; no new start begins after it. */
  wallBudgetMs: number;
  /** Abort for one Render task start. */
  startTimeoutMs: number;
  /**
   * An admitted job whose controller never recorded a worker submission is
   * failed (never submitted, proven by the database) after this window.
   */
  dispatchWindowSeconds: number;
  /** A controller lease must be expired this long before repair acts on it. */
  leaseGraceSeconds: number;
};

export const DEFAULT_REPAIR_LIMITS: RepairLimits = {
  batchLimit: 5,
  wallBudgetMs: 40_000,
  startTimeoutMs: 10_000,
  dispatchWindowSeconds: 1800,
  leaseGraceSeconds: 60,
};

export const repairLimits = (
  config: Pick<JobsConfig, "repair">,
): RepairLimits => ({
  ...DEFAULT_REPAIR_LIMITS,
  ...config.repair,
});

const REVISION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SHA = /^[0-9a-f]{64}$/;

function setting(env: NodeJS.ProcessEnv, name: string, pattern: RegExp) {
  const value = env[name];
  if (!value || !pattern.test(value))
    throw new Error(`Missing or invalid server setting: ${name}`);
  return value;
}

export function jobsConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): JobsConfig {
  const backend = env.PROCESSING_EXECUTION_BACKEND;
  if (backend !== "local" && backend !== "modal")
    throw new Error(
      "Missing or invalid server setting: PROCESSING_EXECUTION_BACKEND",
    );
  const maxOutputFiles = Number(env.PROCESSING_MAX_OUTPUT_FILES ?? 512);
  if (
    !Number.isSafeInteger(maxOutputFiles) ||
    maxOutputFiles < 1 ||
    maxOutputFiles > 2000
  )
    throw new Error(
      "PROCESSING_MAX_OUTPUT_FILES must be an integer in 1..2000",
    );
  return {
    executionBackend: backend,
    codeRevision: setting(env, "PROCESSING_CODE_REVISION", REVISION),
    imageSpecSha256: setting(env, "PROCESSING_IMAGE_SPEC_SHA256", SHA),
    modelSha256: setting(env, "PROCESSING_MODEL_SHA256", SHA),
    configSha256: setting(env, "PROCESSING_CONFIG_SHA256", SHA),
    limits: {
      maxOutputFiles,
      maxOutputBytes: "68719476736",
      maxControlDocumentBytes: 1048576,
    },
    executionDeadlineSeconds: 6 * 3600,
    startDeadlineSeconds: 600,
    leaseSeconds: 120,
    readUrlSeconds: 900,
  };
}
