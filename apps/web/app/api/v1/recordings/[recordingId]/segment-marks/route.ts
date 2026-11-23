import { datasetRouteHandlers } from "@stateaction/server/datasets";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = datasetRouteHandlers();
type Context = { params: Promise<{ recordingId: string }> };
/** GET /api/v1/recordings/{recordingId}/segment-marks: staff-only newest mark per segment. */
export const GET = async (request: Request, { params }: Context) =>
  routes.getSegmentMarks(request, (await params).recordingId);
