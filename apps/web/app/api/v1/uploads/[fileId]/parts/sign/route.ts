import { transportRouteHandlers } from "@stateaction/server/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = transportRouteHandlers();

type Ctx = { params: Promise<{ fileId: string }> };
/** POST /api/v1/uploads/{fileId}/parts/sign: presign at most 32 parts. */
export async function POST(request: Request, { params }: Ctx) {
  return routes.owner.sign(request, (await params).fileId);
}
