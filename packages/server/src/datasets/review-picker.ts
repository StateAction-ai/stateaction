import { sortedUnique, uuid, type Queryable } from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";

type PickerDataset = {
  datasetId: string;
  name: string;
  revision: number;
  member: boolean;
  shared: boolean;
};

export async function searchReviewPickerDatasets(
  pool: Queryable,
  input: { viewerUserId: string; clipId: string; q: string; ids: string[] },
) {
  const clipId = uuid(input.clipId, "clipId");
  const q = input.q.trim();
  if (input.q.length > 120 || /[\u0000-\u001f\u007f]/.test(input.q))
    throw new CatalogError("invalid_request", "Invalid dataset name search");
  const ids = sortedUnique(input.ids, "ids", 100);
  const {
    rows: [row],
  } = await pool.query<{
    matches: PickerDataset[];
    saved: PickerDataset[];
    exactMatch: boolean;
  }>(
    `WITH binding AS (
      SELECT c.id, j.id AS job_id, j.result_manifest_sha256, selection.seq
      FROM review_clips c
      JOIN recordings r ON r.id = c.recording_id AND r.deleted_at IS NULL
      JOIN jobs j ON j.id = c.selected_job_id AND j.clip_id = c.id AND j.state = 'succeeded'
        AND j.result_manifest_sha256 IS NOT NULL
      JOIN LATERAL (
        SELECT seq, job_id FROM clip_result_selections WHERE clip_id = c.id
        ORDER BY seq DESC LIMIT 1
      ) selection ON selection.job_id = j.id
      WHERE c.id = $2 AND catalog_has_role($1, 'staff')
    ), picked AS (
      (SELECT id, true AS is_match FROM datasets
        WHERE $3 <> '' AND strpos(lower(name), lower($3)) > 0
        ORDER BY (lower(name) = lower($3)) DESC, lower(name), id LIMIT 50)
      UNION ALL
      SELECT id, false FROM datasets WHERE id = ANY($4::uuid[])
    ), details AS (
      SELECT p.is_match, lower(d.name) = lower($3) AS exact, d.name, d.id,
        jsonb_build_object('datasetId', d.id, 'name', d.name, 'revision', d.revision,
          'member', EXISTS (
            SELECT 1 FROM dataset_review_clips m
            WHERE m.dataset_id = d.id AND m.clip_id = b.id AND m.job_id = b.job_id
              AND m.result_manifest_sha256 = b.result_manifest_sha256 AND m.selection_revision = b.seq
          ),
          'shared', EXISTS (SELECT 1 FROM dataset_access da WHERE da.dataset_id = d.id AND da.enabled)
        ) AS item
      FROM binding b CROSS JOIN picked p JOIN datasets d ON d.id = p.id
    )
    SELECT coalesce(jsonb_agg(item ORDER BY exact DESC, lower(name), details.id) FILTER (WHERE is_match), '[]') AS matches,
      coalesce(jsonb_agg(item) FILTER (WHERE NOT is_match), '[]') AS saved,
      coalesce(bool_or(exact), false) AS "exactMatch"
    FROM binding LEFT JOIN details ON true
    GROUP BY binding.id`,
    [input.viewerUserId, clipId, q, ids],
  );
  if (!row) throw new CatalogError("not_found", "Clip not found");
  return row;
}
