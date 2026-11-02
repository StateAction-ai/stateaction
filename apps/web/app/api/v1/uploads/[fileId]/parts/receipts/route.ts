import { transportRouteHandlers } from "@stateaction/server/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = transportRouteHandlers();

type Ctx = { params: Promise<{ fileId: string }> };
/** PUT /api/v1/uploads/{fileId}/parts/receipts: journal exact ETag/size receipts. */
export async function PUT(request: Request, { params }: Ctx) {
  return routes.owner.receipts(request, (await params).fileId);
}
