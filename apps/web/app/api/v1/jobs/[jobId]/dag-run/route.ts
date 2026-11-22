import { jobDagRunRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobDagRunRouteHandlers();
type Context = { params: Promise<{ jobId: string }> };

/** GET /api/v1/jobs/{jobId}/dag-run: staff recipe-run view (http.dag-run.v1). */
export const GET = async (request: Request, { params }: Context) =>
  routes.dagRun(request, (await params).jobId);
