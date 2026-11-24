import Link from "next/link";
import { datasets, mediaReadOrigin } from "@stateaction/server";
import { authRuntime } from "@stateaction/server/auth";
import {
  recordingTitle,
  shortRecordingId,
} from "@stateaction/server/pipeline-model";
import { notFound } from "next/navigation";
import { requireConsoleSession } from "../../../lib/server-session";
import {
  browserHref,
  parseBrowserQuery,
} from "../../../lib/data-browser-query";
import { formatMediaDuration } from "../../../lib/media-duration";
import { DataBrowser } from "../../../components/data-browser/data-browser";

export const metadata = { title: "Data browser · StateAction.ai" };
export const dynamic = "force-dynamic";

export default async function DataBrowserPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleSession();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of typeof value === "string" ? [value] : (value ?? []))
      params.append(key, item);
  }
  let query;
  try {
    query = parseBrowserQuery(params, session.role);
  } catch {
    return (
      <section>
        <h1 className="text-[32px] font-bold tracking-[-0.03em]">
          Data browser
        </h1>
        <p role="alert">
          This view is unavailable. Check the link or open your datasets.
        </p>
        <Link href="/data-browser" className="text-brand underline">
          Open datasets
        </Link>
      </section>
    );
  }
  let recordingName: string | undefined;
  if (query.recordingId) {
    const runtime = authRuntime();
    await runtime.ready();
    const { rows } = await runtime.pool.query<{ started_at: Date }>(
      "SELECT started_at FROM recordings WHERE id=$1 AND deleted_at IS NULL AND catalog_has_role($2, 'staff')",
      [query.recordingId, session.userId],
    );
    if (!rows[0]) notFound();
    recordingName =
      recordingTitle(rows[0].started_at) +
      " · " +
      shortRecordingId(query.recordingId);
  }
  let mediaOrigin: string | null = null;
  try {
    mediaOrigin = mediaReadOrigin();
  } catch {
    /* preview remains unavailable */
  }
  const reviewClips =
    session.role === "staff" && query.datasetId
      ? await datasets.listDatasetReviewClips(authRuntime().pool, {
          viewerUserId: session.userId,
          datasetId: query.datasetId,
          ...(query.reviewCursor ? { cursor: query.reviewCursor } : {}),
          ...(query.q ? { q: query.q } : {}),
          ...(query.label ? { label: query.label } : {}),
        })
      : null;
  return (
    <DataBrowser
      key={browserHref(query)}
      query={query}
      role={session.role}
      mediaOrigin={mediaOrigin}
      {...(recordingName ? { recordingName } : {})}
    >
      {reviewClips?.items.length ? (
        <section aria-labelledby="dataset-review-clips" className="mb-6">
          <h2 id="dataset-review-clips" className="mb-3 text-lg font-semibold">
            Review clips
          </h2>
          <ul className="divide-y overflow-hidden rounded-xl border border-line bg-white">
            {reviewClips.items.map((clip) => (
              <li
                key={clip.clipId}
                className="flex flex-wrap items-baseline gap-x-3 p-3 text-sm"
              >
                <Link
                  className="font-semibold text-brand underline"
                  href={"/review/clips/" + clip.clipId}
                >
                  {clip.title}
                </Link>
                <span>{clip.taskLabel}</span>
                {clip.durationNs !== null ? (
                  <span className="text-muted">
                    {formatMediaDuration(clip.durationNs)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {reviewClips.nextCursor ? (
            <Link
              className="mt-3 inline-block text-sm text-brand underline"
              href={browserHref({
                ...query,
                reviewCursor: reviewClips.nextCursor,
              })}
            >
              More review clips
            </Link>
          ) : null}
        </section>
      ) : null}
    </DataBrowser>
  );
}
