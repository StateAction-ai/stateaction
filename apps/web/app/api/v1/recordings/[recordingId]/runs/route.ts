import { stageRerunRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = stageRerunRouteHandlers();
type Ctx = { params: Promise<{ recordingId: string }> };

export async function GET(request: Request, { params }: Ctx) {
  return routes.history(request, (await params).recordingId);
}
