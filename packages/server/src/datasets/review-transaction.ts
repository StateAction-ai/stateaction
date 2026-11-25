import {
  bumpDataset,
  inTransaction,
  lockDatasets,
  MAX_BATCH,
  sortedUnique,
  TS,
  uuid,
  type Queryable,
} from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";
import {
  lockStaffReview,
  requireSelectedResult,
  resultParams,
  revision,
  validateReviewResult,
  type ReviewResult,
} from "./review-result.js";

export type ReviewDecisionV2 = "approved" | "rejected" | "reopened";
export type ClipReviewCommandV2 = ReviewResult & {
  commandId: string;
  expectedReviewRevision: number;
} & (
    | {
        action: "add";
        taskLabel: string;
        notes?: string;
        datasetRevisions: Record<string, number>;
      }
    | { action: "remove"; datasetId: string; expectedDatasetRevision: number }
    | { action: "reject"; reason: string }
    | { action: "restore" }
    | { action: "undo"; targetCommandId: string }
  );

type Decision = {
  revision: number;
  decision: ReviewDecisionV2;
  taskLabel: string | null;
  notes: string | null;
  reviewedAt: string;
};

export type ClipReviewReceipt = {
  reviewRevision: number;
  review: Decision | null;
  added: string[];
  removed: string[];
  datasetRevisions: Record<string, number>;
  replayed: boolean;
};

type DecisionRow = {
  revision: number;
  decision: ReviewDecisionV2;
  task_label: string | null;
  notes: string | null;
  at: string;
};

const columns =
  "revision, decision, task_label, notes, " +
  TS.replace("%s", "created_at") +
  " AS at";
const decisionOf = (row: DecisionRow): Decision => ({
  revision: row.revision,
  decision: row.decision,
  taskLabel: row.task_label,
  notes: row.notes,
  reviewedAt: row.at,
});

type Prior = {
  actor_user_id: string;
  clip_id: string;
  matches: boolean;
  response: ClipReviewReceipt;
  request: ClipReviewCommandV2;
};

const invalid = (message: string) =>
  new CatalogError("invalid_request", message);
const stale = (message: string) => new CatalogError("conflict", message);

function reviewText(value: string, max: number, field: string): string {
  const trimmed = value.trim();
  if ([...trimmed].length > max || trimmed.includes("\0"))
    throw invalid(field + " is invalid");
  return trimmed;
}

function validateCommand(c: ClipReviewCommandV2) {
  uuid(c.commandId, "commandId");
  validateReviewResult(c);
  revision(c.expectedReviewRevision, "expectedReviewRevision");
  switch (c.action) {
    case "add": {
      const datasets = sortedUnique(
        Object.keys(c.datasetRevisions),
        "datasetRevisions",
        MAX_BATCH,
      );
      if (datasets.length === 0 || !reviewText(c.taskLabel, 200, "taskLabel"))
        throw invalid(
          "An approval requires a task label and at least one dataset",
        );
      if (c.notes !== undefined) reviewText(c.notes, 4000, "notes");
      for (const id of datasets)
        revision(c.datasetRevisions[id]!, "dataset revision", 1);
      break;
    }
    case "remove":
      uuid(c.datasetId, "datasetId");
      revision(c.expectedDatasetRevision, "expectedDatasetRevision", 1);
      break;
    case "reject":
      if (!reviewText(c.reason, 4000, "reason"))
        throw invalid("Rejection requires a reason");
      break;
    case "restore":
      break;
    case "undo":
      uuid(c.targetCommandId, "targetCommandId");
      break;
    default:
      throw invalid("Unknown review action");
  }
}

/** Review and membership changes share the selected clip lock and dataset lock order. */
export async function commitClipReviewV2(
  pool: Queryable,
  {
    clipId,
    reviewerUserId,
    command: c,
  }: { clipId: string; reviewerUserId: string; command: ClipReviewCommandV2 },
): Promise<ClipReviewReceipt> {
  uuid(clipId, "clipId");
  validateCommand(c);
  const request = JSON.stringify(c);
  return inTransaction(pool, async (tx) => {
    await lockStaffReview(tx, reviewerUserId, clipId);
    const prior = (
      await tx.query<Prior>(
        "SELECT actor_user_id, clip_id, response, request, request = $2::jsonb AS matches FROM review_clip_commands WHERE id = $1",
        [c.commandId, request],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.clip_id !== clipId ||
        prior.actor_user_id !== reviewerUserId ||
        !prior.matches
      )
        throw new CatalogError(
          "idempotency_conflict",
          "commandId already identifies a different request",
        );
      return { ...prior.response, replayed: true };
    }
    await requireSelectedResult(tx, clipId, c);
    const pin = [...resultParams(clipId, c)];
    const identity =
      "clip_id = $1 AND job_id = $2 AND result_manifest_sha256 = $3 AND selection_revision = $4";
    const latest = (
      await tx.query<{ revision: number }>(
        "SELECT coalesce(max(revision), 0) AS revision FROM review_clip_decisions WHERE clip_id = $1",
        [clipId],
      )
    ).rows[0]!.revision;
    if (latest !== c.expectedReviewRevision)
      throw stale("Stale review revision");
    const history = (
      await tx.query<DecisionRow>(
        "SELECT " +
          columns +
          " FROM review_clip_decisions WHERE " +
          identity +
          " ORDER BY revision DESC LIMIT 2",
        pin,
      )
    ).rows;
    const current = history[0];
    const members = new Set(
      (
        await tx.query<{ dataset_id: string }>(
          "SELECT dataset_id FROM dataset_review_clips WHERE " +
            identity +
            " ORDER BY dataset_id",
          pin,
        )
      ).rows.map((row) => row.dataset_id),
    );

    let next: Pick<Decision, "decision" | "taskLabel" | "notes"> | undefined;
    let toAdd: string[] = [];
    let toRemove: string[] = [];
    let expected: Record<string, number> | undefined;
    let restoreAssignments: string | undefined;
    switch (c.action) {
      case "add":
        if (current?.decision === "rejected")
          throw stale("Restore the rejected clip before adding it");
        next = {
          decision: "approved",
          taskLabel: c.taskLabel.trim(),
          notes: c.notes?.trim() || null,
        };
        expected = c.datasetRevisions;
        toAdd = Object.keys(expected)
          .filter((id) => !members.has(id))
          .sort();
        break;
      case "remove":
        if (
          !(
            await tx.query(
              "SELECT 1 FROM dataset_review_clips WHERE clip_id = $1 AND dataset_id = $2 LIMIT 1",
              [clipId, c.datasetId],
            )
          ).rowCount
        )
          throw stale("Clip is no longer a member of this dataset");
        expected = { [c.datasetId]: c.expectedDatasetRevision };
        toRemove = [c.datasetId];
        break;
      case "reject":
        if (current?.decision === "rejected")
          throw stale("Clip is already rejected");
        next = {
          decision: "rejected",
          taskLabel: null,
          notes: c.reason.trim(),
        };
        toRemove = [...members];
        break;
      case "restore":
        if (current?.decision !== "rejected")
          throw stale("Only a rejected clip can be restored");
        next = { decision: "reopened", taskLabel: null, notes: null };
        break;
      case "undo": {
        const target = (
          await tx.query<
            Pick<Prior, "request" | "response"> & {
              replaced_assignments: string;
            }
          >(
            "SELECT request, response, replaced_assignments::text FROM review_clip_commands WHERE id = $1 AND clip_id = $2",
            [c.targetCommandId, clipId],
          )
        ).rows[0];
        if (
          !target ||
          !current ||
          target.response.reviewRevision !== current.revision ||
          target.request.selectionRevision !== c.selectionRevision ||
          (target.request.action !== "add" &&
            target.request.action !== "reject")
        )
          throw stale("This review action can no longer be undone");
        const previous = history[1];
        next = previous
          ? decisionOf(previous)
          : { decision: "reopened", taskLabel: null, notes: null };
        expected = target.response.datasetRevisions;
        toAdd = target.response.removed;
        toRemove = target.response.added;
        restoreAssignments = target.replaced_assignments;
        if (
          toAdd.some((id) => members.has(id)) ||
          toRemove.some((id) => !members.has(id))
        )
          throw stale("Dataset membership changed after this review");
        break;
      }
    }

    const changed = [...toAdd, ...toRemove].sort();
    // A label change also changes how existing memberships are displayed.
    if (
      next?.decision === "approved" &&
      next.taskLabel !== current?.task_label
    ) {
      for (const id of members) {
        if (!toRemove.includes(id) && !changed.includes(id)) changed.push(id);
      }
    }
    const affected = [...new Set([...changed, ...Object.keys(expected ?? {})])];
    const revisions = await lockDatasets(tx, affected);
    if (
      expected &&
      Object.entries(expected).some(
        ([id, value]) => revisions.get(id) !== value,
      )
    )
      throw stale("Stale dataset revision");
    if (c.action === "remove")
      await tx.query(
        "DELETE FROM dataset_review_clips WHERE clip_id = $1 AND dataset_id = $2",
        [clipId, c.datasetId],
      );
    else if (toRemove.length)
      await tx.query(
        "DELETE FROM dataset_review_clips WHERE " +
          identity +
          " AND dataset_id = ANY($5::uuid[])",
        [...pin, toRemove],
      );
    // Keep the displaced rows in the command receipt for an exact undo.
    const replacedAssignments =
      c.action === "add" && toAdd.length
        ? (
            await tx.query<{ assignments: string }>(
              `SELECT coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb)::text AS assignments
             FROM dataset_review_clips m WHERE clip_id = $1
               AND dataset_id = ANY($2::uuid[]) AND selection_revision < $3`,
              [clipId, toAdd, c.selectionRevision],
            )
          ).rows[0]!.assignments
        : "[]";
    const review = next
      ? decisionOf(
          (
            await tx.query<DecisionRow>(
              "INSERT INTO review_clip_decisions (clip_id, job_id, result_manifest_sha256, selection_revision, id, reviewer_user_id, revision, decision, task_label, notes) " +
                "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING " +
                columns,
              [
                ...pin,
                c.commandId,
                reviewerUserId,
                revision(latest + 1, "review revision", 1),
                next.decision,
                next.taskLabel,
                next.notes,
              ],
            )
          ).rows[0]!,
        )
      : current
        ? decisionOf(current)
        : null;
    if (toAdd.length)
      await tx.query(
        "INSERT INTO dataset_review_clips (clip_id, job_id, result_manifest_sha256, selection_revision, added_by, dataset_id) " +
          "SELECT $1,$2,$3,$4,$5,id FROM unnest($6::uuid[]) AS d(id) ORDER BY id",
        [...pin, reviewerUserId, toAdd],
      );
    for (const id of changed.sort()) await bumpDataset(tx, id, reviewerUserId);
    const response: ClipReviewReceipt = {
      reviewRevision: next ? latest + 1 : latest,
      review,
      added: toAdd,
      removed: toRemove,
      datasetRevisions: Object.fromEntries(
        changed.map((id) => [id, revisions.get(id)! + 1]),
      ),
      replayed: false,
    };
    const recorded = await tx.query(
      "INSERT INTO review_clip_commands (id, clip_id, actor_user_id, request, response, replaced_assignments) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING",
      [
        c.commandId,
        clipId,
        reviewerUserId,
        request,
        JSON.stringify(response),
        replacedAssignments,
      ],
    );
    if (!recorded.rowCount)
      throw new CatalogError(
        "idempotency_conflict",
        "commandId already identifies a different request",
      );
    if (restoreAssignments && restoreAssignments !== "[]")
      await tx.query(
        "INSERT INTO dataset_review_clips SELECT * FROM jsonb_populate_recordset(NULL::dataset_review_clips, $1)",
        [restoreAssignments],
      );
    return response;
  });
}
