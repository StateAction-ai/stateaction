import { datasetRouteHandlers } from "@stateaction/server/datasets";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = datasetRouteHandlers();
type Context = { params: Promise<{ recordingId: string; segmentId: string }> };
/** POST /api/v1/recordings/{recordingId}/segments/{segmentId}/marks: staff-only append of one mark. */
export const POST = async (request: Request, { params }: Context) => {
  const { recordingId, segmentId } = await params;
  return routes.postSegmentMark(request, recordingId, segmentId);
};
