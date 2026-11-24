import type { RecipeV1, SimulationProvenance } from "@stateaction/contracts";

export const PUBLIC_VIDEO_CANARY = "STATEACTION_PUBLIC_VIDEO_CANARY";
export const PUBLIC_VIDEO_LABEL = "IndEgo.User_15_410_0511_1_480";
// The converter output verified at 2,990 frames and 299 seconds for SA-81.
const APPROVED_MCAP_SHA256 =
  "4e5e5a2abfe6d867a86ce8a254b1a85f225c0c1d57e05b2a74d8a538861f9e32";

export type PublicVideoCanary = {
  ownerUserId: string;
  clientRecordingId: string;
  sourceSha256: string;
};

export function publicVideoCanaryFromEnv(
  env: Record<string, string | undefined>,
): PublicVideoCanary | undefined {
  const raw = env[PUBLIC_VIDEO_CANARY];
  if (raw === undefined) return undefined;
  const invalid = () => new Error(`Invalid ${PUBLIC_VIDEO_CANARY} setting`);
  if (
    env.APP_ENV !== "production" ||
    !/^srv-[a-z0-9]+$/.test(env.RENDER_SERVICE_ID ?? "") ||
    env.IS_PULL_REQUEST === "true" ||
    env.PROCESSING_EXECUTION_BACKEND !== "modal" ||
    raw.length > 512
  )
    throw invalid();
  let value: Partial<PublicVideoCanary> | null;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (
    !value ||
    Object.keys(value).length !== 3 ||
    typeof value.ownerUserId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/.test(value.ownerUserId) ||
    typeof value.clientRecordingId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.clientRecordingId,
    ) ||
    value.sourceSha256 !== APPROVED_MCAP_SHA256
  )
    throw invalid();
  return {
    ownerUserId: value.ownerUserId,
    clientRecordingId: value.clientRecordingId,
    sourceSha256: value.sourceSha256,
  };
}

export function isPublicVideoProvenance(
  simulation: SimulationProvenance | null | undefined,
): boolean {
  if (!simulation) return false;
  const { camera, encoder, clock } = simulation.provenance;
  return (
    camera.status === "known" &&
    camera.label === PUBLIC_VIDEO_LABEL &&
    encoder.status === "unknown" &&
    clock.status === "unknown"
  );
}

export const PUBLIC_VIDEO_RECIPE: RecipeV1 = {
  schemaVersion: 1,
  recipeId: "indego_hosted_canary@1",
  maxJobCostUsd: "3.00",
  stages: [
    {
      stage: "segment",
      enabled: true,
      module: "flora_tempseg_vllm_fp8@1",
      params: {},
      resources: {
        gpu: "RTX-PRO-6000",
        budgetSeconds: 800,
        maxContainers: 1,
        retries: 0,
      },
    },
    {
      stage: "caption",
      enabled: true,
      module: "flora_captioner_vllm_fp8@1",
      params: {},
      resources: {
        gpu: "RTX-PRO-6000",
        budgetSeconds: 1300,
        maxContainers: 1,
        retries: 0,
      },
    },
    {
      stage: "hand_pose",
      enabled: true,
      module: "hand_pose_cpu_v1@1",
      params: {},
      resources: {
        gpu: "none",
        budgetSeconds: 1100,
        maxContainers: 1,
        retries: 0,
      },
    },
  ],
};
