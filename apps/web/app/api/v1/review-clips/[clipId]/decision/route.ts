import { datasetRouteHandlers } from "@stateaction/server/datasets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = datasetRouteHandlers();
type Context = { params: Promise<{ clipId: string }> };

export const GET = async (request: Request, { params }: Context) =>
  routes.getReviewClipDecision(request, (await params).clipId);

export const POST = async (request: Request, { params }: Context) =>
  routes.commitReviewClipDecision(request, (await params).clipId);
