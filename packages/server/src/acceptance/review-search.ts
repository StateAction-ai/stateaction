import type { Queryable } from "../catalog/catalog.js";

export type VerifiedReviewSearch = {
  segmentsSha256: string | null;
  clockDomain: string | null;
  noHandDetected: boolean;
  segments: {
    segmentId: string;
    startTsNs: string;
    text: string | null;
    label: string | null;
  }[];
};

export type PresenceSpan = { frames: number; state: string };

export function hasNoHandInterval(
  left: readonly PresenceSpan[],
  right: readonly PresenceSpan[],
): boolean {
  let l = 0;
  let r = 0;
  let leftEnd = left[l]?.frames ?? 0;
  let rightEnd = right[r]?.frames ?? 0;
  while (left[l] && right[r]) {
    if (left[l]!.state === "no_hand" && right[r]!.state === "no_hand")
      return true;
    const next = Math.min(leftEnd, rightEnd);
    if (leftEnd === next) leftEnd += left[++l]?.frames ?? 0;
    if (rightEnd === next) rightEnd += right[++r]?.frames ?? 0;
  }
  return false;
}

/** Publish only after the job and its verified manifest become accepted. */
export async function indexAcceptedReviewAnnotations(
  tx: Pick<Queryable, "query">,
  jobId: string,
  manifestSha256: string,
  search: VerifiedReviewSearch,
): Promise<void> {
  const inserted = await tx.query(
    `INSERT INTO review_result_search
       (job_id, result_manifest_sha256, segments_sha256, segments_clock_domain, no_hand_detected)
     SELECT id, result_manifest_sha256, $3, $4, $5
     FROM jobs WHERE id = $1 AND result_manifest_sha256 = $2 AND state = 'succeeded'
     ON CONFLICT (job_id) DO NOTHING`,
    [
      jobId,
      manifestSha256,
      search.segmentsSha256,
      search.clockDomain,
      search.noHandDetected,
    ],
  );
  if (!inserted.rowCount || !search.segments.length) return;
  await tx.query(
    `INSERT INTO review_caption_search
       (job_id, result_manifest_sha256, segments_sha256, segment_id, start_ts_ns, original_text, original_label)
     SELECT $1, $2, $3, s."segmentId", s."startTsNs", s.text, s.label
     FROM jsonb_to_recordset($4) s("segmentId" uuid, "startTsNs" bigint, text text, label text)`,
    [
      jobId,
      manifestSha256,
      search.segmentsSha256,
      JSON.stringify(search.segments),
    ],
  );
}
