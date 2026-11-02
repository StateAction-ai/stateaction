import { transportRouteHandlers } from "@stateaction/server/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = transportRouteHandlers();

type Ctx = { params: Promise<{ jobId: string; fileId: string }> };
/** POST: cancel this job output's transport (http.upload-transition.v1). */
export async function POST(request: Request, { params }: Ctx) {
  const { jobId, fileId } = await params;
  return routes.job.cancel(request, jobId, fileId);
}
