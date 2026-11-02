import { transportRouteHandlers } from "@stateaction/server/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = transportRouteHandlers();

type Ctx = { params: Promise<{ jobId: string; fileId: string }> };
/** PUT: journal exact ETag/size receipts of this job output. */
export async function PUT(request: Request, { params }: Ctx) {
  const { jobId, fileId } = await params;
  return routes.job.receipts(request, jobId, fileId);
}
