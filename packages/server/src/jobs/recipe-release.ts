import { readCompiledRecipe } from "@stateaction/contracts";
import cpu from "../../../../recipes/compiled/cpu_hand_canary.json" with { type: "json" };
import indego from "../../../../recipes/compiled/indego_hosted_canary.json" with { type: "json" };
import plan from "../../../../modules/clip_filter_passthrough/module.lock.json" with { type: "json" };
import caption from "../../../../modules/flora_captioner_vllm_fp8/module.lock.json" with { type: "json" };
import segment from "../../../../modules/flora_tempseg_vllm_fp8/module.lock.json" with { type: "json" };
import hand from "../../../../modules/hand_pose_cpu/module.lock.json" with { type: "json" };
import video from "../../../../modules/recording_mp4_remux/module.lock.json" with { type: "json" };

export const DEFAULT_RECIPE_REF = "indego_hosted_canary@2";
export const CPU_CANARY_RECIPE_REF = "cpu_hand_canary@1";

const locks = new Map(
  [plan, caption, segment, hand, video].map((lock) => [
    `${lock.manifest.id}@${lock.manifest.version}`,
    lock,
  ]),
);
const published = new Map<string, { graph: unknown; sha256: string }>([
  [
    DEFAULT_RECIPE_REF,
    {
      graph: indego,
      sha256:
        "0ecd6b2a8a3ea482431d31ef934d1832fb578341c05dbe21099d20b7be15c85e",
    },
  ],
  [
    CPU_CANARY_RECIPE_REF,
    {
      graph: cpu,
      sha256:
        "8b8a626a4476de8a4c95ce5110142279105a61ee4667fd54f11bf2e3aa96a24e",
    },
  ],
]);

export function publishedRecipe(ref: string) {
  const entry = published.get(ref);
  if (!entry) return undefined;
  return readCompiledRecipe(entry.graph, ref, entry.sha256, locks);
}
