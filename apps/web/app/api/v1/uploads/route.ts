import { transportRouteHandlers } from "@stateaction/server/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const routes = transportRouteHandlers();

/** POST /api/v1/uploads: reserve a source file and its provider upload. */
export const POST = (request: Request) => routes.owner.create(request);
