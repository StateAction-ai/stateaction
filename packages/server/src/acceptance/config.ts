/**
 * Finite, explicit budgets for the API's streaming verification of worker
 * outputs. Every bound has a safe default and an optional validated override;
 * none is unbounded. The same values apply locally and hosted.
 */
export type AcceptanceConfig = {
  /**
   * Hard ceiling on aggregate bytes streamed and hashed for ONE job. The
   * per-job budget (`outputByteBudget`) is never above this ceiling.
   */
  verifyMaxBytes: number;
  /**
   * Hard ceiling on output objects hashed for one job. The per-job budget
   * (`outputFileBudget`) is never above this ceiling.
   */
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

/** Length of one exported clip (SA-38 viewer and recipe clip plan). */
export const CLIP_SECONDS = 60;
/** Output objects per clip: rgb, hand arrays, observations, frame map, thumbnail, viewer. */
export const FILES_PER_CLIP = 6;
/** Annotation outputs: segments, captions, hand-presence and recording.mp4. */
export const ANNOTATION_FILES = 4;
/** Most diagnostic blobs one job may declare (SA-88 slot policy). */
export const DIAGNOSTIC_FILES = 12;
/** The job manifest. */
export const MANIFEST_FILES = 1;
/** Bytes budgeted per clip: the SA-38 viewer clip cap. */
export const CLIP_BYTES = 128 * 1024 ** 2;
/** Bytes budgeted per diagnostic blob (SA-88 slot policy). */
export const DIAGNOSTIC_BYTES = 64 * 1024 ** 2;
/** Fixed bytes for annotations and the full-recording review video. */
export const ANNOTATION_BASE_BYTES = 4 * 1024 ** 3;

/**
 * Per-job output file budget from the closure's clip count (the recording
 * duration in whole 60 s clips). A 2 h job has 120 clips and a budget of 737.
 * Not capped here: callers apply the hard ceiling.
 */
export function outputFileBudget(clipCount: number): number {
  return (
    FILES_PER_CLIP * clipCount +
    ANNOTATION_FILES +
    DIAGNOSTIC_FILES +
    MANIFEST_FILES
  );
}

/**
 * Per-job output byte budget: the fixed annotation allowance, the diagnostic
 * allowance and CLIP_BYTES per clip. Not capped here: callers apply the ceiling.
 */
export function outputByteBudget(clipCount: number): number {
  return (
    ANNOTATION_BASE_BYTES +
    DIAGNOSTIC_FILES * DIAGNOSTIC_BYTES +
    clipCount * CLIP_BYTES
  );
}

/** Per-job file limit: the budget for the clip count, never above the ceiling. */
export function jobOutputFileLimit(ceiling: number, clipCount: number): number {
  return Math.min(ceiling, outputFileBudget(clipCount));
}

/** Per-job byte limit: the budget for the clip count, never above the ceiling. */
export function jobOutputByteLimit(ceiling: number, clipCount: number): number {
  return Math.min(ceiling, outputByteBudget(clipCount));
}

/** Clips needed to cover a recording of `seconds` (ceil over CLIP_SECONDS). */
export function clipsForSeconds(seconds: number): number {
  return Math.ceil(seconds / CLIP_SECONDS);
}

const DEFAULTS: AcceptanceConfig = {
  verifyMaxBytes: 16 * 1024 ** 3,
  verifyMaxFiles: 2000,
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
