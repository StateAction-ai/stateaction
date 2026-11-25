import {
  loadBoundClipAnnotations,
  type AnnotationDeps,
  type BoundClipResult,
} from "../annotations/annotations.js";
import { pageSize, uuid, type Queryable } from "../catalog/catalog.js";
import { CatalogError, toCatalogError } from "../catalog/errors.js";
import { recordingMp4MaxBytes } from "./broker.js";
import { verifiedReviewVideoSql } from "./review-playable-media.js";
import {
  REVIEW_DATASET_ACCESS,
  explicitReadGate,
  REVIEW_MEMBERS,
  SELECTED_REVIEW_CLIPS,
  reviewDatasetId,
  shareStateSql,
  type DatasetShareState,
} from "./review-scope.js";
import { grantedTo } from "./queries.js";

const problems = ["failed_window", "caption_failed", "no_hand"] as const;
const sorts = [
  "best_match",
  "capture_newest",
  "capture_oldest",
  "recently_added",
] as const;

export type ReviewDatasetSearchOptions = {
  viewerUserId: string;
  datasetId: string;
  q?: string;
  labels?: string[];
  recordingIds?: string[];
  minDurationNs?: string;
  maxDurationNs?: string;
  problems?: (typeof problems)[number][];
  sort?: (typeof sorts)[number];
  page?: number;
  limit?: number;
};

type Term = { value: string; pattern: string; excluded: boolean };

export function reviewSearchTerms(value = ""): Term[] {
  if (
    typeof value !== "string" ||
    value.length > 160 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new CatalogError(
      "invalid_request",
      "Search must be at most 160 characters",
    );
  return [...value.matchAll(/(-?)(?:"([^"]*)"|([^\s"]+))/g)].flatMap(
    ([, minus, phrase, word]) => {
      const value = (phrase ?? word ?? "").trim();
      return value
        ? [
            {
              value,
              pattern: `%${value.replace(/[\\%_]/g, "\\$&")}%`,
              excluded: minus === "-",
            },
          ]
        : [];
    },
  );
}

function duration(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!/^\d{1,19}$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new CatalogError("invalid_request", "Invalid duration bound");
  return value;
}

/** Private correction facts always require the exact selected result. */
const correctionScope = (correction: string, clip: string) => `
  ${correction}.clip_id = ${clip}.clip_id AND ${correction}.job_id = ${clip}.job_id
  AND ${correction}.result_manifest_sha256 = ${clip}.manifest
  AND ${correction}.selection_revision = ${clip}.selection_revision`;

export async function listReviewDatasets(
  pool: Queryable,
  input: { viewerUserId: string },
) {
  const { rows } = await pool.query<{
    datasetId: string;
    name: string;
    clipCount: number;
    durationNs: string;
    lastUpdatedAt: Date | null;
    shareState: DatasetShareState | null;
  }>(
    `
    WITH selected AS (${SELECTED_REVIEW_CLIPS}),
    datasets_visible AS (
      SELECT id::text AS id, name, updated_at, 2 AS order_by,
        CASE WHEN catalog_has_role($1, 'staff') THEN ${shareStateSql("d.id")} END AS share_state
      FROM datasets d
      WHERE catalog_has_role($1, 'staff') OR (
        catalog_has_role($1, 'customer') AND EXISTS (${grantedTo("d.id")}))
      UNION ALL
      SELECT x.id, x.name, NULL::timestamptz, x.order_by, NULL::text
      FROM (VALUES ('pending-review', 'Pending Review', 0), ('recycle-bin', 'Recycle Bin', 1)) x(id, name, order_by)
      WHERE catalog_has_role($1, 'staff')
    ), members AS (
      SELECT m.dataset_id::text AS dataset_id, s.*, m.added_at
      FROM selected s JOIN dataset_review_clips m
        ON m.clip_id = s.clip_id AND m.job_id = s.job_id AND m.selection_revision = s.selection_revision
        AND m.result_manifest_sha256 = s.manifest
      WHERE s.review_status = 'approved' AND (${explicitReadGate()})
      UNION ALL
      SELECT CASE WHEN s.review_status = 'pending' THEN 'pending-review' ELSE 'recycle-bin' END,
        s.*, coalesce(s.reviewed_at, s.selected_at)
      FROM selected s
      WHERE s.review_status IN ('pending', 'rejected') AND catalog_has_role($1, 'staff')
    ), totals AS (
      SELECT m.dataset_id, count(*)::int AS clip_count, sum(m.duration_ns) AS duration_ns,
        max(greatest(m.added_at, edit.latest)) AS latest
      FROM members m LEFT JOIN LATERAL (
        SELECT max(c.created_at) AS latest FROM caption_corrections c WHERE ${correctionScope("c", "m")}
      ) edit ON true
      GROUP BY m.dataset_id
    )
    SELECT d.id AS "datasetId", d.name, coalesce(t.clip_count, 0) AS "clipCount",
      coalesce(t.duration_ns, 0)::text AS "durationNs",
      greatest(d.updated_at, t.latest) AS "lastUpdatedAt",
      d.share_state AS "shareState"
    FROM datasets_visible d LEFT JOIN totals t ON t.dataset_id = d.id
    ORDER BY d.order_by, lower(d.name), d.id
    `,
    [input.viewerUserId],
  );
  return rows.map(({ shareState, ...row }) => ({
    ...row,
    ...(shareState === null ? {} : { shareState }),
    lastUpdatedAt: row.lastUpdatedAt?.toISOString() ?? null,
  }));
}

type CaptionMatch = {
  segmentId: string;
  startTsNs: string | null;
  offsetNs: string | null;
  text: string | null;
  alsoMatchesOriginal?: true;
};
type CaptionHighlight = { text: string; highlighted: boolean };

function captionHighlights(text: string | null): CaptionHighlight[] {
  return (text ?? "")
    .split(/([\ue000\ue001])/u)
    .reduce<CaptionHighlight[]>((parts, value, index, values) => {
      if (value && value !== "\ue000" && value !== "\ue001")
        parts.push({
          text: value,
          highlighted: values[index - 1] === "\ue000",
        });
      return parts;
    }, []);
}
type Facet = { value: string; label: string; count: number };
type BrowseItem = {
  clipId: string;
  title: string | null;
  ordinal: number;
  taskLabel: string | null;
  capturedAt: string;
  addedAt: string;
  sortDate: string;
  durationNs: string | null;
  hasPoster: boolean;
  hasVideo: boolean;
  captionMatch: CaptionMatch | null;
  reviewStatus?: "pending" | "approved" | "rejected";
  recordingId?: string;
  proposedLabel?: string | null;
  correctedCount?: number;
  problems?: (typeof problems)[number][];
  rejection?: {
    reason: string | null;
    reviewerUserId: string;
    rejectedAt: string;
  };
};
type BrowseRow = {
  datasetId: string;
  items: BrowseItem[];
  totalCount: number;
  filteredCount: number;
  lastUpdatedAt: Date | null;
  shareState: DatasetShareState | null;
  facets: { labels: Facet[]; recordings?: Facet[]; problems?: Facet[] };
};

const FILTERED_CLIPS = `
  WITH viewer AS (
    SELECT catalog_has_role($1, 'staff') AS staff
    WHERE (${REVIEW_DATASET_ACCESS})
      AND (catalog_has_role($1, 'staff') OR NOT $11::boolean)
  ), selected AS (${SELECTED_REVIEW_CLIPS}), members AS (${REVIEW_MEMBERS}),
  terms AS (
    SELECT *, phraseto_tsquery('simple', value) AS query
    FROM jsonb_to_recordset($3::jsonb) AS t(value text, pattern text, excluded boolean)
  ), edits AS MATERIALIZED (
    SELECT DISTINCT ON (m.clip_id, c.segment_id)
      m.clip_id, c.segment_id, c.segments_sha256, c.text, c.not_needed, c.created_at, c.id
    FROM members m JOIN caption_corrections c ON ${correctionScope("c", "m")}
    ORDER BY m.clip_id, c.segment_id, c.revision DESC
  ), edited_clips AS (
    SELECT clip_id, max(created_at) AS updated_at,
      count(*) FILTER (WHERE text IS NOT NULL OR not_needed)::int AS corrected_count
    FROM edits GROUP BY clip_id
  ), caption_matches AS (
    SELECT m.clip_id, a.segment_id, a.start_ts_ns, t.value,
      CASE WHEN e.not_needed THEN NULL ELSE coalesce(e.text, a.original_text) END AS effective_text,
      (e.text IS NULL AND NOT coalesce(e.not_needed, false)) AS effective_match, true AS original_match
    FROM terms t
    JOIN review_caption_search a ON a.original_terms @@ t.query
    JOIN members m ON m.job_id = a.job_id AND m.manifest = a.result_manifest_sha256
    LEFT JOIN edits e ON e.clip_id = m.clip_id AND e.segment_id = a.segment_id
      AND e.segments_sha256 = a.segments_sha256
    CROSS JOIN viewer v
    WHERE v.staff OR (e.text IS NULL AND NOT coalesce(e.not_needed, false))
    UNION ALL
    SELECT m.clip_id, e.segment_id, a.start_ts_ns, t.value, c.text, true, false
    FROM terms t JOIN caption_corrections c ON to_tsvector('simple', coalesce(c.text, '')) @@ t.query
    JOIN edits e ON e.id = c.id
    JOIN members m ON m.clip_id = e.clip_id
    LEFT JOIN review_caption_search a ON a.job_id = m.job_id AND a.result_manifest_sha256 = m.manifest
      AND a.segment_id = e.segment_id AND a.segments_sha256 = e.segments_sha256
  ), searched AS (
    SELECT m.*, v.staff, authored.title AS authored_title, ec.updated_at, ec.corrected_count,
      rs.job_id IS NOT NULL AS indexed, rs.segments_clock_domain,
      array_remove(ARRAY[
        CASE WHEN m.failed_window_count > 0 THEN 'failed_window' END,
        CASE WHEN m.caption_failed_count > 0 THEN 'caption_failed' END,
        CASE WHEN rs.no_hand_detected THEN 'no_hand' END
      ], NULL) AS problems,
      (coalesce(m.captured_at, m.added_at)) AS capture_sort,
      (
        SELECT count(*) FROM terms t WHERE NOT t.excluded AND (
          m.task_label ILIKE t.pattern ESCAPE '\\'
          OR (CASE WHEN v.staff THEN m.recording_title ELSE authored.title END) ILIKE t.pattern ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM caption_matches cm
            WHERE cm.clip_id = m.clip_id AND cm.value = t.value AND cm.effective_match)
        )
      ) AS score
    FROM members m CROSS JOIN viewer v
    LEFT JOIN review_result_search rs ON rs.job_id = m.job_id AND rs.result_manifest_sha256 = m.manifest
    LEFT JOIN edited_clips ec USING (clip_id)
    LEFT JOIN cached_processing_imports imported ON imported.job_id = m.job_id
    CROSS JOIN LATERAL (
      SELECT CASE WHEN imported.evidence #>> '{attribution,title}' !~*
        '^[0-9a-f-]{36}$' THEN nullif(btrim(imported.evidence #>> '{attribution,title}'), '') END AS title
    ) authored
    WHERE NOT EXISTS (
      SELECT 1 FROM terms t WHERE t.excluded = coalesce((
        m.task_label ILIKE t.pattern ESCAPE '\\'
          OR (CASE WHEN v.staff THEN m.recording_title ELSE authored.title END) ILIKE t.pattern ESCAPE '\\'
        OR (v.staff AND (m.clip_id::text ILIKE t.pattern ESCAPE '\\'
          OR m.recording_id::text ILIKE t.pattern ESCAPE '\\'))
        OR EXISTS (SELECT 1 FROM caption_matches cm WHERE cm.clip_id = m.clip_id AND cm.value = t.value)
      ), false)
    )
    AND ($6::bigint IS NULL OR m.duration_ns >= $6)
    AND ($7::bigint IS NULL OR m.duration_ns <= $7)
  ), filtered AS (
    SELECT * FROM searched
    WHERE (cardinality($4::text[]) = 0 OR lower(task_label) = ANY($4))
      AND (cardinality($5::uuid[]) = 0 OR recording_id = ANY($5))
      AND (cardinality($8::text[]) = 0 OR problems && $8)
  )
`;

const FILTER_ORDER = `
  CASE WHEN $9 = 'best_match' THEN score END DESC,
  CASE WHEN $2 = 'recycle-bin' OR $9 = 'recently_added' THEN added_at END DESC,
  CASE WHEN $9 = 'capture_oldest' AND $2 <> 'recycle-bin' THEN capture_sort END ASC,
  capture_sort DESC, clip_id`;

const FILTERED_BROWSE = `${FILTERED_CLIPS}, paged AS (
    SELECT *, row_number() OVER (ORDER BY
      ${FILTER_ORDER}) AS page_order,
      CASE WHEN $2 = 'recycle-bin' OR $9 = 'recently_added' THEN added_at ELSE capture_sort END AS sort_date
    FROM filtered
    ORDER BY page_order
    LIMIT $10 OFFSET $12
  ), cards AS (
    SELECT p.page_order, jsonb_build_object(
      'clipId', p.clip_id, 'title', CASE WHEN p.staff THEN p.recording_title ELSE p.authored_title END, 'ordinal', p.ordinal,
      'taskLabel', p.task_label, 'capturedAt', p.captured_at, 'addedAt', p.added_at,
      'sortDate', p.sort_date, 'durationNs', p.duration_ns::text, 'hasPoster', p.poster_key IS NOT NULL,
      'hasVideo', EXISTS (
        SELECT 1 FROM (${verifiedReviewVideoSql("p")}) as video
        WHERE video.size_bytes BETWEEN 1 AND $13::bigint
      ),
      'captionMatch', snippet.value
    ) || CASE WHEN p.staff THEN jsonb_build_object(
      'recordingId', p.recording_id, 'reviewStatus', p.review_status,
      'correctedCount', coalesce(p.corrected_count, 0), 'problems', p.problems,
      'proposedLabel', (
        SELECT CASE WHEN e.text IS NULL THEN a.original_label ELSE
          array_to_string((regexp_split_to_array(e.text, '[[:space:]]+'))[1:4], ' ') END
        FROM review_caption_search a
        LEFT JOIN edits e ON e.clip_id = p.clip_id AND e.segment_id = a.segment_id
          AND e.segments_sha256 = a.segments_sha256
        WHERE a.job_id = p.job_id AND a.result_manifest_sha256 = p.manifest
          AND NOT coalesce(e.not_needed, false)
          AND (e.text IS NOT NULL OR a.original_label IS NOT NULL)
        ORDER BY a.start_ts_ns, a.segment_id LIMIT 1
      )
    ) || CASE WHEN p.review_status = 'rejected' THEN jsonb_build_object('rejection', jsonb_build_object(
      'reason', p.notes, 'reviewerUserId', p.reviewer_user_id, 'rejectedAt', p.reviewed_at
    )) ELSE '{}'::jsonb END ELSE '{}'::jsonb END AS item
    FROM paged p
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object(
        'segmentId', cm.segment_id, 'startTsNs', cm.start_ts_ns::text,
        'offsetNs', CASE WHEN p.clip_clock_domain = p.segments_clock_domain
          AND cm.start_ts_ns >= p.clip_origin_ns
          AND (p.duration_ns IS NULL OR cm.start_ts_ns - p.clip_origin_ns <= p.duration_ns)
          THEN (cm.start_ts_ns - p.clip_origin_ns)::text END,
        'text', CASE WHEN cm.effective_match THEN ts_headline('simple', cm.effective_text, t.query,
          'StartSel=' || chr(57344) || ', StopSel=' || chr(57345) || ', MaxWords=24, MinWords=8')
          ELSE left(cm.effective_text, 240) END
      ) || CASE WHEN p.staff AND cm.original_match AND NOT cm.effective_match
        THEN '{"alsoMatchesOriginal":true}'::jsonb ELSE '{}'::jsonb END AS value
      FROM caption_matches cm JOIN terms t ON t.value = cm.value AND NOT t.excluded
      WHERE cm.clip_id = p.clip_id
      ORDER BY cm.effective_match DESC, cm.start_ts_ns NULLS LAST, cm.segment_id, t.value
      LIMIT 1
    ) snippet ON true
  )
  SELECT $2 AS "datasetId",
    CASE WHEN viewer.staff THEN (
      SELECT ${shareStateSql("d.id")} FROM datasets d WHERE d.id::text = $2
    ) END AS "shareState",
    (SELECT count(*)::int FROM members) AS "totalCount",
    (SELECT count(*)::int FROM filtered) AS "filteredCount",
    greatest((SELECT updated_at FROM datasets WHERE id::text = $2), (
      SELECT max(greatest(m.added_at, ec.updated_at)) FROM members m LEFT JOIN edited_clips ec USING (clip_id)
    )) AS "lastUpdatedAt",
    coalesce((SELECT jsonb_agg(cards.item ORDER BY page_order) FROM cards), '[]') AS items,
    jsonb_build_object('labels', coalesce((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.value)
      FROM (
        SELECT lower(task_label) AS value, min(task_label) AS label, count(*)::int AS count
        FROM searched
        WHERE task_label IS NOT NULL AND $2 <> 'pending-review'
          AND (cardinality($5::uuid[]) = 0 OR recording_id = ANY($5))
          AND (cardinality($8::text[]) = 0 OR problems && $8)
        GROUP BY lower(task_label)
      ) x
    ), '[]')) || CASE WHEN viewer.staff THEN jsonb_build_object(
      'recordings', coalesce((
        SELECT jsonb_agg(to_jsonb(x) ORDER BY x.label, x.value)
        FROM (
          SELECT recording_id AS value, min(recording_title) AS label, count(*)::int AS count
          FROM searched
          WHERE (cardinality($4::text[]) = 0 OR lower(task_label) = ANY($4))
            AND (cardinality($8::text[]) = 0 OR problems && $8)
          GROUP BY recording_id
        ) x
      ), '[]'),
      'problems', coalesce((
        SELECT jsonb_agg(to_jsonb(x) ORDER BY x.value)
        FROM (
          SELECT value, value AS label, count(*)::int AS count
          FROM searched, unnest(problems) AS x(value)
          WHERE (cardinality($4::text[]) = 0 OR lower(task_label) = ANY($4))
            AND (cardinality($5::uuid[]) = 0 OR recording_id = ANY($5))
          GROUP BY value
        ) x
      ), '[]')
    ) ELSE '{}'::jsonb END AS facets
  FROM viewer
`;

function reviewFilterParameters(input: ReviewDatasetSearchOptions) {
  const id = reviewDatasetId(input.datasetId);
  const labels = input.labels ?? [];
  const recordings = input.recordingIds ?? [];
  const selectedProblems = input.problems ?? [];
  const min = duration(input.minDurationNs);
  const max = duration(input.maxDurationNs);
  const terms = reviewSearchTerms(input.q);
  const sort =
    input.sort ??
    (id === "pending-review" ? "capture_oldest" : "capture_newest");
  if (
    !sorts.includes(sort) ||
    labels.length > 50 ||
    recordings.length > 50 ||
    labels.some((label) => typeof label !== "string" || label.length > 200) ||
    selectedProblems.some((problem) => !problems.includes(problem)) ||
    (min !== null && max !== null && BigInt(min) > BigInt(max))
  )
    throw new CatalogError("invalid_request", "Invalid dataset filter");
  return [
    input.viewerUserId,
    id,
    JSON.stringify(terms),
    labels.map((label) => label.toLowerCase()),
    recordings.map((recordingId) => uuid(recordingId, "recordingId")),
    min,
    max,
    selectedProblems,
    sort,
  ] as const;
}

function usesStaffFilters(
  parameters: ReturnType<typeof reviewFilterParameters>,
) {
  const [, , , , recordings, min, max, selectedProblems, sort] = parameters;
  return Boolean(
    recordings.length ||
      min ||
      max ||
      selectedProblems.length ||
      sort === "recently_added" ||
      sort === "best_match",
  );
}

export async function listReviewDatasetClips(
  pool: Queryable,
  input: ReviewDatasetSearchOptions,
) {
  const parameters = reviewFilterParameters(input);
  const limit = pageSize(input.limit);
  const page = input.page ?? 1;
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    (page - 1) * limit > 2147483647
  )
    throw new CatalogError("invalid_request", "Invalid dataset filter");
  try {
    const {
      rows: [row],
    } = await pool.query<BrowseRow>(FILTERED_BROWSE, [
      ...parameters,
      limit,
      usesStaffFilters(parameters),
      (page - 1) * limit,
      recordingMp4MaxBytes(),
    ]);
    if (!row) throw new CatalogError("not_found", "Dataset not found");
    const { shareState, ...result } = row;
    return {
      ...result,
      ...(shareState === null ? {} : { shareState }),
      items: row.items.map((item) => {
        if (!item.captionMatch) return item;
        const highlights = captionHighlights(item.captionMatch.text);
        return {
          ...item,
          captionMatch: {
            ...item.captionMatch,
            text:
              item.captionMatch.text === null
                ? null
                : highlights.map((part) => part.text).join(""),
            highlights,
          },
        };
      }),
      lastUpdatedAt: row.lastUpdatedAt?.toISOString() ?? null,
      limit,
      page,
    };
  } catch (error) {
    throw toCatalogError(error);
  }
}

const MAX_EXPORT_CLIPS = 250;
const MAX_EXPORT_CAPTIONS = 5000;
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const LEGACY_EXPORT_LIMIT = 24;

type ExportCaption = {
  segmentId: string;
  startTsNs: string;
  caption: string | null;
  captionNotNeeded: boolean;
  originalCaption?: string | null;
};
type ExportClip = {
  clipId: string;
  recordingId?: string;
  segments: ExportCaption[];
};
type ExportRow = {
  staff: boolean;
  clips: ExportClip[];
  captionCount: number;
  editCount: number;
  legacy: (BoundClipResult & {
    edits: { segmentId: string; text: string | null; notNeeded: boolean }[];
  })[];
};

const CAPTION_EXPORT = `${FILTERED_CLIPS}, export_clips AS MATERIALIZED (
  SELECT *, row_number() OVER (ORDER BY ${FILTER_ORDER}) AS export_order
  FROM filtered ORDER BY export_order LIMIT $10
), caption_rows AS MATERIALIZED (
  SELECT p.clip_id, a.start_ts_ns, a.segment_id,
    jsonb_build_object('segmentId', a.segment_id, 'startTsNs', a.start_ts_ns::text,
      'caption', CASE WHEN e.not_needed THEN NULL ELSE coalesce(e.text, a.original_text) END,
      'captionNotNeeded', coalesce(e.not_needed, false))
    || CASE WHEN p.staff THEN jsonb_build_object('originalCaption', a.original_text)
      ELSE '{}'::jsonb END AS caption
  FROM export_clips p
  JOIN review_caption_search a ON a.job_id = p.job_id AND a.result_manifest_sha256 = p.manifest
  LEFT JOIN edits e ON e.clip_id = p.clip_id AND e.segment_id = a.segment_id
    AND e.segments_sha256 = a.segments_sha256
  LIMIT $12
), legacy_edits AS MATERIALIZED (
  SELECT p.clip_id, e.segment_id, e.text, e.not_needed
  FROM export_clips p
  JOIN edits e ON e.clip_id = p.clip_id
  JOIN job_output_slots s ON s.job_id = p.job_id AND s.slot = 'segments.json'
  JOIN files f ON f.id = s.file_id AND f.job_id = s.job_id AND f.sha256 = e.segments_sha256
  WHERE NOT p.indexed
  LIMIT $12
)
SELECT viewer.staff,
  coalesce((SELECT jsonb_agg(
    jsonb_build_object('clipId', p.clip_id, 'segments', coalesce((
      SELECT jsonb_agg(a.caption ORDER BY a.start_ts_ns, a.segment_id)
      FROM caption_rows a WHERE a.clip_id = p.clip_id
    ), '[]')) || CASE WHEN p.staff THEN jsonb_build_object('recordingId', p.recording_id)
      ELSE '{}'::jsonb END ORDER BY p.export_order)
    FROM export_clips p), '[]') AS clips,
  (SELECT count(*)::int FROM caption_rows) AS "captionCount",
  (SELECT count(*)::int FROM legacy_edits) AS "editCount",
  coalesce((SELECT jsonb_agg(jsonb_build_object(
    'clipId', p.clip_id, 'recordingId', p.recording_id, 'jobId', p.job_id,
    'resultManifestSha256', p.manifest, 'selectionRevision', p.selection_revision,
    'edits', coalesce((
      SELECT jsonb_agg(jsonb_build_object('segmentId', segment_id, 'text', text, 'notNeeded', not_needed))
      FROM legacy_edits e WHERE e.clip_id = p.clip_id
    ), '[]')
  )) FROM export_clips p WHERE NOT p.indexed), '[]') AS legacy
FROM viewer
`;

function exportTooLarge(): never {
  throw new CatalogError(
    "invalid_request",
    "Too many captions to download. Narrow the dataset filters.",
  );
}

/** Resolve all matching clips in a single catalog snapshot, independent of page size. */
export async function exportReviewDatasetCaptions(
  pool: Queryable,
  input: ReviewDatasetSearchOptions,
  legacyReader: () => AnnotationDeps["reader"],
): Promise<string> {
  const parameters = reviewFilterParameters(input);
  const id = uuid(parameters[1], "datasetId");
  const {
    rows: [row],
  } = await pool.query<ExportRow>(CAPTION_EXPORT, [
    ...parameters,
    MAX_EXPORT_CLIPS + 1,
    usesStaffFilters(parameters),
    MAX_EXPORT_CAPTIONS + 1,
  ]);
  if (!row) throw new CatalogError("not_found", "Dataset not found");
  if (
    row.clips.length > MAX_EXPORT_CLIPS ||
    row.captionCount > MAX_EXPORT_CAPTIONS ||
    row.editCount > MAX_EXPORT_CAPTIONS ||
    row.legacy.length > LEGACY_EXPORT_LIMIT
  )
    exportTooLarge();

  // Pre-index results still have verified annotation artifacts.
  if (row.legacy.length) {
    const reader = legacyReader();
    const deadline = Date.now() + 45_000;
    const deps: AnnotationDeps = {
      pool,
      reader: {
        read(key, maxBytes) {
          if (Date.now() >= deadline)
            throw new CatalogError(
              "conflict",
              "The caption download timed out. Narrow the dataset filters.",
            );
          return reader.read(key, maxBytes);
        },
      },
    };
    const byId = new Map(row.clips.map((clip) => [clip.clipId, clip]));
    let captionCount = row.captionCount;
    for (const binding of row.legacy) {
      const doc = await loadBoundClipAnnotations(deps, binding);
      if (!doc)
        throw new CatalogError(
          "conflict",
          "The selected result changed. Try the download again.",
        );
      const edits = new Map(
        binding.edits.map((edit) => [edit.segmentId, edit]),
      );
      const originals = new Map(
        doc.captions?.rows
          .filter((caption) => caption.status === "complete")
          .map((caption) => [caption.segment_id, caption.text] as const),
      );
      const clip = byId.get(binding.clipId)!;
      for (const segment of doc.segments?.rows ?? []) {
        if (segment.status !== "ok") continue;
        if (++captionCount > MAX_EXPORT_CAPTIONS) exportTooLarge();
        const segmentId = segment.segment_id;
        const original = originals.get(segmentId) ?? null;
        const edit = edits.get(segmentId);
        const omitted = edit?.notNeeded ?? false;
        clip.segments.push({
          segmentId,
          startTsNs: segment.start.timestamp_ns,
          caption: omitted ? null : (edit?.text ?? original),
          captionNotNeeded: omitted,
          ...(row.staff ? { originalCaption: original } : {}),
        });
      }
    }
  }
  const body = JSON.stringify({ datasetId: id, clips: row.clips });
  if (Buffer.byteLength(body) > MAX_EXPORT_BYTES) exportTooLarge();
  return body;
}
