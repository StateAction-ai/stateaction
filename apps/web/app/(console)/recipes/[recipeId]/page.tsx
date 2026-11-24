import { notFound } from "next/navigation";
import { parseRecordingId, pipelineReads } from "@stateaction/server/pipeline";
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

  const recipe = await reads.recipeVisualization(
    staff.userId,
    recipeId,
    jobId,
    view !== "recipe",
  );
  if (!recipe) notFound();
  return <RecipePage jobId={jobId} {...recipe} />;
}
