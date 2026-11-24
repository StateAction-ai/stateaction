import { hostedDevMediaRoute } from "@stateaction/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ ticket: string }> },
) {
  return hostedDevMediaRoute(request, (await context.params).ticket);
}
