import { recordingRouteHandlers } from "@stateaction/server/recordings";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = recordingRouteHandlers();
/** POST /api/v1/recordings/{recordingId}/seal: freeze the source inventory. */
export async function POST(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  return routes.seal(request, (await context.params).recordingId);
}
