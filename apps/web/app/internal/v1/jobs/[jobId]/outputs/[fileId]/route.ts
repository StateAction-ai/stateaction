import { transportRouteHandlers } from "@stateaction/server/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = transportRouteHandlers();

type Ctx = { params: Promise<{ jobId: string; fileId: string }> };
/** GET: the output upload plan for this job. */
export async function GET(request: Request, { params }: Ctx) {
  const { jobId, fileId } = await params;
  return routes.job.get(request, jobId, fileId);
}
