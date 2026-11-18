import { sourceCleanupRouteHandlers } from "@stateaction/server/source-cleanup";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = sourceCleanupRouteHandlers();
/** POST /api/v1/recordings/{recordingId}/source-copy-confirmation (staff). */
export async function POST(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  return routes.confirm(request, (await context.params).recordingId);
}
