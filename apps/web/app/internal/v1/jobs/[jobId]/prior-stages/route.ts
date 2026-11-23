import { jobRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobRouteHandlers();
type Ctx = { params: Promise<{ jobId: string }> };

/** GET /internal/v1/jobs/{jobId}/prior-stages: earlier recipe stage runs with their files (workflow, jobs:status). */
export async function GET(request: Request, { params }: Ctx) {
  return routes.priorStages(request, (await params).jobId);
}
