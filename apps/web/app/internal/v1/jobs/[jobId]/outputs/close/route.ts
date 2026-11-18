import { jobRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobRouteHandlers();
type Ctx = { params: Promise<{ jobId: string }> };

/** POST /internal/v1/jobs/{jobId}/outputs/close: seal the output inventory (job:output). */
export async function POST(request: Request, { params }: Ctx) {
  return routes.closeOutputs(request, (await params).jobId);
}
