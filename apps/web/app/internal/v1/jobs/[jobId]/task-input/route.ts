import { jobRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobRouteHandlers();
type Ctx = { params: Promise<{ jobId: string }> };

/** GET /internal/v1/jobs/{jobId}/task-input: admitted task input of the claimed job (job:input). */
export async function GET(request: Request, { params }: Ctx) {
  return routes.taskInput(request, (await params).jobId);
}
