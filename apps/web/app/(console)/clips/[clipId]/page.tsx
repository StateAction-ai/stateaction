import Link from "next/link";
import { notFound } from "next/navigation";
import { CatalogError } from "@stateaction/server";
import { sharedReviewReads } from "@stateaction/server/annotations";
import {
  reviewDatasetReads,
  type ReviewDatasetSearchOptions,
} from "@stateaction/server/datasets";
import { stageReason } from "@stateaction/server/pipeline";
import { requireConsoleSession } from "../../../../lib/server-session";
import { ReviewPage } from "../../../../components/review/review-page";
import { parseBrowserQuery } from "../../../../lib/data-browser-query";
import { reviewBrowseOptions } from "../../../../lib/review-browse-options";
import type { ConsoleRole } from "../../../../lib/console-session";
import {
  loadReviewClip,
  loadReviewBundle,
  seconds,
} from "../../../../lib/review/clip-reads";
import { reviewDurationS } from "../../../../lib/review/duration";
import {
  applyCaptionOverrides,
  customerReviewModel,
} from "../../../../lib/review/effective-captions";
import { buildReviewModel } from "../../../../lib/review/model";
import { fmtClock } from "../../../../lib/review/timeline";
import { ReviewDataUnavailable } from "../../../../lib/review/types";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clip · StateAction.ai" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STAFF_DATASETS = new Set(["pending-review", "recycle-bin"]);
const reads = reviewDatasetReads();
type Query = Omit<ReviewDatasetSearchOptions, "viewerUserId">;

function context(
  raw: string | undefined,
  role: ConsoleRole,
  datasetId: string | undefined,
): {
  backHref: string;
  datasetId: string | undefined;
  filters: Query;
} {
  const staff = role === "staff";
  const fallback = {
    backHref: datasetId
      ? "/data-browser?datasetId=" + datasetId
      : "/data-browser",
    datasetId,
    filters: reviewBrowseOptions(
      { mode: "clips", ...(datasetId ? { datasetId } : {}) },
      staff,
    ).filters,
  };
  if (
    !raw ||
    raw.length > 6000 ||
    (raw !== "/data-browser" && !raw.startsWith("/data-browser?"))
  )
    return fallback;
  try {
    const url = new URL(raw, "https://stateaction.invalid");
    if (
      url.origin !== "https://stateaction.invalid" ||
      url.pathname !== "/data-browser" ||
      url.hash
    )
      return fallback;
    const search = parseBrowserQuery(url.searchParams, role);
    const matchedDataset = datasetId ?? search.datasetId;
    if (datasetId && search.datasetId !== datasetId) return fallback;
    return {
      backHref: url.pathname + url.search,
      datasetId: matchedDataset,
      filters: {
        ...reviewBrowseOptions(search, staff).filters,
        page: search.page ?? 1,
        limit: search.size ?? 12,
      },
    };
  } catch {
    return fallback;
  }
}

function href(
  clipId: string,
  scope: ReturnType<typeof context>,
  actions = false,
) {
  const query = new URLSearchParams({ returnTo: scope.backHref });
  if (scope.datasetId) query.set("datasetId", scope.datasetId);
  if (actions) query.set("panel", "review");
  return "/clips/" + clipId + "?" + query.toString();
}

async function neighbors(
  userId: string,
  clipId: string,
  scope: ReturnType<typeof context>,
) {
  if (!scope.datasetId && scope.backHref === "/data-browser")
    return {
      previousHref: null,
      nextHref: null,
      advanceHref: null,
      backLabel: "Data browser",
    };
  const { page = 1, limit = 12, ...filters } = scope.filters;
  const { datasetId } = filters;
  const load = (p: number) =>
    reads.clips(userId, { ...filters, page: p, limit });
  const [set, datasets] = await Promise.all([load(page), reads.list(userId)]);
  const index = set.items.findIndex((item) => item.clipId === clipId);
  const previousPage = index === 0 && page > 1 ? page - 1 : page;
  const nextPage =
    index >= 0 && index === set.items.length - 1 ? page + 1 : page;
  function atPage(p: number) {
    if (p === page) return scope;
    const back = new URL(scope.backHref, "https://stateaction.invalid");
    if (p === 1) back.searchParams.delete("page");
    else back.searchParams.set("page", String(p));
    return { ...scope, backHref: back.pathname + back.search };
  }
  const previous =
    index > 0
      ? set.items[index - 1]
      : previousPage < page
        ? (await load(previousPage)).items.at(-1)
        : undefined;
  const next =
    index >= 0 && index < set.items.length - 1
      ? set.items[index + 1]
      : nextPage > page && page * limit < set.filteredCount
        ? (await load(nextPage)).items[0]
        : undefined;
  const advance = next ?? previous;
  return {
    previousHref: previous ? href(previous.clipId, atPage(previousPage)) : null,
    nextHref: next ? href(next.clipId, atPage(nextPage)) : null,
    advanceHref: advance
      ? href(advance.clipId, atPage(next ? page : previousPage), true)
      : null,
    backLabel:
      datasets.find((dataset) => dataset.datasetId === datasetId)?.name ??
      "Data browser",
  };
}

export default async function ClipRoute({
  params,
  searchParams,
}: {
  params: Promise<{ clipId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleSession();
  const staff = session.role === "staff";
  const { clipId } = await params;
  if (!UUID.test(clipId)) notFound();
  const query = await searchParams;
  const one = (key: string) => {
    const value = query[key];
    return typeof value === "string" ? value : undefined;
  };
  const explicit = one("datasetId");
  if (
    explicit !== undefined &&
    !UUID.test(explicit) &&
    !(staff && STAFF_DATASETS.has(explicit))
  )
    notFound();
  const scope = context(one("returnTo"), session.role, explicit);
  const startAt = one("at");
  const secondsFromQuery =
    startAt && /^\d{1,8}(?:\.\d{1,6})?$/.test(startAt) ? Number(startAt) : null;
  const base = "/api/v2/review-clips/" + clipId;
  const userId = session.userId;

  if (!staff) {
    if (!scope.datasetId || !UUID.test(scope.datasetId)) notFound();
    try {
      const data = await sharedReviewReads()({
        viewerUserId: userId,
        clipId,
        datasetId: scope.datasetId,
      });
      if (!data) notFound();
      const { metadata, binding, annotations, chunks, overrides } = data;
      const neighbor = await neighbors(userId, clipId, scope);
      const range = binding.sourceRange;
      const originNs = range?.start_ts_ns;
      const duration = reviewDurationS(annotations, range, binding.durationNs);
      const model = customerReviewModel(
        applyCaptionOverrides(
          buildReviewModel(
            annotations,
            chunks.map((chunk) => ({
              clipId: chunk.chunkId,
              startNs: chunk.startNs,
              endNs: chunk.endNs,
            })),
            duration,
            originNs,
          ),
          overrides,
        ),
      );
      const shared =
        "/api/v2/datasets/" + scope.datasetId + "/review-clips/" + clipId;
      const pin = "?selection=" + binding.selectionRevision;
      return (
        <ReviewPage
          key={clipId + ":" + binding.selectionRevision}
          model={model}
          title={
            "#" + (metadata.ordinal + 1) + " " + (metadata.taskLabel ?? "Clip")
          }
          suggested={false}
          backHref={scope.backHref}
          backLabel={neighbor.backLabel}
          previousHref={neighbor.previousHref}
          nextHref={neighbor.nextHref}
          source={{
            kind: "broker",
            readPath: shared + "/video" + pin,
            readMethod: "GET",
          }}
          posterPath={
            metadata.hasPoster
              ? base + "/poster?dataset=" + scope.datasetId
              : null
          }
          handFramesPath={
            model.presence === "available"
              ? shared + "/hand-frames" + pin
              : null
          }
          startAt={secondsFromQuery}
          initialSegmentId={null}
        />
      );
    } catch (error) {
      if (error instanceof CatalogError && error.code === "not_found")
        notFound();
      throw error;
    }
  }

  const clip = await loadReviewClip(userId, clipId);
  if (!clip) notFound();
  const processingHref =
    "/recordings/" + clip.recordingId + "/clips/" + clipId + "/processing";
  const selected = clip.selectedResult;
  if (!selected || selected.selectionRevision === null)
    return (
      <Unavailable
        href={scope.backHref}
        processingHref={processingHref}
        message="The clip is still processing or has no accepted result."
      />
    );
  try {
    const [bundle, state, overrides, navigation, options] = await Promise.all([
      loadReviewBundle(userId, clip, selected),
      reads.state(userId, clipId, selected.selectionRevision),
      reads.effectiveCaptions(userId, clipId),
      neighbors(userId, clipId, scope),
      reads.clips(userId, { datasetId: "all-clips", limit: 1 }),
    ]);
    if (
      !bundle ||
      state.jobId !== selected.jobId ||
      state.resultManifestSha256 !== selected.resultManifestSha256
    )
      return (
        <Unavailable
          href={scope.backHref}
          processingHref={processingHref}
          message="The selected result changed. Reload this clip to continue."
        />
      );
    const raw = buildReviewModel(
      bundle.annotations,
      bundle.clips,
      bundle.recording.durationS,
      bundle.originNs,
    );
    const suggested = raw.cards.find(
      (card) => card.caption.state === "complete",
    )?.caption;
    const suggestedName =
      suggested?.state === "complete" ? suggested.label : null;
    const sourceStartS = seconds(clip.sourceOffsetNs) ?? 0;
    const durationS = seconds(clip.durationNs);
    const sourceEndS = durationS === null ? null : sourceStartS + durationS;
    const generated = state.review.taskLabel ?? suggestedName;
    const clipName =
      "#" +
      (clip.ordinal + 1) +
      (generated
        ? " " + generated
        : " · " +
          fmtClock(sourceStartS) +
          (sourceEndS === null ? "" : "–" + fmtClock(sourceEndS)));
    const stages = bundle.annotations.dag_run?.stages ?? [];
    const segmentation = stages.find(
      (stage) => stage.stage === "segment" && stage.state === "failed",
    );
    return (
      <ReviewPage
        key={selected.jobId + ":" + selected.selectionRevision}
        model={raw}
        title={clip.recordingTitle + " · " + clipName}
        suggested={!state.review.taskLabel && Boolean(suggestedName)}
        backHref={scope.backHref}
        backLabel={navigation.backLabel}
        previousHref={navigation.previousHref}
        nextHref={navigation.nextHref}
        source={bundle.video}
        posterPath={base + "/poster"}
        handFramesPath={
          raw.presence === "available"
            ? base + "/hand-frames?selection=" + selected.selectionRevision
            : null
        }
        startAt={secondsFromQuery}
        initialSegmentId={one("segment") ?? null}
        staff={{
          userId,
          actorName: session.name,
          state,
          annotations: bundle.annotations,
          overrides,
          labels: options.facets.labels?.map(({ label }) => label) ?? [],
          sourceStartS,
          sourceEndS,
          processingHref,
          segmentationFailure: segmentation
            ? (stageReason(segmentation.errorCode) ??
              "This stage did not finish.")
            : null,
          handPoseFailed: stages.some(
            (stage) => stage.stage === "hand_pose" && stage.state === "failed",
          ),
          pending: scope.datasetId === "pending-review",
          openActions: one("panel") === "review",
          currentHref: href(clipId, scope, true),
          advanceHref: navigation.advanceHref,
        }}
      />
    );
  } catch (error) {
    if (
      error instanceof ReviewDataUnavailable ||
      (error instanceof CatalogError && error.code === "conflict")
    )
      return (
        <Unavailable
          href={scope.backHref}
          processingHref={processingHref}
          message="Review data is unavailable. Reload this clip to try again."
        />
      );
    if (error instanceof CatalogError && error.code === "not_found") notFound();
    throw error;
  }
}

function Unavailable({
  href,
  processingHref,
  message,
}: {
  href: string;
  processingHref: string;
  message: string;
}) {
  return (
    <section className="space-y-4">
      <Link href={href} className="text-sm text-brand underline">
        ‹ Data browser
      </Link>
      <h1 className="text-xl font-bold">Clip</h1>
      <p role="status">{message}</p>
      <Link href={processingHref} className="text-sm text-brand underline">
        Clip processing
      </Link>
    </section>
  );
}
