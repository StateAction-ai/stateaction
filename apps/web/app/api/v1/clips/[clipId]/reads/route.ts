import { datasetRouteHandlers } from "@stateaction/server/datasets";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = datasetRouteHandlers();
/** POST {role}: read URL for a directly linked clip. */
export async function POST(
  request: Request,
  context: { params: Promise<{ clipId: string }> },
) {
  return routes.readClip(request, (await context.params).clipId);
}
