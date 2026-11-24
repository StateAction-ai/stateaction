import {
  modalBindingMatchesStage,
  parseModalRerunBindings,
  type ModalRerunBinding,
  type RecipeV1,
} from "@stateaction/contracts";
import { TransportError } from "../transport/errors.js";

export type RerunBinding = ModalRerunBinding;

/** The web planner reports invalid release bindings as a typed conflict. */
export function configuredRerunBindings(
  raw: string | undefined,
): ReadonlyMap<string, RerunBinding> {
  try {
    return parseModalRerunBindings(raw);
  } catch {
    throw bindingUnavailable();
  }
}

const bindingUnavailable = () =>
  new TransportError("conflict", "deployment_binding_unavailable");

export function rerunBinding(
  bindings: ReadonlyMap<string, RerunBinding> | undefined,
  stage: RecipeV1["stages"][number],
): RerunBinding {
  const binding = bindings?.get(stage.module);
  if (
    !binding ||
    !modalBindingMatchesStage(binding, stage) ||
    (binding.gpu !== "none" &&
      (binding.maxContainers !== 1 || binding.maxBilledSeconds <= 60))
  ) {
    throw bindingUnavailable();
  }
  return binding;
}

export const dollars = (cents: bigint) =>
  `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;

export function providerCostCents(
  binding: RerunBinding,
  microUsdPerSecond: number,
  seconds = binding.maxBilledSeconds,
): bigint {
  const micro =
    BigInt(microUsdPerSecond) * BigInt(seconds) * BigInt(binding.maxContainers);
  return (micro + 9999n) / 10000n;
}
