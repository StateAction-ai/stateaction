import { requestPlatformVerification } from "@stateaction/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return requestPlatformVerification(request);
}
