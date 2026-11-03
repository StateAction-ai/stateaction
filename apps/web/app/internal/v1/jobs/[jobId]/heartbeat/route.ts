import { jobRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobRouteHandlers();
type Ctx = { params: Promise<{ jobId: string }> };

/** POST /internal/v1/jobs/{jobId}/heartbeat: running worker progress (job:heartbeat). */
export async function POST(request: Request, { params }: Ctx) {
  return routes.heartbeat(request, (await params).jobId);
}
