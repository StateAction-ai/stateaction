import Link from "next/link";
import { notFound } from "next/navigation";
import {
  parseRecordingId,
  pipelineReads,
  type RecipeDefinition,
  v1RecipeGraph,
} from "@stateaction/server/pipeline";
import { parseRecipeId } from "../../../../lib/recipe-view";
import { requireConsoleSession } from "../../../../lib/server-session";
import { RecipeFlow } from "../../../../components/recipes/recipe-flow";
import { RecipeEvidence } from "../../../../components/recipes/recipe-evidence";
import { Card } from "../../../../components/ui/card";

export const metadata = { title: "Processing recipe · StateAction.ai" };
export const dynamic = "force-dynamic";

function RecipeRecordings({ definition }: { definition: RecipeDefinition }) {
  return (
    <Card className="grid gap-2 p-4 sm:p-5">
      <h2 className="text-lg font-bold">
        Recordings using this recipe ({definition.recordingCount})
      </h2>
      {definition.recordings.length ? (
        <ul className="divide-y divide-line">
          {definition.recordings.map((recording) => (
            <li
              key={recording.recordingId}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 text-sm"
            >
              <Link
                href={`/recordings/${recording.recordingId}`}
                className="min-w-0 font-semibold text-brand underline wrap-anywhere"
              >
                {recording.title}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No recorded usage.</p>
      )}
    </Card>
  );
}

export default async function RecipePage({
  params,
  searchParams,
}: {
  params: Promise<{ recipeId: string }>;
  searchParams: Promise<{
    job?: string | string[];
    step?: string | string[];
  }>;
}) {
  const staff = await requireConsoleSession(["staff"]);
  const recipeId = parseRecipeId((await params).recipeId);
  const { job, step } = await searchParams;
  const jobId = typeof job === "string" ? parseRecordingId(job) : null;
  if (!recipeId || (job !== undefined && !jobId)) notFound();

  const reads = pipelineReads();
  const definition = await reads.recipeDefinition(staff.userId, recipeId);
  const workflow = definition?.kind === "workflow";
  const exact =
    !workflow && jobId
      ? await reads.recipeVisualization(staff.userId, recipeId, jobId, true)
      : null;
  if ((!definition && !exact) || (jobId && !exact && !workflow)) notFound();
  const historicalJob = workflow
    ? (jobId ?? definition.recordings[0]?.jobId)
    : null;
  if (
    workflow &&
    jobId &&
    !definition.recordings.some((entry) => entry.jobId === jobId)
  )
    notFound();
  const cached = historicalJob
    ? await reads.cachedImportByJob(staff.userId, historicalJob)
    : null;
  const recipe = exact?.recipe ?? definition?.recipe;
  const nodes = exact
    ? v1RecipeGraph(exact.recipe, "definition").map((node) => {
        const run = exact.run?.stages.find(({ stage }) => stage === node.id);
        return run ? { ...node, status: run.state } : node;
      })
    : (definition?.graph ?? []);
  const label =
    definition?.label ?? recipeId.split("@")[0]!.replaceAll("_", " ");
  const version = recipeId.split("@")[1];

  return (
    <div className="grid gap-4">
      <Link href="/recipes" className="w-fit text-sm text-brand underline">
        ← Recipes
      </Link>
      <header>
        <h1 className="text-3xl font-bold tracking-tight wrap-anywhere">
          {label}
          {version ? ` · v${version}` : ""}
        </h1>
        {definition?.preview && (
          <p className="mt-1 text-sm text-muted">
            Read-only preview · Unavailable for capture
          </p>
        )}
        {workflow && (
          <p className="mt-1 text-sm text-muted">
            Historical workflow. Recipe version was not recorded.
          </p>
        )}
      </header>
      <RecipeFlow
        nodes={nodes}
        initialStep={typeof step === "string" ? step : undefined}
        details={
          recipe
            ? Object.fromEntries(
                recipe.stages.map((spec) => [
                  spec.stage,
                  <RecipeEvidence key={spec.stage} spec={spec} exact={exact} />,
                ]),
              )
            : undefined
        }
      />
      {(definition || cached) && (
        <Card className="grid gap-1 p-4 text-sm text-muted sm:p-5">
          {definition && (
            <>
              <p>
                {definition.estimatedUsdPerVideoHour === null
                  ? "Cost per video-hour unavailable"
                  : `Estimated ${definition.estimatedUsdPerVideoHour} USD per video-hour`}
              </p>
              {definition.captureSources.map((source) => (
                <p key={source.id}>
                  {source.label}
                  {source.defaultRecipeId === recipeId ? " · Default" : ""}
                </p>
              ))}
            </>
          )}
          {cached && (
            <p>
              {cached.attribution.dataset} by {cached.attribution.creators}.{" "}
              {cached.attribution.license}. {cached.attribution.changes}
            </p>
          )}
        </Card>
      )}
      {definition && <RecipeRecordings definition={definition} />}
    </div>
  );
}
