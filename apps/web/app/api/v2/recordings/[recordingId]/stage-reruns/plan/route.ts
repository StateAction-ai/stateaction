import { stageRerunRouteHandlers } from "@stateaction/server/jobs";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ recordingId: string }> },
) {
  return stageRerunRouteHandlers().planV2(request, (await params).recordingId);
}
