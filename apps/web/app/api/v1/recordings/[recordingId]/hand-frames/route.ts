import { recordingAnnotationRouteHandlers } from "@stateaction/server/annotations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = recordingAnnotationRouteHandlers();
type Context = { params: Promise<{ recordingId: string }> };

export const GET = async (request: Request, { params }: Context) =>
  routes.handFrames(request, (await params).recordingId);
