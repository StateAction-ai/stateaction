import { recordingRouteHandlers } from "@stateaction/server/recordings";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = recordingRouteHandlers();
/** POST /api/v1/recordings: register a recording for the signed-in collector. */
export const POST = (request: Request) => routes.create(request);
