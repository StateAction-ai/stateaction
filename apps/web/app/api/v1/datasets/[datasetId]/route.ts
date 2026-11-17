import { datasetRouteHandlers } from "@stateaction/server/datasets";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = datasetRouteHandlers();
type Context = { params: Promise<{ datasetId: string }> };
export async function GET(request: Request, context: Context) {
  return routes.getDataset(request, (await context.params).datasetId);
}
/** PATCH /api/v1/datasets/{datasetId}: staff rename with expectedRevision. */
export async function PATCH(request: Request, context: Context) {
  return routes.renameDataset(request, (await context.params).datasetId);
}
