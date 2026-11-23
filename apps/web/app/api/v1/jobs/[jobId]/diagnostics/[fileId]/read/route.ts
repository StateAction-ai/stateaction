import { jobDiagnosticRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobDiagnosticRouteHandlers();
type Context = { params: Promise<{ jobId: string; fileId: string }> };

/** POST /api/v1/jobs/{jobId}/diagnostics/{fileId}/read: staff short-lived read URL for one diagnostic_blob. */
export const POST = async (request: Request, { params }: Context) => {
  const { jobId, fileId } = await params;
  return routes.read(request, jobId, fileId);
};
