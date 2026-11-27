import type { Stage } from "@stateaction/contracts";

export function parseRecipeId(param: string): string | null {
  try {
    const id = decodeURIComponent(param);
    return id === "flora-spike-c" ||
      /^[a-z][a-z0-9_]{0,63}@[1-9][0-9]{0,8}$/.test(id)
      ? id
      : null;
  } catch {
    return null;
  }
}

export function recipeLabel(id: string): string {
  if (id === "flora-spike-c") return "FLORA Spike C + CPU hand tracking";
  if (id === "indego_hosted_canary@1") return "IndEgo processing @1";
  return id.replaceAll("_", " ");
}

export function recipeHref(
  recipeId: string,
  jobId?: string,
  options: { stage?: Stage } = {},
) {
  const query = new URLSearchParams();
  if (jobId) query.set("job", jobId);
  if (options.stage) query.set("step", options.stage);
  return `/recipes/${encodeURIComponent(recipeId)}${query.size ? `?${query}` : ""}`;
}
