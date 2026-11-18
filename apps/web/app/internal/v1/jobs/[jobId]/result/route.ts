import { jobRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobRouteHandlers();
type Ctx = { params: Promise<{ jobId: string }> };

/**
 * POST /internal/v1/jobs/{jobId}/result: the running worker's provisional result
 * candidate (job:result). A callback selects nothing; the API accepts a result
 * only when it holds every fact (see docs/components/output-acceptance.md).
 */
export async function POST(request: Request, { params }: Ctx) {
  return routes.result(request, (await params).jobId);
}
