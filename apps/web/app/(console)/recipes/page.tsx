import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { pipelineReads } from "@stateaction/server/pipeline";
import { requireConsoleSession } from "../../../lib/server-session";
import { recipeHref, recipeLabel } from "../../../lib/recipe-view";
import { RecipeFlow } from "../../../components/recipes/recipe-flow";
import { Card } from "../../../components/ui/card";

export const metadata = { title: "Recipes · StateAction.ai" };
export const dynamic = "force-dynamic";

export default async function RecipesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const staff = await requireConsoleSession(["staff"]);
  const devices = (await searchParams).tab === "devices";
  const { recipes, captureSources } = await pipelineReads().recipeCatalog(
    staff.userId,
  );

  return (
    <div className="grid gap-4">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Recipes</h1>
        <p className="mt-1 text-sm text-muted">
          Recipes and capture sources are defined in code.
        </p>
      </header>
      <nav aria-label="Recipes" className="flex gap-4 border-b border-line">
        {[
          ["/recipes", "Recipes", !devices],
          ["/recipes?tab=devices", "Devices", devices],
        ].map(([href, label, active]) => (
          <Link
            key={String(href)}
            href={String(href)}
            aria-current={active ? "page" : undefined}
            className={`px-2 py-2 text-sm font-semibold ${active ? "border-b-2 border-brand text-brand" : "text-muted"}`}
          >
            {label}
          </Link>
        ))}
      </nav>
      {devices ? (
        <div className="grid gap-3">
          {captureSources.map((source) => (
            <Card
              key={source.id}
              className="flex flex-wrap items-center gap-4 p-4 sm:p-5"
            >
              <div className="min-w-0">
                <h2 className="font-bold">{source.label}</h2>
                <p className="text-sm text-muted wrap-anywhere">
                  Android · Capture format v1 · H.264, IMU and live ARCore pose
                </p>
              </div>
              {source.defaultRecipeId && (
                <div className="flex min-w-0 items-center gap-3">
                  <ArrowRight
                    size={20}
                    className="shrink-0 text-brand"
                    aria-hidden="true"
                  />
                  <div className="grid">
                    <span className="text-xs text-muted">Default recipe</span>
                    <Link
                      href={recipeHref(source.defaultRecipeId)}
                      className="font-semibold text-brand underline wrap-anywhere"
                    >
                      {recipeLabel(source.defaultRecipeId)}
                    </Link>
                  </div>
                </div>
              )}
            </Card>
          ))}
          <Card className="p-4 sm:p-5">
            <h2 className="font-bold">Custom capture devices</h2>
            <p className="text-sm text-muted">
              An engineer can add a capture source in code.
            </p>
          </Card>
        </div>
      ) : (
        <div className="grid items-start gap-3 lg:grid-cols-2">
          {recipes.map((entry) => (
            <Card key={entry.id} className="grid min-w-0 gap-3 p-4 sm:p-5">
              <h2 className="text-lg font-bold wrap-anywhere">
                <Link
                  href={recipeHref(entry.id)}
                  className="text-brand underline"
                >
                  {entry.label}
                  {entry.kind === "recipe" && entry.label !== entry.id
                    ? " · " + entry.id
                    : ""}
                </Link>
              </h2>
              <p className="text-sm text-muted">
                {entry.kind === "workflow"
                  ? "FLORA segmentation and captions with CPU hand tracking."
                  : "Plans clips and runs segmentation, captioning and hand tracking."}
              </p>
              <RecipeFlow recipe={entry.recipe} />
              <div className="grid gap-1 text-sm text-muted">
                <p>
                  {entry.recordingCount}{" "}
                  {entry.recordingCount === 1 ? "recording" : "recordings"}
                </p>
                <p>
                  {entry.estimatedUsdPerVideoHour === null
                    ? "Cost per video-hour unavailable"
                    : `Estimated $${entry.estimatedUsdPerVideoHour} USD per video-hour`}
                </p>
                {entry.captureSources.map((source) => (
                  <p key={source.id}>
                    {source.label}
                    {source.defaultRecipeId === entry.id ? " · Default" : ""}
                  </p>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
