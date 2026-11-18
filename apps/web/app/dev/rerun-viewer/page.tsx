import { notFound } from "next/navigation";
import { ViewerHarness } from "./harness";

export const dynamic = "force-dynamic";

export default async function RerunViewerHarness({
  searchParams,
}: {
  searchParams: Promise<{ clips?: string; dataset?: string }>;
}) {
  const origin = process.env.STATEACTION_VIEWER_HARNESS_ORIGIN;
  if (
    !origin ||
    process.env.APP_ENV === "production" ||
    process.env.RENDER === "true"
  )
    notFound();
  const parsed = URL.parse(origin);
  if (parsed?.protocol !== "http:" || parsed.hostname !== "127.0.0.1")
    notFound();

  const { clips, dataset } = await searchParams;
  const clipIds = typeof clips === "string" ? clips.split(",") : [];
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  if (
    !clipIds.length ||
    clipIds.length > 3 ||
    clipIds.some((id) => !uuid.test(id)) ||
    (dataset !== undefined &&
      (typeof dataset !== "string" || !uuid.test(dataset)))
  )
    notFound();
  return (
    <ViewerHarness
      origin={parsed.origin}
      clipIds={clipIds}
      {...(dataset ? { datasetId: dataset } : {})}
    />
  );
}
