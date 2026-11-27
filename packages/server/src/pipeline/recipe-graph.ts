import {
  moduleManifestEntry,
  type CompiledGraph,
  type RecipeV1,
} from "@stateaction/contracts";
import { RECIPE_STEP_LABEL, type RecipeStage } from "./model.js";
import type {
  StageAttempt,
  OperationStageHistory,
} from "./recording-operations.js";

export type RecipeGraphNode = {
  id: string;
  label: string;
  scope: "recording" | "clip";
  parents: string[];
  model?: string | undefined;
  compute?: string | undefined;
  licence?: string | undefined;
  inputs?: string[];
  outputs?: string[];
  status?: string;
  summary?: string;
};

const source: RecipeGraphNode = {
  id: "$source",
  label: "Source video",
  scope: "recording",
  parents: [],
  outputs: ["Original recording"],
};
const plan: RecipeGraphNode = {
  id: "clip_plan",
  label: "Clip planning",
  scope: "recording",
  parents: [source.id],
  compute: "CPU",
  outputs: ["Clip time ranges"],
};
const clips: RecipeGraphNode = {
  id: "$clips",
  label: "Clips",
  scope: "recording",
  parents: [plan.id],
  outputs: ["One run per clip"],
};
const input: RecipeGraphNode = {
  id: "$input",
  label: "Clip video",
  scope: "clip",
  parents: [],
  outputs: ["Source time range"],
};

function humanName(id: string) {
  const words = id.replaceAll("_", " ").replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function compiledRecipeGraph(graph: CompiledGraph): RecipeGraphNode[] {
  const fanOut = graph.fanOut?.clip.split(".")[0];
  const nodes = graph.topoOrder.map((id): RecipeGraphNode => {
    const node = graph.nodes[id]!;
    const manifest = moduleManifestEntry(node.module);
    const parents = node.producers.map((producer) =>
      producer === fanOut && node.scope === "clip" ? clips.id : producer,
    );
    if (
      Object.values(node.inputs).some(({ from }) => from === "recording.source")
    )
      parents.unshift(source.id);
    return {
      id,
      label: humanName(id),
      scope: node.scope,
      parents,
      model: manifest?.provenance.modelName,
      compute: node.resources.gpu ?? "CPU",
      licence: graph.license.nonCommercialModules.includes(node.module)
        ? "Research use only"
        : (manifest?.license.id ?? "Commercial use permitted"),
      inputs: Object.keys(node.inputs).map(humanName),
      outputs: Object.keys(node.outputs).map(humanName),
    };
  });
  if (!fanOut) return [source, ...nodes];
  const index = nodes.findIndex(({ id }) => id === fanOut);
  nodes.splice(index + 1, 0, { ...clips, parents: [fanOut] });
  return [source, ...nodes];
}

export function attemptStatus(run: StageAttempt) {
  if (
    run.error?.code &&
    ["stage_timeout", "deadline_exceeded", "execution_timeout"].includes(
      run.error.code,
    )
  )
    return "timed_out";
  if (run.error?.code === "failed_outputs") return "partially_complete";
  return run.state;
}

export function v1RecipeGraph(
  recipe: RecipeV1 | null,
  scope: "definition" | "recording" | "clip",
  histories: readonly OperationStageHistory[] = [],
): RecipeGraphNode[] {
  if (scope === "recording") return [source, plan, clips];
  const nodes =
    scope === "clip" ? [input] : recipe ? [source, plan, clips] : [];
  const root = scope === "clip" ? input.id : clips.id;
  const enabled = recipe?.stages.filter((step) => step.enabled) ?? [];
  for (const id of Object.keys(RECIPE_STEP_LABEL) as RecipeStage[]) {
    const spec = enabled.find((step) => step.stage === id);
    const history = histories.find((entry) => entry.stage === id);
    if (
      !spec &&
      (recipe ||
        !history ||
        !(
          history.latest ||
          history.importedEvidence ||
          history.attempts.length
        ))
    )
      continue;
    const imported = history?.importedEvidence;
    const manifest = moduleManifestEntry(
      spec?.module ?? history?.latest?.module ?? "",
    );
    nodes.push({
      id,
      label: RECIPE_STEP_LABEL[id],
      scope: "clip",
      parents:
        id === "caption" && nodes.some((node) => node.id === "segment")
          ? ["segment"]
          : [root],
      model: imported?.model ?? manifest?.provenance.modelName,
      compute: spec
        ? spec.resources.gpu === "none"
          ? "CPU"
          : spec.resources.gpu
        : (imported?.gpu ?? undefined),
      licence:
        manifest?.license.commercialUse === false
          ? "Research use only"
          : manifest?.license.id,
      outputs: manifest?.outputs.map(humanName) ?? [],
    });
  }
  return nodes;
}

export function withStageStatus(
  node: RecipeGraphNode,
  history?: OperationStageHistory,
): RecipeGraphNode {
  return {
    ...node,
    status:
      history?.reusedFromJobId && history.reusableOutput
        ? "reused"
        : history?.latest
          ? attemptStatus(history.latest)
          : history?.importedEvidence
            ? "output_available"
            : "not_run",
  };
}
