import { datasetRouteHandlers } from "@stateaction/server/datasets";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = datasetRouteHandlers();
type Context = { params: Promise<{ datasetId: string; clipId: string }> };
export async function GET(request: Request, context: Context) {
  const { datasetId, clipId } = await context.params;
  return routes.getDatasetClip(request, datasetId, clipId);
}
/** DELETE ?expectedRevision=N: staff remove a member. */
export async function DELETE(request: Request, context: Context) {
  const { datasetId, clipId } = await context.params;
  return routes.removeDatasetClip(request, datasetId, clipId);
}
