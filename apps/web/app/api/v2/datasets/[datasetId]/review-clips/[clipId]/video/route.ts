import { reviewClipRouteHandlers } from "@stateaction/server/datasets";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ clipId: string; datasetId: string }> },
) {
  const { clipId, datasetId } = await params;
  return reviewClipRouteHandlers().video(request, clipId, datasetId);
}
