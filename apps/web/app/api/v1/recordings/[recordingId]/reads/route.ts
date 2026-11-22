import { recordingAnnotationRouteHandlers } from "@stateaction/server/annotations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = recordingAnnotationRouteHandlers();
type Context = { params: Promise<{ recordingId: string }> };

/** POST /api/v1/recordings/{id}/reads {role: "recording_mp4"}: staff 60 s read URL of the review video. */
export const POST = async (request: Request, { params }: Context) =>
  routes.read(request, (await params).recordingId);
