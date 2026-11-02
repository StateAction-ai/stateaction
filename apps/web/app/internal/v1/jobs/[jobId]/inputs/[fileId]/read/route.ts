import { jobRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobRouteHandlers();

type Ctx = { params: Promise<{ jobId: string; fileId: string }> };
/** POST /internal/v1/jobs/{jobId}/inputs/{fileId}/read: fresh signed source read URL (job:input). */
export async function POST(request: Request, { params }: Ctx) {
  const { jobId, fileId } = await params;
  return routes.inputRead(request, jobId, fileId);
}
