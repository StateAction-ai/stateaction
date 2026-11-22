import { jobRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobRouteHandlers();

type Ctx = { params: Promise<{ jobId: string; fileId: string }> };
/** POST /internal/v1/jobs/{jobId}/outputs/{fileId}/read: the caption stage's signed read of the job's completed segments_json (job:input). */
export async function POST(request: Request, { params }: Ctx) {
  const { jobId, fileId } = await params;
  return routes.outputRead(request, jobId, fileId);
}
