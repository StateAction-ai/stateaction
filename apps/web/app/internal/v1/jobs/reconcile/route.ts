import { jobRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobRouteHandlers();

/** POST /internal/v1/jobs/reconcile: repair cron/controller admits the next queued job. */
export async function POST(request: Request) {
  return routes.reconcile(request);
}
