import { jobRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobRouteHandlers();
type Ctx = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, { params }: Ctx) {
  return routes.prepareRerun(request, (await params).jobId);
}
