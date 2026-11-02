import type { ReconcileResult } from "@stateaction/contracts";
import type { JobsApi } from "./api-client.js";

/**
 * Finite repair entrypoint. One bounded API call, then exit. It holds only a
 * repair-scoped API capability: no database, Render-start or Modal credential.
 * The API owns admission, recovery and the Render task start. There is
 * deliberately no retry here: the next minute run repeats the same idempotent
 * pass, so a failure surfaces as a non-zero exit instead of a hidden loop.
 */
export const REPAIR_TIMEOUT_MS = 55_000;

export type RepairSummary = {
  admission: ReconcileResult["admission"]["state"];
  pendingDispatches: number;
};

export async function repairOnce(
  api: Pick<JobsApi, "reconcile">,
): Promise<RepairSummary> {
  const result = await api.reconcile();
  return {
    admission: result.admission.state,
    pendingDispatches: result.pendingDispatches.length,
  };
}
