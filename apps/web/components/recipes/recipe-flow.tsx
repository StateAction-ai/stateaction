import { ArrowDown } from "lucide-react";
import { moduleManifestEntry, type RecipeV1 } from "@stateaction/contracts";
import { RECIPE_STAGES } from "../../lib/recipe-view";

const archivedWorkflow = [
  { name: "Find action segments", model: "FLORA TempSeg", compute: "A100" },
  { name: "Write captions", model: "FLORA Captioner", compute: "H100" },
  { name: "Track hands and seal results", model: "MediaPipe", compute: "CPU" },
];

export function RecipeFlow({ recipe }: { recipe: RecipeV1 | null }) {
  const stages = recipe
    ? recipe.stages.map((stage) => ({
        name: RECIPE_STAGES[stage.stage],
        model:
          moduleManifestEntry(stage.module)?.provenance.modelName ??
          stage.module,
        compute: !stage.enabled
          ? "Disabled"
          : stage.resources.gpu === "none"
            ? "CPU"
            : stage.resources.gpu,
      }))
    : archivedWorkflow;
  const connector = (
    <ArrowDown size={16} className="mx-auto text-brand" aria-hidden="true" />
  );

  function node({ name, model, compute }: (typeof stages)[number]) {
    return (
      <div className="min-w-0 rounded-lg border border-line bg-paper p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <strong className="text-sm">{name}</strong>
          <span
            className={`rounded px-2 py-0.5 text-xs font-semibold ${compute === "CPU" ? "bg-field text-muted" : "bg-brand-soft text-brand-ink"}`}
          >
            {compute}
          </span>
        </div>
        <p className="mt-1 text-xs wrap-anywhere text-muted">{model}</p>
      </div>
    );
  }

  return (
    <figure className="m-0 grid gap-2">
      <div className="rounded-lg border border-line bg-field p-3 text-center text-sm font-semibold">
        Source recording
      </div>
      {connector}
      {recipe && (
        <>
          {node({
            name: "Clip planning",
            model: "Select clip ranges",
            compute: "CPU",
          })}
          {connector}
        </>
      )}
      <div className="grid gap-3 sm:grid-cols-[1.1fr_1fr]">
        <ol aria-label="Actions and captions" className="grid gap-2">
          <li>{node(stages[0]!)}</li>
          <li className="grid gap-2">
            {connector}
            {node(stages[1]!)}
          </li>
        </ol>
        <ol aria-label="Hand tracking">
          <li>{node(stages[2]!)}</li>
        </ol>
      </div>
    </figure>
  );
}
