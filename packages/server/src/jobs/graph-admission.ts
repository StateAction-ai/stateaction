import {
  immutableModalAppName,
  parseContract,
  requestSha256,
  type ClipTaskInputV4,
  type CompiledGraph,
  type TaskInputV2,
} from "@stateaction/contracts";
import { DEFAULT_RECIPE_REF, publishedRecipe } from "./recipe-release.js";
import { providerCostCents } from "./stage-rerun-bindings.js";

export type GraphReleaseBinding = {
  modelSha256?: string;
  promptSha256?: string;
  volumeManifestSha256?: string;
  modelRevision?: string;
  volumeName?: string;
  volumeVersion?: number;
  functionId?: string;
  definitionId?: string;
  imageId?: string;
  appName?: string;
  environment?: string;
  maxCpuMilli?: number;
  maxMemoryMib?: number;
  moduleLockSha256: string;
  codeRevision: string;
  paramsSha256: string;
  imageSha256: string;
  definitionSha256: string;
  definitionFormat: "local" | "modal-python-v1";
  mode: "local_cpu" | "local_replay" | "modal";
  gpu: string | null;
  maxContainers: 1;
  maxBilledSeconds: number;
  microUsdPerCpuSecond: number;
  microUsdPerGpuSecond: number;
};

const SHA256 = /^[0-9a-f]{64}$/;
const safeWholeNumber = (n: number, limit: number) =>
  Number.isSafeInteger(n) && n >= 0 && n <= limit;

function budgetSeconds(
  node: CompiledGraph["nodes"][string],
  sourceSeconds: number,
) {
  const { fixedSeconds, perSourceSecond } = node.resources.budget;
  const [whole, fraction = ""] = perSourceSecond.split(".");
  const microseconds =
    BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  return (
    fixedSeconds +
    Number((microseconds * BigInt(sourceSeconds) + 999999n) / 1000000n)
  );
}

export function configuredGraphBindings(
  raw: string | undefined,
): ReadonlyMap<string, GraphReleaseBinding> {
  if (!raw) return new Map();
  if (raw.length > 65536) throw new Error("deployment_binding_unavailable");
  const bindings: unknown = JSON.parse(raw);
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings))
    throw new Error("deployment_binding_unavailable");
  const keys = new Set([
    "imageId",
    "functionId",
    "definitionId",
    "appName",
    "environment",
    "modelSha256",
    "promptSha256",
    "volumeManifestSha256",
    "modelRevision",
    "volumeName",
    "volumeVersion",
    "maxCpuMilli",
    "maxMemoryMib",
    "moduleLockSha256",
    "codeRevision",
    "paramsSha256",
    "imageSha256",
    "definitionSha256",
    "definitionFormat",
    "mode",
    "gpu",
    "maxContainers",
    "maxBilledSeconds",
    "microUsdPerCpuSecond",
    "microUsdPerGpuSecond",
  ]);
  for (const value of Object.values(bindings)) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.has(key))
    )
      throw new Error("deployment_binding_unavailable");
  }
  return new Map(Object.entries(bindings));
}

export function resolveGraphRuntime(input: {
  graph: CompiledGraph;
  scope: "recording" | "clip";
  sourceSeconds: number;
  executionBackend: "local" | "modal";
  codeRevision: string;
  bindings: ReadonlyMap<string, GraphReleaseBinding>;
}) {
  const {
    graph,
    scope,
    sourceSeconds,
    executionBackend,
    codeRevision,
    bindings,
  } = input;
  if (
    !safeWholeNumber(sourceSeconds, graph.meta.limits.maxSourceSeconds) ||
    sourceSeconds === 0
  )
    throw new Error("graph_source_duration_invalid");
  const costs = { recording: 0n, clip: 0n };
  const runtimes = [];
  for (const id of graph.topoOrder) {
    const node = graph.nodes[id]!;
    if (scope === "clip" && node.scope !== "clip") continue;
    const binding = bindings.get(node.module);
    const seconds = budgetSeconds(node, sourceSeconds);
    const gpu = node.resources.gpu;
    const mode =
      executionBackend === "modal"
        ? "modal"
        : gpu === null
          ? "local_cpu"
          : "local_replay";
    if (
      !binding ||
      binding.definitionFormat !==
        (executionBackend === "modal" ? "modal-python-v1" : "local") ||
      binding.mode !== mode ||
      binding.moduleLockSha256 !== node.moduleLockSha256 ||
      binding.codeRevision !== codeRevision ||
      binding.paramsSha256 !== requestSha256(node.params) ||
      binding.gpu !== gpu ||
      !SHA256.test(binding.imageSha256) ||
      !SHA256.test(binding.definitionSha256) ||
      binding.maxContainers !== 1 ||
      !safeWholeNumber(binding.maxBilledSeconds, 7200) ||
      seconds > binding.maxBilledSeconds ||
      !safeWholeNumber(binding.microUsdPerCpuSecond, 1000000) ||
      !safeWholeNumber(binding.microUsdPerGpuSecond, 1000000) ||
      (executionBackend === "modal" &&
        (!/^fu-[A-Za-z0-9]{1,77}$/.test(binding.functionId ?? "") ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(binding.definitionId ?? "") ||
          !/^im-[A-Za-z0-9]{1,77}$/.test(binding.imageId ?? "") ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(binding.environment ?? "") ||
          binding.appName !==
            immutableModalAppName(
              node.module,
              codeRevision,
              binding.paramsSha256 as never,
            ) ||
          !safeWholeNumber(binding.maxCpuMilli ?? 0, 192000) ||
          !safeWholeNumber(binding.maxMemoryMib ?? 0, 2097152) ||
          !binding.maxCpuMilli ||
          !binding.maxMemoryMib ||
          binding.microUsdPerCpuSecond === 0 ||
          (gpu === null) !== (binding.microUsdPerGpuSecond === 0)))
    ) {
      throw new Error("deployment_binding_unavailable");
    }
    const billedSeconds =
      executionBackend === "modal" ? binding.maxBilledSeconds : seconds;
    const gpuCents = providerCostCents(
      binding,
      binding.microUsdPerGpuSecond,
      billedSeconds,
    );
    const computeCents =
      gpuCents +
      providerCostCents(binding, binding.microUsdPerCpuSecond, billedSeconds);
    costs[node.scope] += computeCents;
    runtimes.push([
      id,
      {
        binding,
        budgetSeconds: seconds,
        computeCostCents: Number(computeCents),
        gpuCostCents: Number(gpuCents),
      },
    ] as const);
  }
  const cents = (amount: string) => BigInt(amount.replace(".", ""));
  if (
    costs.clip > cents(graph.meta.limits.maxClipJobCostUsd) ||
    costs.recording + costs.clip > cents(graph.meta.limits.maxRecordingCostUsd)
  ) {
    throw new Error("recipe_cost_bound_exceeded");
  }
  return Object.fromEntries(runtimes);
}

export function graphTaskAdmission(input: {
  base: TaskInputV2;
  kind: "clip_plan" | "clip_pipeline";
  clip: ClipTaskInputV4["clip"] | null;
  selectedGraph: CompiledGraph | null;
  selectedSha256: string | null;
  parentGraph: CompiledGraph | null;
  executionBackend: "local" | "modal";
  codeRevision: string;
  bindings: ReadonlyMap<string, GraphReleaseBinding>;
}) {
  const { base, kind, clip, selectedGraph, selectedSha256, parentGraph } =
    input;
  const admitted = kind === "clip_pipeline" ? parentGraph : selectedGraph;
  if (
    (kind === "clip_pipeline" && (!admitted || !clip)) ||
    (kind === "clip_plan" &&
      selectedSha256 !== (selectedGraph?.recipeSha256 ?? null))
  )
    throw new Error("recipe_graph_unavailable");
  const graph = publishedRecipe(admitted?.recipe ?? DEFAULT_RECIPE_REF);
  if (!graph || (admitted && requestSha256(admitted) !== requestSha256(graph)))
    throw new Error("recipe_graph_unavailable");
  const ns = clip
    ? BigInt(clip.sourceRange.end_ts_ns) - BigInt(clip.sourceRange.start_ts_ns)
    : null;
  if (ns !== null && (ns < 0n || ns > 7200000000000n))
    throw new Error("graph_source_duration_invalid");
  const sourceSeconds =
    ns === null
      ? graph.meta.limits.maxSourceSeconds
      : Math.max(1, Number((ns + 999999999n) / 1000000000n));
  const runtime = resolveGraphRuntime({
    graph,
    scope: kind === "clip_plan" ? "recording" : "clip",
    sourceSeconds,
    executionBackend: input.executionBackend,
    codeRevision: input.codeRevision,
    bindings: input.bindings,
  });
  const task = parseContract<Record<string, unknown>>("jobs.task-input.v6", {
    ...base,
    schemaVersion: 6,
    kind,
    recipeRef: graph.recipe,
    recipeSha256: graph.recipeSha256,
    sourceSeconds,
    ...(clip ? { clip } : {}),
  });
  return { graph, runtime, task };
}
