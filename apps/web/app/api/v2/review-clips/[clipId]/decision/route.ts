import { reviewClipRouteHandlers } from "@stateaction/server/datasets";

export const runtime = "nodejs";
type Context = { params: Promise<{ clipId: string }> };

export async function GET(request: Request, { params }: Context) {
  return reviewClipRouteHandlers().decision(request, (await params).clipId);
}

export const POST = GET;
