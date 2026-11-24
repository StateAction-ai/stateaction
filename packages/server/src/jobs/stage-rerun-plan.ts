import {
  requestSha256,
  type ParamMap,
  type Producer,
  type RecipeV1,
  type Stage,
} from "@stateaction/contracts";
import { TransportError } from "../transport/errors.js";

export type RerunScope = "only" | "from_here";

export function executionStages(
  recipe: RecipeV1,
  stage: Stage,
  scope: RerunScope,
): Stage[] {
  if (!recipe.stages.find((entry) => entry.stage === stage)?.enabled) {
    throw new TransportError("conflict", "stage_disabled");
  }
  if (stage !== "segment" || !recipe.stages[1].enabled) return [stage];
  if (scope === "only") {
    throw new TransportError("conflict", "requires_caption_rerun");
  }
  return ["segment", "caption"];
}

type FingerprintInput = ({ params: ParamMap } | { paramsSha256: string }) & {
  stage: Stage;
  module: string;
  sourceManifestSha256: string;
  inputDigests: { role: string; sha256: string }[];
  producer: Pick<
    Producer,
    | "engine"
    | "model_name"
    | "model_revision"
    | "weights_sha256"
    | "quant"
    | "prompt_sha256"
    | "decoding_params"
    | "gpu"
  >;
};

export function stageFingerprint(input: FingerprintInput): string {
  const { gpu, ...producer } = input.producer;
  const inputDigests = input.inputDigests.toSorted((a, b) => {
    if (a.role !== b.role) return a.role < b.role ? -1 : 1;
    return a.sha256 < b.sha256 ? -1 : Number(a.sha256 !== b.sha256);
  });
  return requestSha256({
    schemaVersion: 1,
    stage: input.stage,
    module: input.module,
    paramsSha256:
      "paramsSha256" in input
        ? input.paramsSha256
        : requestSha256(input.params),
    sourceManifestSha256: input.sourceManifestSha256,
    inputDigests,
    producer: { ...producer, requestedGpu: gpu.requested_type },
  });
}
