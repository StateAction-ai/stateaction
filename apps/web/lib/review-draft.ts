import type {
  ClipReviewCommand,
  ClipReviewState,
} from "@stateaction/contracts";
import type { ConsoleRole } from "./console-session";
import { browserHref, parseBrowserQuery } from "./data-browser-query.ts";

export type ReviewDraft = {
  version: 1;
  clipId: string;
  jobId: string;
  resultManifestSha256: string;
  baseRevision: number;
  taskLabel: string;
  notes: string;
  datasetIds: string[];
  expectedRevisions: Record<string, number>;
  selectionTouched: boolean;
  pending?: ClipReviewCommand;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keysAre = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const revisionsValid = (value: unknown): value is Record<string, number> =>
  object(value) &&
  Object.keys(value).length <= 200 &&
  Object.entries(value).every(
    ([id, revision]) =>
      UUID.test(id) && Number.isSafeInteger(revision) && Number(revision) >= 1,
  );
export const draftKey = (
  userId: string,
  clipId: string,
  digest: string,
  selectionRevision?: number,
) =>
  `sa:review:${encodeURIComponent(userId)}:${clipId}:${digest}` +
  (selectionRevision === undefined ? "" : ":" + selectionRevision);

export function clipReturnTo(
  raw: string | undefined,
  role: ConsoleRole,
): string {
  const fallback =
    role === "staff" ? "/data-browser?view=clips" : "/data-browser";
  // Canonical percent-encoded Unicode filters can exceed the decoded field sizes.
  if (
    !raw ||
    raw.length > 6000 ||
    (!raw.startsWith("/data-browser?") && raw !== "/data-browser")
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
    return browserHref(parseBrowserQuery(url.searchParams, role));
  } catch {
    return fallback;
  }
}

export function savedDraft(state: ClipReviewState): ReviewDraft {
  const revisions: Record<string, number> = {};
  for (const d of state.memberships) revisions[d.datasetId] = d.revision;
  return {
    version: 1,
    clipId: state.clipId,
    jobId: state.jobId,
    resultManifestSha256: state.resultManifestSha256,
    baseRevision: state.review.revision,
    taskLabel: state.review.taskLabel ?? "",
    notes: state.review.notes ?? "",
    datasetIds:
      state.review.decision === "approved"
        ? state.memberships.map((d) => d.datasetId).sort()
        : [],
    expectedRevisions: revisions,
    selectionTouched: false,
  };
}

/** A tab draft belongs to one exact user/clip/result key; never adopt an old job's edits or command. */
export function restoreDraft(
  raw: string | null,
  state: ClipReviewState,
): ReviewDraft | null {
  if (!raw || raw.length > 64 * 1024) return null;
  try {
    const d = JSON.parse(raw) as ReviewDraft;
    if (
      !object(d) ||
      !keysAre(d, [
        "version",
        "clipId",
        "jobId",
        "resultManifestSha256",
        "baseRevision",
        "taskLabel",
        "notes",
        "datasetIds",
        "expectedRevisions",
        "selectionTouched",
        "pending",
      ]) ||
      d.version !== 1 ||
      d.clipId !== state.clipId ||
      d.jobId !== state.jobId ||
      d.resultManifestSha256 !== state.resultManifestSha256 ||
      !UUID.test(d.clipId) ||
      !UUID.test(d.jobId) ||
      !SHA.test(d.resultManifestSha256) ||
      !Number.isSafeInteger(d.baseRevision) ||
      d.baseRevision < 0 ||
      typeof d.taskLabel !== "string" ||
      d.taskLabel.length > 200 ||
      typeof d.notes !== "string" ||
      d.notes.length > 4000 ||
      typeof d.selectionTouched !== "boolean" ||
      !Array.isArray(d.datasetIds) ||
      d.datasetIds.length > 100 ||
      new Set(d.datasetIds).size !== d.datasetIds.length ||
      d.datasetIds.some((id) => typeof id !== "string" || !UUID.test(id)) ||
      !revisionsValid(d.expectedRevisions)
    )
      return null;
    if (Object.hasOwn(d, "pending")) {
      const p = d.pending;
      if (
        !object(p) ||
        !keysAre(p, [
          "reviewId",
          "jobId",
          "resultManifestSha256",
          "expectedReviewRevision",
          "decision",
          "taskLabel",
          "notes",
          "datasetSelection",
        ]) ||
        typeof p.reviewId !== "string" ||
        !UUID.test(p.reviewId) ||
        p.jobId !== d.jobId ||
        p.resultManifestSha256 !== d.resultManifestSha256 ||
        p.expectedReviewRevision !== d.baseRevision ||
        !["approved", "rejected"].includes(p.decision) ||
        p.taskLabel !== d.taskLabel ||
        p.notes !== d.notes
      )
        return null;
      const needsSelection = p.decision === "approved" && d.selectionTouched;
      if (Object.hasOwn(p, "datasetSelection") !== needsSelection) return null;
      if (needsSelection) {
        const selection = p.datasetSelection;
        if (
          !object(selection) ||
          !keysAre(selection, ["datasetIds", "expectedRevisions"]) ||
          !Array.isArray(selection.datasetIds) ||
          selection.datasetIds.length > 100 ||
          new Set(selection.datasetIds).size !== selection.datasetIds.length ||
          selection.datasetIds.some(
            (id) => typeof id !== "string" || !UUID.test(id),
          ) ||
          !revisionsValid(selection.expectedRevisions) ||
          JSON.stringify([...selection.datasetIds].sort()) !==
            JSON.stringify([...d.datasetIds].sort()) ||
          Object.entries(selection.expectedRevisions).some(
            ([id, revision]) => d.expectedRevisions[id] !== revision,
          ) ||
          selection.datasetIds.some(
            (id) => !Object.hasOwn(selection.expectedRevisions, id),
          )
        )
          return null;
      }
    }
    return d;
  } catch {
    return null;
  }
}

/** Refresh known revisions without discarding edits or inventing revisions for unseen datasets. */
export function rebaseDraft(
  draft: ReviewDraft,
  state: ClipReviewState,
): ReviewDraft {
  if (
    draft.clipId !== state.clipId ||
    draft.jobId !== state.jobId ||
    draft.resultManifestSha256 !== state.resultManifestSha256
  )
    throw new Error(
      "This result changed. Open its current review before saving.",
    );
  const saved = savedDraft(state);
  const affected = new Set([
    ...state.memberships.map((d) => d.datasetId),
    ...draft.datasetIds,
  ]);
  const known = Object.fromEntries(
    [...state.availableDatasets, ...state.memberships].map((d) => [
      d.datasetId,
      d.revision,
    ]),
  );
  const expectedRevisions = Object.fromEntries(
    [...affected].flatMap((id) => {
      const revision = known[id] ?? draft.expectedRevisions[id];
      return revision === undefined ? [] : [[id, revision]];
    }),
  );
  return {
    ...saved,
    taskLabel: draft.taskLabel,
    notes: draft.notes,
    datasetIds: draft.datasetIds,
    selectionTouched: draft.selectionTouched,
    expectedRevisions,
  };
}

export function reviewCommand(
  draft: ReviewDraft,
  decision: "approved" | "rejected",
  reviewId: string,
  state: ClipReviewState,
): ClipReviewCommand {
  if (draft.pending) return draft.pending;
  if (
    draft.clipId !== state.clipId ||
    draft.jobId !== state.jobId ||
    draft.resultManifestSha256 !== state.resultManifestSha256 ||
    !state.current ||
    !state.capabilities.canReview
  )
    throw new Error("This result is no longer available for review.");
  if (decision === "approved" && !draft.taskLabel.trim())
    throw new Error("Enter a task label before approving.");
  const ids = [...new Set(draft.datasetIds)].sort();
  const affected = [
    ...new Set([...state.memberships.map((d) => d.datasetId), ...ids]),
  ].sort();
  const revisions: Record<string, number> = {};
  if (decision === "approved" && draft.selectionTouched) {
    if (state.membershipsTruncated)
      throw new Error(
        "All current assignments must be loaded before changing datasets.",
      );
    for (const id of affected) {
      const value = draft.expectedRevisions[id];
      if (value === undefined)
        throw new Error("Reload the dataset list before saving.");
      revisions[id] = value;
    }
  }
  return {
    reviewId,
    jobId: draft.jobId,
    resultManifestSha256: draft.resultManifestSha256,
    expectedReviewRevision: draft.baseRevision,
    decision,
    taskLabel: draft.taskLabel,
    notes: draft.notes,
    ...(decision === "approved" && draft.selectionTouched
      ? { datasetSelection: { datasetIds: ids, expectedRevisions: revisions } }
      : {}),
  };
}
