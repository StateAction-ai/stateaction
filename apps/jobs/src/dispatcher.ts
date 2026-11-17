import { Render } from "@renderinc/sdk";
import type { ReconcileResult } from "@stateaction/contracts";
import type { JobsApi } from "./api-client.js";
import { taskSlug } from "./config.js";

export type Dispatched = { jobId: string; taskRunId: string };

/**
 * One bounded dispatch pass: SA-25 admission is serialized by the server; this
 * only (re)starts the Render task for admitted jobs with the fixed
 * idempotency key `job:{jobId}`. Starting twice with the same key is the
 * documented retry path; the controller records the run and owns the lease.
 */
export async function dispatchOnce(
  api: Pick<JobsApi, "reconcile">,
  render: Pick<Render["workflows"], "startTask"> = new Render().workflows,
  slug: string = taskSlug(),
): Promise<{
  admission: ReconcileResult["admission"];
  dispatched: Dispatched[];
}> {
  const result = await api.reconcile();
  const dispatched: Dispatched[] = [];
  for (const pending of result.pendingDispatches) {
    const run = await render.startTask(slug, [{ jobId: pending.jobId }], {
      idempotencyKey: pending.dispatchKey,
      signal: AbortSignal.timeout(10_000),
    });
    dispatched.push({ jobId: pending.jobId, taskRunId: run.taskRunId });
  }
  return { admission: result.admission, dispatched };
}
