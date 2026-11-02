import { datasetRouteHandlers } from "@stateaction/server/datasets";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = datasetRouteHandlers();
/** GET /api/v1/clips: staff All clips catalog (customers are refused). */
export const GET = (request: Request) => routes.listClips(request);
