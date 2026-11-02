import { datasetRouteHandlers } from "@stateaction/server/datasets";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = datasetRouteHandlers();
type Context = { params: Promise<{ datasetId: string }> };
/** GET: approved members of one dataset (customers: granted + cleared only). */
export async function GET(request: Request, context: Context) {
  return routes.listDatasetClips(request, (await context.params).datasetId);
}
/** POST: staff add latest-approved clips. */
export async function POST(request: Request, context: Context) {
  return routes.addDatasetClips(request, (await context.params).datasetId);
}
