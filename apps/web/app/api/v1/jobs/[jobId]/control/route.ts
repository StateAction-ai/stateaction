import { jobControlRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobControlRouteHandlers();
type Context = { params: Promise<{ jobId: string }> };

/** POST /api/v1/jobs/{jobId}/control: staff cancel / retry / reconcile (exact current job + state). */
export const POST = async (request: Request, { params }: Context) =>
  routes.control(request, (await params).jobId);
