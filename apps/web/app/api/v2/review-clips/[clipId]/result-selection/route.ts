import { reviewClipRouteHandlers } from "@stateaction/server/datasets";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ clipId: string }> },
) {
  return reviewClipRouteHandlers().select(request, (await params).clipId);
}
