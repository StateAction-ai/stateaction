import { reviewBrowseRoutes } from "@stateaction/server/review-browse";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ clipId: string }> },
) {
  const { clipId } = await context.params;
  return reviewBrowseRoutes().picker(request, clipId);
}
