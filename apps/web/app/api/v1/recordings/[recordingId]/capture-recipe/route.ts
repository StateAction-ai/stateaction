import { selectCaptureRecipe } from "@stateaction/server/recordings";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ recordingId: string }> },
) {
  return selectCaptureRecipe()(request, (await params).recordingId);
}
