import { recordingRouteHandlers } from "@stateaction/server/recordings";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = recordingRouteHandlers();
/** GET /api/v1/recordings/{recordingId}: the owner's recording only. */
export async function GET(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  return routes.get(request, (await context.params).recordingId);
}
