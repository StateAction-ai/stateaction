import { authRouteHandlers } from "@stateaction/server/auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const { GET, POST } = authRouteHandlers();
