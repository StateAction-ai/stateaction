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

/** Kinds with a real authenticated mutation: POST /api/v1/jobs/{jobId}/control (reupload is guidance). */
const WIRED = new Set([
  "cancel",
  "check_cancellation",
  "retry",
  "reconcile",
  "reupload_guidance",
] as const);

export * from "./model.js";
export {
  pipelineActionsFor,
  type PipelineDetail,
  type PipelineList,
  type PipelineListItem,
} from "./queries.js";

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
