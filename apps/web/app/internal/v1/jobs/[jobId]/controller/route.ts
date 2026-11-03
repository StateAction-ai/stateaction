import { jobRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobRouteHandlers();
type Ctx = { params: Promise<{ jobId: string }> };

/** POST /internal/v1/jobs/{jobId}/controller: workflow-controller actions (jobs:reconcile). */
export async function POST(request: Request, { params }: Ctx) {
  return routes.controller(request, (await params).jobId);
}
