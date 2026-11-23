import "server-only";
import { authRuntime, type AuthRuntime } from "../auth/runtime.js";
import {
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
import type { DagRunV1, Stage } from "@stateaction/contracts";
import type { DiagnosticLink } from "./run-view.js";
import { getDagRun } from "../jobs/stages.js";
import { listJobDiagnostics } from "../jobs/diagnostics.js";
import { readRateCard, type RateCard } from "../ops/cost.js";
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
