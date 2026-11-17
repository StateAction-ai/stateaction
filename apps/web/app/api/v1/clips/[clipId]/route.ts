import { datasetRouteHandlers } from "@stateaction/server/datasets";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = datasetRouteHandlers();
/** GET: direct clip link, authorized through a currently granted dataset. */
export async function GET(
  request: Request,
  context: { params: Promise<{ clipId: string }> },
) {
  return routes.getClip(request, (await context.params).clipId);
}
