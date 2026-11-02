import { transportRouteHandlers } from "@stateaction/server/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = transportRouteHandlers();

type Ctx = { params: Promise<{ fileId: string }> };
/** GET /api/v1/uploads/{fileId}: the frozen plan (owner session). */
export async function GET(request: Request, { params }: Ctx) {
  return routes.owner.get(request, (await params).fileId);
}
