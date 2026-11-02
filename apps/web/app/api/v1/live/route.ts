// Cheap liveness for Render's healthCheckPath: no dependency calls, so a
// transient database or R2 outage cannot restart otherwise healthy instances.
// Dependency readiness is reported separately by /api/v1/health.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json(
    { status: "ok" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
