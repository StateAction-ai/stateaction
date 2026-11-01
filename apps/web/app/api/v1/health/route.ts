import { platformHealth } from "@stateaction/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const health = await platformHealth();
  return Response.json(health, {
    status: health.status === "ok" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
