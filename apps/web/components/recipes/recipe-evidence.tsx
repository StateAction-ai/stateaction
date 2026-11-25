import type { RecipeV1 } from "@stateaction/contracts";
import { moduleManifestEntry } from "@stateaction/contracts";
import {
  formatDuration,
  formatUsd,
  nodeDurationSeconds,
  type CachedImport,
  type RecipeVisualization,
} from "@stateaction/server/pipeline";
import { RECIPE_STAGES } from "../../lib/recipe-view";
import {
  ProcessingStatus,
  processingReason,
} from "../recordings/processing-stage";
import { Card } from "../ui/card";

function formatted(value: unknown): string {
  if (value == null || value === "") return "Not recorded";
  return typeof value === "object"
    ? JSON.stringify(value, null, 2)
    : String(value);
}

function Evidence({
  fields,
}: {
  fields: readonly (readonly [string, unknown])[];
}) {
  return (
    <dl className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
      {fields.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted">{label}</dt>
          <dd className="text-sm wrap-anywhere whitespace-pre-wrap">
            {formatted(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function RecipeEvidence({
  recipe,
  exact,
}: {
  recipe: RecipeV1;
  exact?: RecipeVisualization | null;
}) {
  return (
    <section className="grid gap-3" aria-labelledby="recipe-stage-details">
      <h2 id="recipe-stage-details" className="text-lg font-bold">
        Stage details
      </h2>
      {recipe.stages.map((spec) => {
        const node = exact?.run?.stages.find(
          ({ stage }) => stage === spec.stage,
        );
        const recorded = exact?.producers[spec.stage];
        const producer = recorded === "unavailable" ? null : recorded;
        const reuse = exact?.run?.reuse.find(
          ({ stage }) => stage === spec.stage,
        );
        const module = moduleManifestEntry(spec.module);
        const error =
          node?.state === "submit_unknown"
            ? exact?.unknownReasons[spec.stage]
            : node?.errorCode;
        return (
          <Card
            key={spec.stage}
            id={`stage-${spec.stage}`}
            className="grid gap-3 p-4 sm:p-5"
          >
            <div className="flex flex-wrap justify-between gap-2">
              <h3 className="font-bold">{RECIPE_STAGES[spec.stage]}</h3>
              {node ? (
                <ProcessingStatus state={node.state} />
              ) : (
                !spec.enabled && (
                  <span className="text-sm text-muted">Disabled</span>
                )
              )}
            </div>
            {error && (
              <p className="text-sm text-muted">
                {processingReason(error)} <code>{error}</code>
              </p>
            )}
            {reuse && (
              <p className="text-sm text-muted">
                Used output from run{" "}
                <code>{reuse.sourceJobId.slice(0, 8)}</code>.
              </p>
            )}
            <Evidence
              fields={[
                ["Module", spec.module],
                ["Declared model", module?.provenance.modelName],
                ["Declared revision", module?.provenance.modelRevision],
                ["License", module?.license.id],
                [
                  "Requested compute",
                  spec.resources.gpu === "none" ? "CPU" : spec.resources.gpu,
                ],
                ["Time budget", formatDuration(spec.resources.budgetSeconds)],
                ...(node
                  ? ([
                      ["Observed GPU", node.gpu.observedType],
                      [
                        "Execution time",
                        nodeDurationSeconds(node) === null
                          ? null
                          : formatDuration(nodeDurationSeconds(node)),
                      ],
                      ["Estimated cost", formatUsd(node.estimatedCostUsd)],
                      ["Started (UTC)", node.startedAt],
                    ] as const)
                  : []),
              ]}
            />
            <details className="border-t border-line pt-2">
              <summary className="w-fit cursor-pointer text-sm font-semibold text-brand">
                Configuration and provenance
              </summary>
              <div className="mt-3">
                <Evidence
                  fields={[
                    ["Configured parameters", spec.params],
                    ["Container limit", spec.resources.maxContainers],
                    ...(node
                      ? ([
                          ["Recorded model", producer?.model_name],
                          ["Recorded revision", producer?.model_revision],
                          ["Weights SHA-256", producer?.weights_sha256],
                          ["Prompt SHA-256", producer?.prompt_sha256],
                          ["Decoding parameters", producer?.decoding_params],
                          ["Engine", producer?.engine],
                          ["Quantization", producer?.quant],
                          ["Stage receipt SHA-256", node.receiptSha256],
                          ["Counts", node.counts],
                        ] as const)
                      : []),
                  ]}
                />
              </div>
            </details>
          </Card>
        );
      })}
    </section>
  );
}

export function CachedRecipeEvidence({ cached }: { cached: CachedImport }) {
  const { attribution, evidence } = cached;
  return (
    <section className="grid gap-3" aria-labelledby="workflow-evidence">
      <h2 id="workflow-evidence" className="text-lg font-bold">
        Recorded workflow evidence
      </h2>
      <p className="text-sm text-muted">
        {attribution.dataset} by {attribution.creators}. {attribution.license}.{" "}
        {attribution.changes}
      </p>
      {Object.entries(RECIPE_STAGES).map(([stage, title]) => {
        const fields = evidence[stage];
        return (
          <Card key={stage} className="grid gap-3 p-4 sm:p-5">
            <h3 className="font-bold">{title}</h3>
            <Evidence
              fields={[
                ["Generator", fields?.generator],
                ["Model", fields?.model],
                ["Revision", fields?.revision],
                ["Weights SHA-256", fields?.weightsSha256],
                ["Prompt SHA-256", fields?.promptSha256],
                ["Decoding parameters", fields?.decoding],
                ["Requested GPU", fields?.requestedGpu],
                ["Observed GPU", fields?.observedGpu ?? fields?.gpuReport],
                ["Estimated cost", null],
              ]}
            />
          </Card>
        );
      })}
    </section>
  );
}
