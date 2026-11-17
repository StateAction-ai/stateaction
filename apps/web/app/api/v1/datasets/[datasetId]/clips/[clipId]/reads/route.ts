import { datasetRouteHandlers } from "@stateaction/server/datasets";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = datasetRouteHandlers();
/** POST {role}: short-lived read URL for the clip's thumbnail or viewer RRD. */
export async function POST(
  request: Request,
  context: { params: Promise<{ datasetId: string; clipId: string }> },
) {
  const { datasetId, clipId } = await context.params;
  return routes.readDatasetClip(request, datasetId, clipId);
}
