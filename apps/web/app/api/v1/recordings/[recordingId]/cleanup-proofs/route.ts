import { sourceCleanupRouteHandlers } from "@stateaction/server/source-cleanup";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = sourceCleanupRouteHandlers();
/** POST /api/v1/recordings/{recordingId}/cleanup-proofs (original owner). */
export async function POST(
  request: Request,
  context: { params: Promise<{ recordingId: string }> },
) {
  return routes.issueProof(request, (await context.params).recordingId);
}
