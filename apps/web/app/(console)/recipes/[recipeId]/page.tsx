import Link from "next/link";
import { ImportedStages } from "../../../../components/pipeline/imported-stages";
import { notFound } from "next/navigation";
import {
  CACHED_IMPORT_EVIDENCE_ID,
  parseRecordingId,
  pipelineReads,
} from "@stateaction/server/pipeline";
import { parseRecipeId } from "../../../../lib/recipe-view";
import { RecipePage } from "../../../../components/recipe/recipe-page";
import { requireConsoleSession } from "../../../../lib/server-session";

export const metadata = { title: "Processing recipe · StateAction.ai" };
export const dynamic = "force-dynamic";

const reads = pipelineReads();

export default async function Route({
  params,
  searchParams,
}: {
  params: Promise<{ recipeId: string }>;
  searchParams: Promise<{ job?: string | string[]; view?: string }>;
}) {
  const staff = await requireConsoleSession(["staff"]);
  const recipeId = parseRecipeId((await params).recipeId);
  const { job, view } = await searchParams;
  const jobId = typeof job === "string" ? parseRecordingId(job) : null;
  if (!jobId || !recipeId) notFound();

  if (recipeId === CACHED_IMPORT_EVIDENCE_ID) {
    const cached = await reads.cachedImportByJob(staff.userId, jobId);
    if (!cached) notFound();
    return (
      <section className="grid gap-4">
        <Link
          href={`/pipeline/${cached.recordingId}`}
          className="text-sm text-brand"
        >
          ← Pipeline
        </Link>
        <h1 className="text-2xl font-bold">Imported from cached results</h1>
        <p className="text-sm text-muted">
          Original StateAction recipe and DAG: not recorded.
        </p>
        <ImportedStages cached={cached} />
      </section>
    );
  }
  const recipe = await reads.recipeVisualization(
    staff.userId,
    recipeId,
    jobId,
    view !== "recipe",
  );
  if (!recipe) notFound();
  return <RecipePage jobId={jobId} {...recipe} />;
}
