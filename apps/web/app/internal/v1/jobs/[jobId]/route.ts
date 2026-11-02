import { jobRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobRouteHandlers();
type Ctx = { params: Promise<{ jobId: string }> };

/** GET /internal/v1/jobs/{jobId}: compact job status (jobs:status). */
export async function GET(request: Request, { params }: Ctx) {
  return routes.status(request, (await params).jobId);
}
