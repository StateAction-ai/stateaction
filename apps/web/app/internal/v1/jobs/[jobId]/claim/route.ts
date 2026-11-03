import { jobRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobRouteHandlers();
type Ctx = { params: Promise<{ jobId: string }> };

/** POST /internal/v1/jobs/{jobId}/claim: physical worker claim with the private bootstrap capability. */
export async function POST(request: Request, { params }: Ctx) {
  return routes.claim(request, (await params).jobId);
}
