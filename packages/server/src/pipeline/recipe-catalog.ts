import type { CompiledGraph, RecipeV1 } from "@stateaction/contracts";
import defaultGraph from "../../../../recipes/compiled/egocentric_default.json" with { type: "json" };
import minimalGraph from "../../../../examples/compiled/minimal_stub.json" with { type: "json" };
import motionGraph from "../../../../examples/compiled/with_motion_energy.json" with { type: "json" };
import detailedGraph from "../../../../examples/compiled/caption_detailed.json" with { type: "json" };
import {
  compiledRecipeGraph,
  v1RecipeGraph,
  type RecipeGraphNode,
} from "./recipe-graph.js";
import { CAPTURE_SOURCES } from "../admission/capture-profiles.js";
import { publishedRecipe } from "../jobs/recipe-release.js";
import { PUBLIC_VIDEO_RECIPE } from "../admission/public-video-canary.js";
import type { Queryable } from "../catalog/catalog.js";
import { recordingTitle } from "./model.js";
import { recordingDurationSql, recordingNameSql } from "./recording-display.js";
import { RECORDING_IMPORT_LATERAL } from "./queries.js";
import { JOB_COST_LATERAL } from "./recording-operations.js";

const compiled = [
  defaultGraph,
  minimalGraph,
  motionGraph,
  detailedGraph,
] as CompiledGraph[];

const DOCUMENTED_WORKFLOW = "flora-spike-c";
const CATALOG_IDS = [
  ...new Set(CAPTURE_SOURCES.flatMap((source) => source.allowedRecipeIds)),
  DOCUMENTED_WORKFLOW,
  ...compiled.map(({ recipe }) => recipe),
];
export type CaptureSourceDefinition = (typeof CAPTURE_SOURCES)[number];

export type RecipeCatalogEntry = {
  id: string;
  label: string;
  kind: "recipe" | "workflow";
  recipe: RecipeV1 | null;
  graph: RecipeGraphNode[];
  preview: boolean;
  captureSources: CaptureSourceDefinition[];
  recordingCount: number;
  estimatedUsdPerVideoHour: string | null;
  estimateJobCount: number;
};

export type RecipeUsage = {
  recordingId: string;
  title: string;
  startedAt: string;
  jobId: string | null;
  resultAvailable: boolean;
};

export type RecipeDefinition = RecipeCatalogEntry & {
  recordings: RecipeUsage[];
};

const STAFF_RECIPE_JOBS = `WITH staff AS (
  SELECT catalog_has_role($1, 'staff') AS ok
), usage_jobs AS (
  SELECT j.id AS job_id, r.id AS recording_id, j.recipe, r.started_at, j.created_at,
    coalesce(j.recipe ->> 'recipeId', i.originating_recipe_ref ->> 'recipeId',
      i.originating_recipe_ref ->> 'workflowId') AS recipe_id,
    (j.state = 'succeeded' AND j.result_manifest_sha256 IS NOT NULL) AS result_available,
    (j.id = r.current_job_id OR c.live_job_id = j.id OR c.selected_job_id = j.id) AS current,
    CASE WHEN j.state = 'succeeded' AND j.derived_from_job_id IS NULL AND costs.cost_complete AND c.end_ts_ns > c.start_ts_ns
      THEN (c.end_ts_ns - c.start_ts_ns)::numeric / 1000000000 END AS measured_seconds,
    costs.cost_usd::numeric AS cost_usd
  FROM jobs j
  JOIN recordings r ON r.id = j.recording_id AND r.deleted_at IS NULL
  LEFT JOIN review_clips c ON c.id = j.clip_id
  LEFT JOIN cached_processing_imports i ON i.job_id = j.id AND i.manifest_sha256 = j.result_manifest_sha256
  ${JOB_COST_LATERAL}
  WHERE (SELECT ok FROM staff) AND (j.recipe IS NOT NULL OR i.originating_recipe_ref IS NOT NULL)
    AND ($2::text IS NULL OR coalesce(j.recipe ->> 'recipeId', i.originating_recipe_ref ->> 'recipeId',
      i.originating_recipe_ref ->> 'workflowId') = $2)
), recipe_usage AS (
  SELECT * FROM usage_jobs
  UNION ALL
  SELECT NULL, r.id,
    CASE WHEN p.recipe ->> 'schemaVersion' = '1' AND jsonb_typeof(p.recipe -> 'stages') = 'array'
      THEN p.recipe END,
    r.started_at, p.matched_at, p.recipe_id, false, false, NULL, NULL
  FROM recording_capture_profiles p JOIN recordings r ON r.id = p.recording_id AND r.deleted_at IS NULL
  WHERE (SELECT ok FROM staff) AND p.state = 'selected' AND ($2::text IS NULL OR p.recipe_id = $2)
    AND NOT EXISTS (SELECT 1 FROM usage_jobs j WHERE j.recording_id = r.id AND j.recipe_id = p.recipe_id)
), totals AS (
  SELECT recipe_id, count(DISTINCT recording_id)::int AS recording_count,
    count(measured_seconds)::int AS estimate_job_count,
    (round(sum(cost_usd) FILTER (WHERE measured_seconds IS NOT NULL)
      * 3600 / nullif(sum(measured_seconds), 0), 2))::text AS estimated_per_hour
  FROM recipe_usage GROUP BY recipe_id
)`;

type TotalsRow = {
  recipe_id: string;
  recording_count: number;
  estimate_job_count: number;
  estimated_per_hour: string | null;
};

function catalogEntry(
  id: string,
  totals: TotalsRow | undefined,
  snapshot: RecipeV1 | null = null,
): RecipeCatalogEntry {
  const workflow = id === DOCUMENTED_WORKFLOW;
  const released = publishedRecipe(id);
  const definition = released ?? compiled.find(({ recipe }) => recipe === id);
  const recipe =
    id === PUBLIC_VIDEO_RECIPE.recipeId ? PUBLIC_VIDEO_RECIPE : snapshot;
  return {
    id,
    label: workflow
      ? "FLORA Spike C + CPU hand tracking"
      : id.startsWith("indego_hosted_canary@")
        ? "IndEgo processing"
        : (definition?.meta.title ?? id.split("@")[0]!.replaceAll("_", " ")),
    kind: workflow ? "workflow" : "recipe",
    recipe,
    graph: definition
      ? compiledRecipeGraph(definition)
      : v1RecipeGraph(recipe, "definition"),
    preview: definition !== undefined && released === undefined,
    captureSources: CAPTURE_SOURCES.filter((source) =>
      source.allowedRecipeIds.some((allowed) => allowed === id),
    ),
    recordingCount: totals?.recording_count ?? 0,
    estimatedUsdPerVideoHour: totals?.estimated_per_hour ?? null,
    estimateJobCount: totals?.estimate_job_count ?? 0,
  };
}

export async function listRecipeCatalog(pool: Queryable, staff: string) {
  const { rows } = await pool.query<TotalsRow | { recipe_id: null }>(
    `${STAFF_RECIPE_JOBS}
     SELECT totals.* FROM staff LEFT JOIN totals ON true WHERE staff.ok`,
    [staff, null],
  );
  return {
    recipes: rows.length
      ? CATALOG_IDS.flatMap((id) => {
          const totals = rows.find(
            (row): row is TotalsRow => row.recipe_id === id,
          );
          return id === DOCUMENTED_WORKFLOW && !totals
            ? []
            : [catalogEntry(id, totals)];
        })
      : [],
    captureSources: rows.length ? [...CAPTURE_SOURCES] : [],
  };
}

type UsageRow = TotalsRow & {
  recording_id: string | null;
  title: string | null;
  started_at: Date | null;
  recipe: RecipeV1 | null;
  job_id: string | null;
  result_available: boolean | null;
};

export async function getRecipeDefinition(
  pool: Queryable,
  staff: string,
  id: string,
): Promise<RecipeDefinition | null> {
  const { rows } = await pool.query<UsageRow>(
    `${STAFF_RECIPE_JOBS}, representative AS (
      SELECT DISTINCT ON (recording_id) recording_id, started_at,
        CASE WHEN recipe IS NOT NULL OR recipe_id = '${DOCUMENTED_WORKFLOW}' THEN job_id END AS job_id, recipe,
        bool_or(result_available) OVER (PARTITION BY recording_id) AS result_available
      FROM recipe_usage
      ORDER BY recording_id, current DESC NULLS LAST, (recipe_usage.job_id IS NOT NULL) DESC, created_at DESC, recipe_usage.job_id DESC
    )
    SELECT totals.*, used.recording_id, used.started_at, used.recipe,
      used.job_id, used.result_available,
      ${recordingNameSql("r", "imported.title", "imported.dataset", recordingDurationSql("latest.plan", "imported.duration"))} AS title
    FROM staff LEFT JOIN totals ON true LEFT JOIN representative used ON true
    LEFT JOIN recordings r ON r.id = used.recording_id
    LEFT JOIN LATERAL (
      SELECT plan FROM clip_plans WHERE recording_id = r.id ORDER BY version DESC LIMIT 1
    ) latest ON true
    ${RECORDING_IMPORT_LATERAL}
    WHERE staff.ok
    ORDER BY used.started_at DESC, used.recording_id DESC`,
    [staff, id],
  );
  const first = rows[0];
  if (!first || (!first.recipe_id && !CATALOG_IDS.includes(id))) return null;
  return {
    ...catalogEntry(
      id,
      first.recipe_id ? first : undefined,
      rows.find((row) => row.recipe)?.recipe,
    ),
    recordings: rows.flatMap((row) =>
      row.recording_id && row.started_at
        ? [
            {
              recordingId: row.recording_id,
              title: row.title ?? recordingTitle(row.started_at),
              startedAt: row.started_at.toISOString(),
              jobId: row.job_id,
              resultAvailable: row.result_available === true,
            },
          ]
        : [],
    ),
  };
}
