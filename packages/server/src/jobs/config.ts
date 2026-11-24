import type { ClipTaskInputV4 } from "@stateaction/contracts";
import {
  clipsForSeconds,
  jobOutputByteLimit,
  jobOutputFileLimit,
} from "../acceptance/config.js";
import {
  publicVideoCanaryFromEnv,
  type PublicVideoCanary,
} from "../admission/public-video-canary.js";
import { localRecipeDir } from "./local-recipe.js";

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
    /** Per-job output file budget (pinned at admission), never above the ceiling. */
    maxOutputFiles: number;
    /** Configured ceiling before applying the recording or clip workload budget. */
    outputFileCeiling?: number;
    maxOutputBytes: string;
    maxControlDocumentBytes: number;
  };
  /**
   * Absolute job deadline anchored to first admission, never reset. Fallback
   * for jobs without a recipe; recipe jobs use recipeExecutionDeadlineSeconds.
   */
  executionDeadlineSeconds: number;
  /** Time a submitted worker has to win its physical claim. */
  startDeadlineSeconds: number;
  /** Controller lease length (renew about every 30 seconds). */
  leaseSeconds: number;
  /** Signed source read URL lifetime (capped by the execution deadline). */
  readUrlSeconds: number;
  /** Repair pass bounds; every field has an explicit finite default. */
  repair?: Partial<RepairLimits>;
  /** SA-96 local-only recipe override directory; only ever set with APP_ENV=local. */
  localRecipeDir?: string;
  publicVideoCanary?: PublicVideoCanary;
  production?: boolean;
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

/** Longest recording the admission-time output budget covers (2 h). */
export const MAX_RECORDING_SECONDS = 7200;
/** Margin added to the sum of enabled stage budgets. */
export const RECIPE_DEADLINE_MARGIN_SECONDS = 1800;
export const RECIPE_DEADLINE_MIN_SECONDS = 3600;
export const RECIPE_DEADLINE_MAX_SECONDS = 43200;
/** Stable code for a recipe whose stage budgets cannot fit the deadline bounds. */
export const RECIPE_DEADLINE_ERROR_CODE = "recipe_deadline_exceeded";
/** Stable admission rejection code for a task input that fails contract validation. */
export const TASK_INPUT_INVALID_ERROR_CODE = "task_input_invalid";
/** Stable admission rejection code for a task-input builder that cannot build this job. */
export const TASK_INPUT_BUILD_FAILED_ERROR_CODE = "task_input_build_failed";

/**
 * Execution deadline for a recipe job: the sum of enabled stage budgets plus a
 * fixed margin, clamped to [1 h, 12 h]. A sum above the 12 h bound is refused
 * with RECIPE_DEADLINE_ERROR_CODE rather than clamped, so no job runs past it.
 */
type RecipeBudget = {
  stages: ReadonlyArray<{
    enabled: boolean;
    resources: { budgetSeconds: number };
  }>;
};

function budgetWithMargin(recipe: RecipeBudget, marginSeconds: number): number {
  const budget = recipe.stages
    .filter((stage) => stage.enabled)
    .reduce((sum, stage) => sum + stage.resources.budgetSeconds, 0);
  const total = budget + marginSeconds;
  if (total > RECIPE_DEADLINE_MAX_SECONDS)
    throw new Error(
      `${RECIPE_DEADLINE_ERROR_CODE}: enabled stage budgets need ${total} s, above the ${RECIPE_DEADLINE_MAX_SECONDS} s maximum`,
    );
  return total;
}

export function recipeExecutionDeadlineSeconds(recipe: RecipeBudget): number {
  return Math.max(
    RECIPE_DEADLINE_MIN_SECONDS,
    budgetWithMargin(recipe, RECIPE_DEADLINE_MARGIN_SECONDS),
  );
}

/** Pin clip-specific output caps and the deadline from the admitted source range. */
export function clipAdmissionBudget(config: JobsConfig, task: ClipTaskInputV4) {
  const range = task.clip.sourceRange;
  const frames = range.end_ordinal - range.start_ordinal;
  const durationNs = BigInt(range.end_ts_ns) - BigInt(range.start_ts_ns);
  const oneFrame = frames === 1;
  if (
    frames < 1 ||
    (oneFrame ? durationNs !== 0n : durationNs <= 0n) ||
    oneFrame !== (range.first_source_frame_id === range.last_source_frame_id)
  )
    throw new Error("clip_source_range_invalid");

  const durationSeconds = Number(durationNs) / 1e9;
  // Mirrors ExportLimits in artifact_types.py. Each cut can be triggered by
  // elapsed time or frame count; summing both gives a conservative chunk cap.
  const chunks =
    1 + Math.floor(durationSeconds / 30) + Math.floor((frames - 1) / 3000);
  const startMargin = config.startDeadlineSeconds;
  const durationMargin =
    Math.max(0, RECIPE_DEADLINE_MARGIN_SECONDS - startMargin) *
    (Math.min(durationSeconds, MAX_RECORDING_SECONDS) / MAX_RECORDING_SECONDS);
  return {
    maxOutputFiles: jobOutputFileLimit(
      config.limits.outputFileCeiling ?? config.limits.maxOutputFiles,
      chunks,
    ),
    maxOutputBytes: String(
      jobOutputByteLimit(Number(config.limits.maxOutputBytes), chunks),
    ),
    deadlineSeconds: budgetWithMargin(
      task.recipe,
      startMargin + Math.ceil(durationMargin),
    ),
  };
}

/** Deadline written once at admission: the recipe's, else the configured fallback. */
export function admissionDeadlineSeconds(
  config: Pick<JobsConfig, "executionDeadlineSeconds">,
  recipe: {
    stages: ReadonlyArray<{
      enabled: boolean;
      resources: { budgetSeconds: number };
    }>;
  } | null,
): number {
  return recipe === null
    ? config.executionDeadlineSeconds
    : recipeExecutionDeadlineSeconds(recipe);
}

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
  // PROCESSING_MAX_OUTPUT_FILES is the hard ceiling; the pinned per-job value
  // is the 2 h budget (737 files at the default), never above that ceiling.
  const ceiling = Number(env.PROCESSING_MAX_OUTPUT_FILES ?? 2000);
  if (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > 2000)
    throw new Error(
      "PROCESSING_MAX_OUTPUT_FILES must be an integer in 1..2000",
    );
  const maxOutputFiles = jobOutputFileLimit(
    ceiling,
    clipsForSeconds(MAX_RECORDING_SECONDS),
  );
  const recipeDir = localRecipeDir(env);
  const publicVideoCanary = publicVideoCanaryFromEnv(env);
  return {
    ...(recipeDir !== undefined && { localRecipeDir: recipeDir }),
    ...(publicVideoCanary ? { publicVideoCanary } : {}),
    ...(env.APP_ENV === "production" ? { production: true } : {}),
    executionBackend: backend,
    codeRevision: setting(env, "PROCESSING_CODE_REVISION", REVISION),
    imageSpecSha256: setting(env, "PROCESSING_IMAGE_SPEC_SHA256", SHA),
    modelSha256: setting(env, "PROCESSING_MODEL_SHA256", SHA),
    configSha256: setting(env, "PROCESSING_CONFIG_SHA256", SHA),
    limits: {
      maxOutputFiles,
      outputFileCeiling: ceiling,
      maxOutputBytes: "68719476736",
      maxControlDocumentBytes: 1048576,
    },
    executionDeadlineSeconds: 6 * 3600,
    startDeadlineSeconds: 600,
    leaseSeconds: 120,
    readUrlSeconds: 900,
  };
}
