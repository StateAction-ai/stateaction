export { default as floraCheckpointPins } from "../api/flora-checkpoints.v1.json" with { type: "json" };
import { requestSha256 } from "./canonical.js";
import type { ModalRerunBinding, RecipeV1, Sha256Hex } from "./types.js";

const digest = /^[0-9a-f]{64}$/;

export function immutableModalAppName(
  module: string,
  codeRevision: string,
  paramsSha256: Sha256Hex,
): string {
  const stage = module.split("@")[0]!.replaceAll("_", "-").slice(0, 23);
  const deployment = requestSha256({ module, codeRevision, paramsSha256 });
  return `stateaction-${stage}-${deployment.slice(0, 24)}`;
}

export function modalBindingMatchesStage(
  binding: ModalRerunBinding,
  stage: RecipeV1["stages"][number],
): boolean {
  return (
    binding.gpu === stage.resources.gpu &&
    binding.maxContainers <= stage.resources.maxContainers &&
    binding.paramsSha256 === requestSha256(stage.params)
  );
}

const positiveBound = (
  value: number | undefined,
  max: number,
): value is number =>
  value !== undefined &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= max;

const bindingUnavailable = () => new Error("deployment_binding_unavailable");

/** A rate and resource record from inspection of the exact deployed function. */
export function parseModalRerunBindings(
  raw: string | undefined,
): ReadonlyMap<string, ModalRerunBinding> {
  if (!raw) return new Map();
  if (raw.length > 16384) throw bindingUnavailable();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw bindingUnavailable();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw bindingUnavailable();
  }
  const bindings = new Map<string, ModalRerunBinding>();
  for (const [module, value] of Object.entries(parsed)) {
    const entry = value as Partial<ModalRerunBinding> | null;
    if (
      !/^[a-z][a-z0-9_]{0,63}@[1-9][0-9]{0,5}$/.test(module) ||
      !entry ||
      typeof entry !== "object" ||
      typeof entry.functionId !== "string" ||
      !/^fu-[A-Za-z0-9]{1,77}$/.test(entry.functionId) ||
      typeof entry.definitionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(entry.definitionId) ||
      !positiveBound(entry.maxCpuMilli, 192_000) ||
      !positiveBound(entry.maxMemoryMib, 2_097_152) ||
      !positiveBound(entry.microUsdPerCpuSecond, 1_000_000) ||
      typeof entry.environment !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(entry.environment) ||
      typeof entry.gpu !== "string" ||
      !/^[0-9a-f]{40}$/.test(entry.codeRevision ?? "") ||
      !digest.test(entry.paramsSha256 ?? "") ||
      !digest.test(entry.definitionSha256 ?? "") ||
      entry.appName !==
        immutableModalAppName(
          module,
          entry.codeRevision!,
          entry.paramsSha256!,
        ) ||
      typeof entry.maxBilledSeconds !== "number" ||
      !Number.isSafeInteger(entry.maxBilledSeconds) ||
      entry.maxBilledSeconds < 1 ||
      entry.maxBilledSeconds > 43200 ||
      typeof entry.maxContainers !== "number" ||
      !Number.isSafeInteger(entry.maxContainers) ||
      entry.maxContainers < 1 ||
      entry.maxContainers > 100 ||
      typeof entry.microUsdPerGpuSecond !== "number" ||
      !Number.isSafeInteger(entry.microUsdPerGpuSecond) ||
      entry.microUsdPerGpuSecond < 0 ||
      (entry.gpu === "none") !== (entry.microUsdPerGpuSecond === 0)
    ) {
      throw bindingUnavailable();
    }
    bindings.set(module, {
      functionId: entry.functionId,
      definitionId: entry.definitionId,
      maxCpuMilli: entry.maxCpuMilli,
      maxMemoryMib: entry.maxMemoryMib,
      gpu: entry.gpu,
      environment: entry.environment,
      appName: entry.appName!,
      codeRevision: entry.codeRevision!,
      paramsSha256: entry.paramsSha256!,
      definitionSha256: entry.definitionSha256!,
      maxBilledSeconds: entry.maxBilledSeconds,
      maxContainers: entry.maxContainers,
      microUsdPerGpuSecond: entry.microUsdPerGpuSecond,
      microUsdPerCpuSecond: entry.microUsdPerCpuSecond,
    });
  }
  return bindings;
}
