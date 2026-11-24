import "server-only";
import { authRuntime, type AuthRuntime } from "../auth/runtime.js";
import {
  annotationCounts,
  getPipelineDetail,
  listPipelineRecordings,
  pipelineActionsFor,
  type PipelineDetail,
  type PipelineList,
} from "./queries.js";
import {
  jobControlCapabilities,
  operatorGuidance,
  recoverySnapshot,
} from "../jobs/recovery.js";
import type { JobControlCapabilities, PipelineQuery } from "./model.js";
import { readFileSync } from "node:fs";
import type {
  DagRunV1,
  Producer,
  RecipeV1,
  Stage,
} from "@stateaction/contracts";
import type { AnnotationCounts, DiagnosticLink } from "./run-view.js";
import { getDagRun } from "../jobs/stages.js";
import { listJobDiagnostics } from "../jobs/diagnostics.js";
import { readRateCard, type RateCard } from "../ops/cost.js";
import { loadRecipeProducers } from "../annotations/annotations.js";
import { s3ObjectReader } from "../admission/object-reader.js";
import { serverConfig } from "../config.js";
import { TransportError } from "../transport/errors.js";

/** Kinds with a real authenticated mutation: POST /api/v1/jobs/{jobId}/control (reupload is guidance). */
const WIRED = new Set([
  "cancel",
  "check_cancellation",
  "retry",
  "reconcile",
  "reupload_guidance",
] as const);

export * from "./model.js";
export * from "./run-view.js";
export {
  pipelineActionsFor,
  type PipelineDetail,
  type PipelineList,
  type PipelineListItem,
} from "./queries.js";

/**
 * Operator rate card for GPU rates, read from the file named by
 * STATEACTION_OPS_RATE_CARD (the same JSON the ops report takes). Absent or
 * invalid means no rate: the UI shows "Rate unknown", never a guess.
 */
export function operatorRates(
  env: NodeJS.ProcessEnv = process.env,
): RateCard["rates"] | undefined {
  const path = env.STATEACTION_OPS_RATE_CARD;
  if (!path) return undefined;
  try {
    return readRateCard(JSON.parse(readFileSync(path, "utf8"))).rates;
  } catch {
    return undefined;
  }
}

export type RecipeVisualization = {
  recipe: RecipeV1;
  recipeSha256: string;
  recordingId: string;
  startedAt: string;
  run: DagRunV1 | null;
  acceptedCounts: AnnotationCounts;
  topology: "parallel" | "serial" | "unselected";
  closure: { closedAt: string; outcome: "succeeded" | "failed" } | null;
  producers: Partial<Record<Stage, Producer | "unavailable">>;
  unknownReasons: Partial<Record<Stage, string>>;
};

/**
 * Server-rendered Pipeline reads for Server Components. The caller must have
 * passed the staff page guard (`requireConsoleSession(["staff"])`); the
 * queries re-check the enabled staff access row for `staffUserId` in SQL
 * and read through the restricted application-role pool.
 */
export function pipelineReads(get: () => AuthRuntime = authRuntime) {
  return {
    list: (staffUserId: string, query: PipelineQuery): Promise<PipelineList> =>
      listPipelineRecordings(get().pool, staffUserId, query),
    detail: (
      staffUserId: string,
      recordingId: string,
    ): Promise<PipelineDetail | null> =>
      getPipelineDetail(get().pool, staffUserId, recordingId),
    /**
     * The job's recorded recipe run (stage runs + recipe), or null when the job
     * has no recipe. Stage runs are written by the stage runner (SA-91).
     */
    recipeRun: async (detail: PipelineDetail): Promise<DagRunV1 | null> => {
      if (!detail.jobId || !detail.hasRecipe) return null;
      try {
        return await getDagRun({ pool: get().pool }, detail.jobId);
      } catch (error) {
        if (error instanceof TransportError && error.code === "not_found")
          return null;
        throw error;
      }
    },
    recipeVisualization: async (
      staffUserId: string,
      recipeId: string,
      jobId: string,
      showRun: boolean,
    ): Promise<RecipeVisualization | null> => {
      const pool = get().pool;
      const {
        rows: [snapshot],
      } = await pool.query<{
        recipe: RecipeV1;
        recipe_sha256: string;
        recording_id: string;
        started_at: Date;
        recipe_parallel: boolean;
        submitted: boolean;
        closed_at: Date | null;
        outcome: "succeeded" | "failed" | null;
        segment_count: number | null;
        failed_window_count: number;
        caption_count: number | null;
        caption_failed_count: number | null;
      }>(
        `SELECT j.recipe, j.recipe_sha256, j.recording_id, r.started_at,
                j.recipe_parallel, j.submission_intent_at IS NOT NULL AS submitted,
                c.closed_at, c.outcome, j.segment_count, j.failed_window_count,
                j.caption_count, j.caption_failed_count
         FROM jobs j JOIN recordings r ON r.id = j.recording_id
         LEFT JOIN job_output_closures c ON c.job_id = j.id
         WHERE j.id = $2 AND j.recipe ->> 'recipeId' = $3
           AND r.deleted_at IS NULL AND catalog_has_role($1, 'staff')`,
        [staffUserId, jobId, recipeId],
      );
      if (!snapshot) return null;
      const run = showRun ? await getDagRun({ pool }, jobId) : null;
      const producers = run?.stages.some((stage) => stage.state === "succeeded")
        ? await loadRecipeProducers(
            {
              pool,
              reader: s3ObjectReader(serverConfig(), { timeoutMs: 15_000 }),
            },
            run,
          )
        : {};
      const unknownReasons: Partial<Record<Stage, string>> = {};
      if (run?.stages.some((stage) => stage.state === "submit_unknown")) {
        const { rows } = await pool.query<{
          stage: Stage;
          unknown_reason: string;
        }>(
          `SELECT stage, unknown_reason FROM job_stage_runs
           WHERE job_id = $1 AND unknown_reason IS NOT NULL`,
          [jobId],
        );
        for (const row of rows) unknownReasons[row.stage] = row.unknown_reason;
      }
      return {
        recipe: snapshot.recipe,
        recipeSha256: snapshot.recipe_sha256,
        recordingId: snapshot.recording_id,
        startedAt: snapshot.started_at.toISOString(),
        run,
        acceptedCounts: annotationCounts(snapshot),
        topology: snapshot.recipe_parallel
          ? "parallel"
          : snapshot.submitted
            ? "serial"
            : "unselected",
        closure:
          showRun && snapshot.closed_at && snapshot.outcome
            ? {
                closedAt: snapshot.closed_at.toISOString(),
                outcome: snapshot.outcome,
              }
            : null,
        producers,
        unknownReasons,
      };
    },
    /**
     * Completed diagnostic_blob files per stage, as links to the staff read
     * route (no URL is signed here). Empty when the job has none.
     */
    diagnostics: async (
      staffUserId: string,
      detail: PipelineDetail,
    ): Promise<Partial<Record<Stage, DiagnosticLink[]>>> => {
      if (!detail.jobId) return {};
      const out: Partial<Record<Stage, DiagnosticLink[]>> = {};
      for (const d of await listJobDiagnostics(
        get().pool,
        staffUserId,
        detail.jobId,
      ))
        (out[d.stage] ??= []).push({
          name: d.name,
          href: `/api/v1/jobs/${detail.jobId}/diagnostics/${d.fileId}/read`,
        });
      return out;
    },
    rates: () => operatorRates(),
    /** State-derived operator instruction for the current attempt (null when none). */
    guidance: async (detail: PipelineDetail): Promise<string | null> => {
      if (!detail.jobId) return null;
      const g = operatorGuidance(
        await recoverySnapshot(get().pool, detail.jobId),
      );
      return g.code === "none" || g.code === "superseded"
        ? null
        : g.instruction;
    },
    actions: (detail: PipelineDetail, controls?: JobControlCapabilities) =>
      pipelineActionsFor(
        detail,
        controls ?? jobControlCapabilities(get().pool, WIRED),
      ),
  };
}
