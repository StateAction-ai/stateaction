import type { RecipeV1 } from "@stateaction/contracts";
import { moduleManifestEntry } from "@stateaction/contracts";
import {
  formatDuration,
  formatUsd,
  nodeDurationSeconds,
  type CachedImport,
  type RecipeVisualization,
} from "@stateaction/server/pipeline";
import { processingReason } from "../recordings/processing-stage";

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
  spec,
  exact,
}: {
  spec: RecipeV1["stages"][number];
  exact?: RecipeVisualization | null;
}) {
  const node = exact?.run?.stages.find(({ stage }) => stage === spec.stage);
  const recorded = exact?.producers[spec.stage];
  const producer = recorded === "unavailable" ? null : recorded;
  const reuse = exact?.run?.reuse.find(({ stage }) => stage === spec.stage);
  const module = moduleManifestEntry(spec.module);
  const error =
    node?.state === "submit_unknown"
      ? exact?.unknownReasons[spec.stage]
      : node?.errorCode;
  return (
    <div className="grid gap-3">
      {error && (
        <p className="text-sm text-muted">
          {processingReason(error)} <code>{error}</code>
        </p>
      )}
      {reuse && (
        <p className="text-sm text-muted">Reused output from an earlier run.</p>
      )}
      <Evidence
        fields={[
          ["Declared revision", module?.provenance.modelRevision],

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
    </div>
  );
}
