import { requireRole, uuid, type Tx } from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";

export type ReviewResult = {
  jobId: string;
  resultManifestSha256: string;
  selectionRevision: number;
};

const MAX_REVISION = 2147483647;

export function revision(value: number, name: string, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum || value > MAX_REVISION)
    throw new CatalogError("invalid_request", name + " is invalid");
  return value;
}

export function digest(value: string, name: string) {
  if (!/^[0-9a-f]{64}$/.test(value))
    throw new CatalogError("invalid_request", name + " is invalid");
}

export function validateReviewResult(result: ReviewResult) {
  uuid(result.jobId, "jobId");
  digest(result.resultManifestSha256, "resultManifestSha256");
  revision(result.selectionRevision, "selectionRevision", 1);
}

export function resultParams(clipId: string, result: ReviewResult) {
  return [
    clipId,
    result.jobId,
    result.resultManifestSha256,
    result.selectionRevision,
  ] as const;
}

export async function lockStaffReview(tx: Tx, actor: string, clipId: string) {
  await tx.query("SET LOCAL lock_timeout = '5s'");
  await requireRole(tx, actor, "staff");
  await tx.query("SELECT lock_review_clip($1)", [clipId]);
}

export async function requireSelectedResult(
  tx: Tx,
  clipId: string,
  result: ReviewResult,
) {
  await tx.query("SELECT require_review_clip_result($1, $2, $3, $4)", [
    ...resultParams(clipId, result),
  ]);
}
