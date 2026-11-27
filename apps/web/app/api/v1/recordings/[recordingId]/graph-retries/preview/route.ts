import { graphRetryRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = graphRetryRouteHandlers();
type Ctx = { params: Promise<{ recordingId: string }> };

export async function POST(request: Request, { params }: Ctx) {
  return routes.preview(request, (await params).recordingId);
}
