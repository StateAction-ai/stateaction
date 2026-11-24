import { stageRerunRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = stageRerunRouteHandlers();
type Ctx = { params: Promise<{ recordingId: string }> };

export async function POST(request: Request, { params }: Ctx) {
  return routes.plan(request, (await params).recordingId);
}
