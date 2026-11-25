import { reviewClipRouteHandlers } from "@stateaction/server/datasets";

export const runtime = "nodejs";
type Context = { params: Promise<{ clipId: string; segmentId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { clipId, segmentId } = await params;
  return reviewClipRouteHandlers().caption(request, clipId, segmentId);
}

export const POST = GET;
