"use client";

import { formatMediaDuration } from "../../lib/media-duration";
import * as React from "react";
import Link from "next/link";
import type {
  ClipReview,
  ClipReviewState,
  DatasetClipView,
  DatasetView,
} from "@stateaction/contracts";
import type { ConsoleRole } from "../../lib/console-session";
import type { ClipViewerState } from "../../lib/rerun/clip-viewer";
import { registerPrivateState } from "../../lib/private-state";
import {
  draftKey,
  rebaseDraft,
  restoreDraft,
  reviewCommand,
  savedDraft,
  type ReviewDraft,
} from "../../lib/review-draft";
import { browserApi, BrowserApiError } from "../data-browser/client";
import { ClipViewer } from "../rerun/clip-viewer";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { shortRecordingId } from "@stateaction/server/pipeline-model";

const field =
  "min-h-11 w-full rounded-lg border border-line bg-white px-3 text-sm";
const messageOf = (error: unknown) =>
  error instanceof BrowserApiError
    ? error.message
    : "The request could not be completed. Try again.";

type Context = { clip: DatasetClipView; review?: ClipReviewState };
export function ClipPage({
  clipId,
  userId,
  role,
  returnTo,
  mediaOrigin,
}: {
  clipId: string;
  userId: string;
  role: ConsoleRole;
  returnTo: string;
  mediaOrigin: string | null;
}) {
  const [context, setContext] = React.useState<Context>();
  const [error, setError] = React.useState<string>();
  const [hidden, setHidden] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  const [viewer, setViewer] = React.useState<ClipViewerState>({
    phase: "idle",
  });
  const current = React.useRef(true);
  React.useEffect(() => {
    current.current = true;
    const unregister = registerPrivateState(() => {
      current.current = false;
      setHidden(true);
      setContext(undefined);
    });
    return () => {
      current.current = false;
      unregister();
    };
  }, []);
  React.useEffect(() => {
    const cancel = new AbortController();
    void (async () => {
      const [clip, review] = await Promise.all([
        browserApi<DatasetClipView>(`/api/v1/clips/${clipId}`, {
          signal: cancel.signal,
        }),
        role === "staff"
          ? browserApi<ClipReviewState>(`/api/v1/clips/${clipId}/review`, {
              signal: cancel.signal,
            })
          : undefined,
      ]);
      if (!cancel.signal.aborted && current.current) {
        setContext({ clip, ...(review ? { review } : {}) });
        setError(undefined);
      }
    })().catch((failure: unknown) => {
      if (!cancel.signal.aborted && current.current) {
        setContext(undefined);
        setError(messageOf(failure));
      }
    });
    return () => cancel.abort();
  }, [clipId, role, reload]);

  const refreshReview =
    React.useCallback(async (): Promise<ClipReviewState> => {
      const [clip, review] = await Promise.all([
        browserApi<DatasetClipView>(`/api/v1/clips/${clipId}`),
        browserApi<ClipReviewState>(`/api/v1/clips/${clipId}/review`),
      ]);
      if (!current.current) throw new Error("Session ended");
      setContext({ clip, review });
      return review;
    }, [clipId]);
  if (hidden) return null;
  return (
    <section aria-labelledby="clip-heading">
      <Link
        href={returnTo}
        className="mb-4 inline-flex min-h-11 items-center text-sm font-medium text-brand underline"
      >
        Back to Data browser
      </Link>
      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-line bg-white p-6"
        >
          <h1 id="clip-heading" className="text-2xl font-semibold">
            Clip unavailable
          </h1>
          <p>{error}</p>
          <Button
            variant="outline"
            onClick={() => {
              setError(undefined);
              setReload((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      ) : !context ? (
        <p role="status" className="flex items-center gap-2">
          <Spinner /> Loading clip…
        </p>
      ) : (
        <>
          <div className="mb-5">
            <h1
              id="clip-heading"
              className="m-0 break-words text-[32px] font-bold tracking-[-0.03em]"
            >
              {context.clip.title}
            </h1>
            {role === "staff" && context.clip.recordingId ? (
              <Link
                href={"/pipeline/" + context.clip.recordingId}
                className="mt-2 inline-block text-sm font-medium text-brand underline"
              >
                Recording {shortRecordingId(context.clip.recordingId)}
              </Link>
            ) : null}
            <p className="mt-2 text-sm text-muted">
              {formatMediaDuration(context.clip.durationNs)}{" "}
              <span className="mx-2" aria-hidden="true">
                /
              </span>
              {context.clip.raster.width} × {context.clip.raster.height}{" "}
              <span className="mx-2" aria-hidden="true">
                /
              </span>
              {context.clip.frameCount.toLocaleString()} frames
            </p>
            {context.clip.simulation ? (
              <p className="text-xs text-muted">Simulation recording</p>
            ) : null}
          </div>
          <div
            className={
              role === "staff"
                ? "grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_21rem]"
                : ""
            }
          >
            <div className="min-w-0">
              {context.clip.media.viewer ? (
                <ClipViewer
                  key={clipId}
                  clipId={clipId}
                  allowedOrigins={mediaOrigin ? [mediaOrigin] : []}
                  onStateChange={setViewer}
                />
              ) : (
                <div
                  role="status"
                  className="rounded-xl border border-line bg-white p-8 text-muted"
                >
                  The preview is unavailable for this clip.
                </div>
              )}
              {role === "staff" && context.review ? (
                <QualityChecks state={context.review} />
              ) : (
                <div className="mt-5 rounded-xl border border-line bg-white p-5">
                  <p className="m-0 text-xs font-medium text-good">Approved</p>
                  <h2 className="mb-0 mt-2 text-lg font-semibold">
                    {context.clip.taskLabel ?? "Approved clip"}
                  </h2>
                </div>
              )}
            </div>
            {role === "staff" && context.review ? (
              <ReviewEditor
                key={`${clipId}:${context.review.resultManifestSha256}`}
                userId={userId}
                state={context.review}
                mediaReady={viewer.phase === "ready"}
                refresh={refreshReview}
              />
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

const CHECK_NAMES: Record<string, string> = {
  source_accepted: "Source integrity",
  source_sha256: "Source integrity",
  decode_and_inference_once: "Video decoding and hand processing",
  frame_map_complete: "Frame mapping",
  arrays_valid: "Hand arrays",
  output_bounds: "Preview files",
  hand_detection_summary: "Hand detections",
  capture_counts: "Capture frame counts",
  native_mp4_remux: "Original video preservation",
  clip_bounds: "Clip duration and frame limits",
  proxy_rrd_bounds: "Rerun preview limits",
};
const STATUS: Record<string, string> = {
  pass: "Passed",
  warn: "Warning",
  fail: "Failed",
  measured: "Measured",
  not_evaluated: "Not evaluated",
  unknown: "Unknown",
};
const MEASUREMENTS: Record<string, [string, string][]> = {
  source_accepted: [["frames_decoded", "Decoded frames"]],
  decode_and_inference_once: [
    ["frames_inferred", "Processed frames"],
    ["decoder_instances", "Video decoders"],
  ],
  native_mp4_remux: [
    ["clips", "Clips"],
    ["reencoded_clips", "Original clips re-encoded"],
  ],
  clip_bounds: [
    ["ceiling_seconds", "Maximum seconds per clip"],
    ["max_frames", "Maximum frames per clip"],
  ],
  proxy_rrd_bounds: [
    ["proxy_max_width", "Maximum preview width"],
    ["proxy_max_height", "Maximum preview height"],
  ],
  hand_detection_summary: [
    ["frames", "Total frames"],
    ["frames_no_hand", "Frames without hands"],
    ["frames_one_hand", "Frames with one hand"],
    ["frames_two_hands", "Frames with two hands"],
  ],
};
function checkMeasurements(id: string, measurements: unknown): string[] {
  if (
    !measurements ||
    typeof measurements !== "object" ||
    Array.isArray(measurements)
  )
    return [];
  const values = measurements as Record<string, unknown>;
  return (MEASUREMENTS[id] ?? []).flatMap(([key, label]) => {
    const value = values[key];
    return typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value)
      ? [`${label}: ${BigInt(value).toLocaleString()}`]
      : [];
  });
}
function QualityChecks({ state }: { state: ClipReviewState }) {
  const checks = state.qualityChecks;
  return (
    <section
      aria-labelledby="quality-heading"
      className="mt-6 rounded-xl border border-line bg-white p-5"
    >
      <h2 id="quality-heading" className="m-0 text-lg font-semibold">
        Automatic quality checks
      </h2>
      {checks.status === "not_evaluated" ? (
        <p className="text-sm text-muted">
          These checks have not been evaluated for this result.
        </p>
      ) : (
        <ul className="m-0 mt-3 list-none divide-y divide-line p-0">
          {checks.checks.map((check, i) => (
            <li key={`${check.id}:${i}`} className="py-3 text-sm">
              <div className="flex items-start justify-between gap-4">
                <span>
                  {CHECK_NAMES[check.id] ?? "Additional processing check"}
                </span>
                <span
                  className={`shrink-0 font-medium ${check.status === "fail" ? "text-danger" : check.status === "pass" ? "text-good" : "text-muted"}`}
                >
                  {STATUS[check.status] ?? "Unknown"}
                </span>
              </div>
              {checkMeasurements(check.id, check.measurements).map((detail) => (
                <p key={detail} className="mb-0 mt-1 text-xs text-muted">
                  {detail}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
      <p className="mb-0 text-xs text-muted">
        Hand detection coverage measures how often hands were found. Pose
        accuracy has not been evaluated.
      </p>
    </section>
  );
}

function ReviewEditor({
  userId,
  state,
  mediaReady,
  refresh,
}: {
  userId: string;
  state: ClipReviewState;
  mediaReady: boolean;
  refresh: () => Promise<ClipReviewState>;
}) {
  const key = draftKey(userId, state.clipId, state.resultManifestSha256);
  const [draft, setDraft] = React.useState<ReviewDraft>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const [storageUnavailable, setStorageUnavailable] = React.useState(false);
  const [stale, setStale] = React.useState(false);
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(key);
    } catch {
      setStorageUnavailable(true);
    }
    const restored = restoreDraft(raw, state);
    setDraft(restored ?? savedDraft(state));
    setStale(
      Boolean(
        restored &&
          !restored.pending &&
          restored.baseRevision !== state.review.revision,
      ),
    );
    const unregister = registerPrivateState(() => {
      alive.current = false;
      setDraft(undefined);
    });
    return () => {
      alive.current = false;
      unregister();
    };
  }, [key]);
  React.useEffect(() => {
    if (draft)
      try {
        sessionStorage.setItem(key, JSON.stringify(draft));
      } catch {
        setStorageUnavailable(true);
      }
  }, [key, draft]);
  const persist = (next: ReviewDraft) => {
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
    } catch {
      setStorageUnavailable(true);
    }
    setDraft(next);
  };
  const resetToSaved = (next: ClipReviewState) => {
    try {
      sessionStorage.removeItem(key);
    } catch {}
    setDraft(savedDraft(next));
    setStale(false);
  };
  const submit = async (decision: "approved" | "rejected") => {
    if (!draft || busy) return;
    setError(undefined);
    setNotice(undefined);
    let command;
    try {
      command = reviewCommand(draft, decision, crypto.randomUUID(), state);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Review is unavailable.",
      );
      return;
    }
    persist({ ...draft, pending: command });
    setBusy(true);
    try {
      await browserApi<ClipReview>(`/api/v1/clips/${state.clipId}/review`, {
        method: "POST",
        body: command,
      });
      if (!alive.current) return;
      const next = await refresh();
      if (!alive.current) return;
      resetToSaved(next);
      setNotice("Review saved.");
    } catch (failure) {
      if (!alive.current) return;
      if (
        failure instanceof BrowserApiError &&
        [400, 401, 403, 404, 409, 422].includes(failure.status)
      ) {
        const { pending: _pending, ...editable } = draft;
        persist(editable);
        setStale(failure.status === 409);
        setError(
          failure.status === 409
            ? "The review or dataset changed. Reload the saved review; your draft will be kept."
            : messageOf(failure),
        );
      } else
        setError(
          "The save could not be confirmed. Retry uses the same request to check its result.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  if (!draft) return null;
  const blocked = busy || Boolean(draft.pending);
  const canReview = state.current && state.capabilities.canReview;
  return (
    <aside
      aria-labelledby="review-heading"
      className="rounded-xl border border-line bg-white p-5"
    >
      <h2 id="review-heading" className="m-0 text-xl font-semibold">
        Review clip
      </h2>
      <p className="mb-0 mt-2 text-xs font-medium text-muted">
        {state.review.decision === "approved"
          ? "Approved"
          : state.review.decision === "rejected"
            ? "Rejected"
            : "Not reviewed"}
      </p>
      <p className="mt-2 mb-3 text-sm text-muted">
        {state.review.decision === null
          ? "Watch the clip and enter a task label before submitting your review."
          : "You can update the task label or review decision."}
      </p>
      <label className="block text-sm font-medium" htmlFor="task-label">
        Task label
        <input
          id="task-label"
          name="taskLabel"
          maxLength={200}
          value={draft.taskLabel}
          disabled={blocked || !canReview}
          onChange={(event) =>
            setDraft({ ...draft, taskLabel: event.target.value })
          }
          className={`${field} mt-2`}
        />
      </label>
      <label className="mt-4 block text-sm font-medium" htmlFor="review-notes">
        Notes <span className="font-normal text-muted">(optional)</span>
        <textarea
          id="review-notes"
          name="notes"
          rows={4}
          maxLength={4000}
          value={draft.notes}
          disabled={blocked || !canReview}
          onChange={(event) =>
            setDraft({ ...draft, notes: event.target.value })
          }
          className={`${field} mt-2 py-3`}
        />
      </label>
      <DatasetSelection
        state={state}
        draft={draft}
        setDraft={setDraft}
        disabled={blocked || !canReview}
      />
      {storageUnavailable ? (
        <p className="text-xs text-muted">
          This browser cannot keep the draft after a page reload.
        </p>
      ) : (
        <p className="text-xs text-muted">
          Your draft stays in this tab until the review is saved or you sign
          out.
        </p>
      )}
      {!canReview ? (
        <p role="status" className="text-sm text-muted">
          This result is no longer available for review.
        </p>
      ) : !mediaReady ? (
        <p role="status" className="text-xs text-muted">
          Load the preview before approving this clip.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-good">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {stale ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void refresh()
              .then((next) => {
                if (!alive.current) return;
                persist(rebaseDraft(draft, next));
                setStale(false);
                setError(undefined);
                setNotice(
                  "Saved review reloaded. Check your draft before saving.",
                );
              })
              .catch((failure: unknown) => {
                if (alive.current) setError(messageOf(failure));
              })
              .finally(() => {
                if (alive.current) setBusy(false);
              });
          }}
        >
          Reload saved review
        </Button>
      ) : null}
      {draft.pending ? (
        <Button
          className="mt-4 w-full"
          disabled={busy}
          onClick={() => void submit(draft.pending!.decision)}
        >
          {busy ? "Checking save…" : "Retry save"}
        </Button>
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-3">
          <Button
            disabled={busy || stale || !canReview || !mediaReady}
            onClick={() => void submit("approved")}
          >
            Approve
          </Button>
          <Button
            variant="outline"
            className="text-danger"
            disabled={busy || stale || !canReview}
            onClick={() => void submit("rejected")}
          >
            Reject
          </Button>
        </div>
      )}
    </aside>
  );
}

function DatasetSelection({
  state,
  draft,
  setDraft,
  disabled,
}: {
  state: ClipReviewState;
  draft: ReviewDraft;
  setDraft: React.Dispatch<React.SetStateAction<ReviewDraft | undefined>>;
  disabled: boolean;
}) {
  const [options, setOptions] = React.useState(
    new Map(
      [...state.availableDatasets, ...state.memberships].map((d) => [
        d.datasetId,
        { datasetId: d.datasetId, name: d.name, revision: d.revision },
      ]),
    ),
  );
  const [error, setError] = React.useState<string>();
  const [loading, setLoading] = React.useState(false);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [results, setResults] = React.useState<string[]>();
  const latestDraft = React.useRef(draft);
  latestDraft.current = draft;
  const activeSearch = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => activeSearch.current?.abort(), []);
  React.useEffect(() => {
    activeSearch.current?.abort();
    setLoading(false);
    setResults(undefined);
    setCursor(null);
    setOptions(
      (old) =>
        new Map([
          ...[...old].filter(([id]) => draft.datasetIds.includes(id)),
          ...[...state.availableDatasets, ...state.memberships].map(
            (d) =>
              [
                d.datasetId,
                { datasetId: d.datasetId, name: d.name, revision: d.revision },
              ] as const,
          ),
        ]),
    );
  }, [state]);
  const searchDatasets = async (q: string, after?: string) => {
    activeSearch.current?.abort();
    const cancel = new AbortController();
    activeSearch.current = cancel;
    setLoading(true);
    setError(undefined);
    const query = new URLSearchParams({
      limit: "24",
      ...(q ? { q } : {}),
      ...(after ? { cursor: after } : {}),
    });
    try {
      const page = await browserApi<{
        datasets: DatasetView[];
        nextCursor: string | null;
      }>(`/api/v1/datasets?${query}`, { signal: cancel.signal });
      if (cancel.signal.aborted || activeSearch.current !== cancel) return;
      setOptions((old) => {
        const keep = new Set([
          ...latestDraft.current.datasetIds,
          ...state.memberships.map((d) => d.datasetId),
        ]);
        const retained = [...old].filter(([id]) => keep.has(id));
        const fresh = page.datasets.map((d) => {
          if (
            typeof d.revision !== "number" ||
            !Number.isSafeInteger(d.revision) ||
            d.revision < 1
          )
            throw new Error("Dataset revision unavailable");
          return [
            d.datasetId,
            { datasetId: d.datasetId, name: d.name, revision: d.revision },
          ] as const;
        });
        return new Map([...retained, ...fresh]);
      });
      setResults(page.datasets.map((d) => d.datasetId));
      setCursor(page.nextCursor);
    } catch (failure) {
      if (!cancel.signal.aborted && activeSearch.current === cancel)
        setError(messageOf(failure));
    } finally {
      if (!cancel.signal.aborted && activeSearch.current === cancel)
        setLoading(false);
    }
  };
  const rows = (results ?? [...options.keys()])
    .map((id) => options.get(id))
    .filter((d) => d !== undefined);
  return (
    <fieldset
      disabled={disabled || state.membershipsTruncated}
      className="mt-5 min-w-0 border-0 p-0"
    >
      <legend className="text-sm font-medium">
        Datasets <span className="font-normal text-muted">(optional)</span>
      </legend>
      <p className="mt-1 text-xs text-muted">
        Choose assignments to save with an approval. Selection alone changes
        nothing.
      </p>
      <p className="text-xs text-muted">{draft.datasetIds.length} selected</p>
      {state.membershipsTruncated ? (
        <p className="text-xs text-muted">
          This view cannot load all current assignments. Approval keeps them;
          rejection removes them.
        </p>
      ) : (
        <>
          <form
            className="mb-2 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const q = String(
                new FormData(event.currentTarget).get("datasetSearch") ?? "",
              ).trim();
              setSearch(q);
              void searchDatasets(q);
            }}
          >
            <label className="min-w-0 flex-1 text-xs font-medium">
              Find datasets
              <input
                name="datasetSearch"
                aria-label="Find datasets"
                maxLength={160}
                className={`${field} mt-1`}
              />
            </label>
            <Button
              variant="outline"
              type="submit"
              className="self-end"
              disabled={loading}
            >
              Find
            </Button>
          </form>
          <div className="max-h-52 overflow-y-auto rounded-lg border border-line px-3">
            {rows.map((d) => (
              <label
                key={d.datasetId}
                className="flex min-h-11 items-center gap-3 border-b border-line py-2 text-sm last:border-b-0"
              >
                <input
                  type="checkbox"
                  checked={draft.datasetIds.includes(d.datasetId)}
                  disabled={
                    !draft.datasetIds.includes(d.datasetId) &&
                    draft.datasetIds.length >= 100
                  }
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setDraft((old) => {
                      if (!old) return old;
                      const ids = checked
                        ? [...new Set([...old.datasetIds, d.datasetId])].sort()
                        : old.datasetIds.filter((id) => id !== d.datasetId);
                      const keep = new Set([
                        ...state.memberships.map((m) => m.datasetId),
                        ...ids,
                      ]);
                      const revisions = Object.fromEntries(
                        Object.entries({
                          ...old.expectedRevisions,
                          [d.datasetId]: d.revision,
                        }).filter(([id]) => keep.has(id)),
                      );
                      return {
                        ...old,
                        datasetIds: ids,
                        expectedRevisions: revisions,
                        selectionTouched: true,
                      };
                    });
                  }}
                />
                <span className="min-w-0 break-words">{d.name}</span>
              </label>
            ))}
            {!rows.length ? (
              <p className="text-xs text-muted">No datasets match.</p>
            ) : null}
          </div>
          {cursor ? (
            <Button
              variant="ghost"
              disabled={loading}
              onClick={() => void searchDatasets(search, cursor)}
            >
              Next datasets
            </Button>
          ) : state.availableDatasetsTruncated && results === undefined ? (
            <p className="text-xs text-muted">
              Use Find to search all datasets.
            </p>
          ) : null}
          {loading ? (
            <p role="status" className="text-xs text-muted">
              Finding datasets…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
        </>
      )}
    </fieldset>
  );
}
