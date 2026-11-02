import { transportRouteHandlers } from "@stateaction/server/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = transportRouteHandlers();

type Ctx = { params: Promise<{ jobId: string }> };
/** POST /internal/v1/jobs/{jobId}/outputs: worker reserves a server-keyed output slot. */
export async function POST(request: Request, { params }: Ctx) {
  return routes.job.create(request, (await params).jobId);
}
