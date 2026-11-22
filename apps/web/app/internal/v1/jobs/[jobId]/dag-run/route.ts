import { jobRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobRouteHandlers();
type Ctx = { params: Promise<{ jobId: string }> };

/** GET /internal/v1/jobs/{jobId}/dag-run: the recorded stage runs, for the controller (workflow, jobs:status). */
export async function GET(request: Request, { params }: Ctx) {
  return routes.dagRun(request, (await params).jobId);
}
