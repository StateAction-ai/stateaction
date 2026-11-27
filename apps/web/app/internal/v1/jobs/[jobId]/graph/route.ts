import { jobRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = jobRouteHandlers();
type Ctx = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, { params }: Ctx) {
  return routes.graphRun(request, (await params).jobId);
}

export async function POST(request: Request, { params }: Ctx) {
  return routes.graphControl(request, (await params).jobId);
}
