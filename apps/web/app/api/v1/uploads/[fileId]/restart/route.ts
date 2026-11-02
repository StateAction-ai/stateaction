import { transportRouteHandlers } from "@stateaction/server/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = transportRouteHandlers();

type Ctx = { params: Promise<{ fileId: string }> };
/** POST /api/v1/uploads/{fileId}/restart (http.upload-transition.v1). */
export async function POST(request: Request, { params }: Ctx) {
  return routes.owner.restart(request, (await params).fileId);
}
