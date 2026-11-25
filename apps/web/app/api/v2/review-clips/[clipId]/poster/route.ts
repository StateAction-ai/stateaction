import { reviewClipRouteHandlers } from "@stateaction/server/datasets";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ clipId: string }> },
) {
  return reviewClipRouteHandlers().poster(request, (await params).clipId);
}
