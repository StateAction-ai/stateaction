import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { requestSha256 } from "@stateaction/contracts";
import { renderHostedMarker } from "../admission/simulation.js";
import type { TaskInputBuilder } from "./service.js";

/**
 * SA-96: local-only per-recording recipe override. `STATEACTION_LOCAL_RECIPE_DIR` names a
 * directory with one `<recording-id>.json` recipe per recording; admission reads it and builds the
 * v3 task input with that inline recipe. It exists so a dev stack can run scenario recipes
 * (stub/replay modules) through the real pipeline path. Like the SA-71 simulation gate, it is
 * accepted ONLY with APP_ENV exactly `local` outside a Render deployment; in every other
 * environment its mere presence is a configuration error and startup refuses.
 */
export const LOCAL_RECIPE_DIR = "STATEACTION_LOCAL_RECIPE_DIR";
const RECORDING_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RECIPE_BYTES = 64 * 1024;

export function localRecipeDir(
  env: Record<string, string | undefined>,
): string | undefined {
  const raw = env[LOCAL_RECIPE_DIR];
  if (raw === undefined) return undefined;
  if (env.APP_ENV !== "local" || renderHostedMarker(env) !== undefined)
    throw new Error(
      `${LOCAL_RECIPE_DIR} is refused outside APP_ENV=local and in hosted deployments; remove it`,
    );
  if (raw === "") return undefined;
  if (!isAbsolute(raw))
    throw new Error(`${LOCAL_RECIPE_DIR} must be an absolute directory`);
  return raw;
}

/**
 * Wraps a task-input builder: a recording with a recipe file gets the v3 input; any other
 * recording keeps the base (v2) input. A malformed file yields an input the contract validation
 * rejects, so only that job is rejected at admission (never silently run without its recipe).
 */
export function withLocalRecipes(
  base: TaskInputBuilder,
  dir: string,
): TaskInputBuilder {
  return async (q, job) => {
    const input = await base(q, job);
    if (!RECORDING_ID.test(job.recordingId)) return input;
    let text: string;
    try {
      text = await readFile(join(dir, `${job.recordingId}.json`), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return input;
      throw error;
    }
    let recipe: unknown;
    try {
      if (text.length > MAX_RECIPE_BYTES) throw new Error("too large");
      recipe = JSON.parse(text);
    } catch {
      return { ...input, schemaVersion: 3, recipe: null, recipeSha256: "" };
    }
    return {
      ...input,
      schemaVersion: 3,
      recipe,
      recipeSha256: requestSha256(recipe),
    };
  };
}
