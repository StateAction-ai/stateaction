import "server-only";
import { authRuntime, type AuthRuntime } from "../auth/runtime.js";
import {
  getPipelineDetail,
  listPipelineRecordings,
  pipelineActionsFor,
  type PipelineDetail,
  type PipelineList,
} from "./queries.js";
import type { JobControlCapabilities, PipelineQuery } from "./model.js";

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
    actions: (detail: PipelineDetail, controls?: JobControlCapabilities) =>
      pipelineActionsFor(detail, controls),
  };
}
