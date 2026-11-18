import { datasetRouteHandlers } from "@stateaction/server/datasets";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = datasetRouteHandlers();
type Context = { params: Promise<{ clipId: string }> };
/** GET /api/v1/clips/{clipId}/review: staff-only review read model. */
export const GET = async (request: Request, { params }: Context) =>
  routes.getClipReview(request, (await params).clipId);
/** POST /api/v1/clips/{clipId}/review: staff-only atomic review command. */
export const POST = async (request: Request, { params }: Context) =>
  routes.commitClipReview(request, (await params).clipId);
