import type { Stage } from "@stateaction/contracts";

export const RECIPE_STAGES = {
  segment: "Find action segments",
  caption: "Write captions",
  hand_pose: "Track hands and seal results",
} satisfies Record<Stage, string>;

export function parseRecipeId(param: string): string | null {
  try {
    const id = decodeURIComponent(param);
    return /^[a-z][a-z0-9_]{0,63}@[1-9][0-9]{0,5}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function recipeHref(
  recipeId: string,
  jobId: string,
  options: { stage?: Stage; recipeOnly?: boolean } = {},
) {
  const query = new URLSearchParams({ job: jobId });
  if (options.recipeOnly) query.set("view", "recipe");
  return `/recipes/${encodeURIComponent(recipeId)}?${query}${options.stage ? `#stage-${options.stage}` : ""}`;
}
