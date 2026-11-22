import { recordingAnnotationRouteHandlers } from "@stateaction/server/annotations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = recordingAnnotationRouteHandlers();
type Context = { params: Promise<{ recordingId: string }> };

/** GET /api/v1/recordings/{id}/annotations[?download=1]: staff annotations of the accepted job. */
export const GET = async (request: Request, { params }: Context) =>
  routes.annotations(request, (await params).recordingId);
