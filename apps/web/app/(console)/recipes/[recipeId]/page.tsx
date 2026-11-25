import Link from "next/link";
import { notFound } from "next/navigation";
import {
  formatUsd,
  parseRecordingId,
  pipelineReads,
  type RecipeDefinition,
} from "@stateaction/server/pipeline";
import { parseRecipeId, recipeHref } from "../../../../lib/recipe-view";
import { requireConsoleSession } from "../../../../lib/server-session";
import { RecipeFlow } from "../../../../components/recipes/recipe-flow";
import {
  CachedRecipeEvidence,
  RecipeEvidence,
} from "../../../../components/recipes/recipe-evidence";
import { ProcessingStatus } from "../../../../components/recordings/processing-stage";
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
              {recording.jobId && (
                <Link
                  href={recipeHref(definition.id, recording.jobId)}
                  className="text-brand underline"
                >
                  View run <code>{recording.jobId.slice(0, 8)}</code>
                </Link>
              )}
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
  searchParams: Promise<{ job?: string | string[]; view?: string | string[] }>;
}) {
  const staff = await requireConsoleSession(["staff"]);
  const recipeId = parseRecipeId((await params).recipeId);
  const { job, view } = await searchParams;
  const jobId = typeof job === "string" ? parseRecordingId(job) : null;
  if (!recipeId || (job !== undefined && !jobId)) notFound();

  const reads = pipelineReads();
  const definition = await reads.recipeDefinition(staff.userId, recipeId);
  if (definition?.kind === "workflow") {
    const evidenceJobId = jobId ?? definition.recordings[0]?.jobId;
    const linked = definition.recordings.find(
      (recording) => recording.jobId === evidenceJobId,
    );
    if (!evidenceJobId || !linked) notFound();
    const cached = await reads.cachedImportByJob(staff.userId, evidenceJobId);
    if (!cached) notFound();
    return (
      <div className="grid gap-4">
        <Link href="/recipes" className="w-fit text-sm text-brand underline">
          ← Recipes
        </Link>
        <header>
          <h1 className="text-3xl font-bold tracking-tight">
            {definition.label}
          </h1>
          <p className="mt-1 text-sm text-muted">
            Historical workflow. Recipe version was not recorded.
          </p>
        </header>
        <Card className="grid gap-3 p-4 sm:p-5">
          <h2 className="text-lg font-bold">Processing flow</h2>
          <RecipeFlow recipe={null} />
        </Card>
        <CachedRecipeEvidence cached={cached} />
        <RecipeRecordings definition={definition} />
      </div>
    );
  }

  const exact = jobId
    ? await reads.recipeVisualization(
        staff.userId,
        recipeId,
        jobId,
        view !== "recipe",
      )
    : null;
  if ((jobId && !exact) || (!definition && !exact)) notFound();
  const recipe = exact?.recipe ?? definition?.recipe;
  if (!recipe) notFound();

  return (
    <div className="grid gap-4">
      <Link href="/recipes" className="w-fit text-sm text-brand underline">
        ← Recipes
      </Link>
      <header>
        <h1 className="text-3xl font-bold tracking-tight wrap-anywhere">
          {definition?.label && definition.label !== recipeId
            ? definition.label + " · " + recipeId
            : recipeId}
        </h1>
        {jobId && exact ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <Link
              href={`/recordings/${exact.recordingId}`}
              className="text-brand underline"
            >
              Recording
            </Link>
            <span>
              Run <code title={jobId}>{jobId.slice(0, 8)}</code>
            </span>
            {exact.run && <ProcessingStatus state={exact.run.jobState} />}
            {exact.run && (
              <span>
                Estimated cost {formatUsd(exact.run.estimatedCostUsd)}
              </span>
            )}
            <Link
              href={recipeHref(recipeId, jobId, {
                recipeOnly: view !== "recipe",
              })}
              className="text-brand underline"
            >
              {view === "recipe" ? "View exact run" : "View recipe definition"}
            </Link>
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted">
            Recipes and capture sources are defined in code.
          </p>
        )}
      </header>

      <Card className="grid gap-3 p-4 sm:p-5">
        <h2 className="text-lg font-bold">Processing flow</h2>
        <RecipeFlow recipe={recipe} />
        {exact?.topology !== undefined && exact.topology !== "unselected" && (
          <p className="text-sm text-muted">
            Recorded execution: {exact.topology}.
          </p>
        )}
        {definition && (
          <div className="grid gap-1 text-sm text-muted">
            <p>
              {definition.estimatedUsdPerVideoHour === null
                ? "Cost per video-hour unavailable"
                : `Estimated $${definition.estimatedUsdPerVideoHour} USD per video-hour`}
            </p>
            {definition.captureSources.map((source) => (
              <p key={source.id}>
                <Link
                  href="/recipes?tab=devices"
                  className="text-brand underline"
                >
                  {source.label}
                </Link>
                {source.defaultRecipeId === recipeId ? " · Default" : ""}
              </p>
            ))}
          </div>
        )}
      </Card>

      <RecipeEvidence recipe={recipe} exact={exact} />

      {definition && <RecipeRecordings definition={definition} />}
    </div>
  );
}
