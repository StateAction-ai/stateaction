import { notFound } from "next/navigation";
import { ViewerHarness } from "./harness";

export const dynamic = "force-dynamic";

// Test seam for the real production-built viewer. It exists only when the
// operator sets STATEACTION_VIEWER_HARNESS_ORIGIN to a loopback origin, never
// on a hosted service, and it holds no data: the clip comes from that origin.
export default function RerunViewerHarness() {
  const origin = process.env.STATEACTION_VIEWER_HARNESS_ORIGIN;
  const hosted =
    process.env.APP_ENV === "production" || process.env.RENDER === "true";
  if (hosted || !origin) notFound();
  const parsed = new URL(origin);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1")
    notFound();
  return <ViewerHarness origin={parsed.origin} />;
}
