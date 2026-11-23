import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { requestSha256, type RecipeV1 } from "@stateaction/contracts";
import type { JobsApi } from "./api-client.js";

/**
 * SA-96: rerun one recipe stage (segment or caption) from cached inputs through the file-backed
 * `run-stage --io-dir` mode (no claim, no HTTP, no server write). The inputs of a job live in the
 * dev-stack cache `<cacheDir>/<jobId>/`: `source.mcap`, `task-input.json` (the admitted v3 task
 * input) and `outputs/segments.json` (caption only). The recipe comes from the jobs API. A
 * `flora_*` module is a paid GPU module: it is refused without `--allow-spend` and, even with it,
 * only the Modal harness (not this local runner) may execute it.
 */
const MODULE = /^[a-z][a-z0-9_]{0,63}$/;
const STAGES = ["segment", "caption"] as const;
type ReplayStage = (typeof STAGES)[number];

export type ReplayDeps = {
  api: Pick<JobsApi, "recipe">;
  cacheDir: string;
  python: string;
  workerDir: string;
  /** Test seam: runs the worker and returns its exit code. */
  run?: (args: string[], env: NodeJS.ProcessEnv, cwd: string) => number;
};

export type ReplayOptions = {
  jobId: string;
  stage: string;
  module?: string | undefined;
  ioDir: string;
  allowSpend?: boolean | undefined;
};

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

export async function replayStage(deps: ReplayDeps, options: ReplayOptions) {
  const stage = options.stage as ReplayStage;
  if (!STAGES.includes(stage))
    throw new Error("--stage must be segment or caption");
  const recipe = await deps.api.recipe(options.jobId);
  if (!recipe) throw new Error("job has no recipe: nothing to replay");
  const entry = recipe.stages.find((s) => s.stage === stage);
  if (!entry) throw new Error(`recipe has no ${stage} stage`);
  if (entry.resources.gpu !== "none" && !options.allowSpend)
    throw new Error(
      `the ${stage} stage requests a GPU: pass --allow-spend and run it through the Modal harness`,
    );
  const [name, version = "1"] = (options.module ?? entry.module).split("@");
  if (!name || !MODULE.test(name) || !/^[1-9][0-9]{0,5}$/.test(version))
    throw new Error("--module must be <module_id>[@version]");
  if (name.startsWith("flora_")) {
    if (!options.allowSpend)
      throw new Error(
        `${name} is a paid GPU module: pass --allow-spend and run it through the Modal harness`,
      );
    throw new Error(
      `${name} runs only through the Modal harness, never this local replay`,
    );
  }
  const module = `${name}@${version}`;
  const replayed = {
    ...recipe,
    stages: recipe.stages.map((s) =>
      s.stage === stage ? { ...s, module } : s,
    ),
  } as RecipeV1;
  const jobCache = resolve(deps.cacheDir, options.jobId);
  const need = (path: string) => {
    if (!existsSync(path))
      throw new Error(
        `cached input missing: ${path.slice(jobCache.length + 1)}`,
      );
    return path;
  };
  const taskInput = JSON.parse(
    readFileSync(need(join(jobCache, "task-input.json")), "utf8"),
  ) as Record<string, unknown>;
  const recipeSha256 = requestSha256(replayed);
  mkdirSync(options.ioDir, { recursive: true, mode: 0o700 });
  copyFileSync(
    need(join(jobCache, "source.mcap")),
    join(options.ioDir, "source.mcap"),
  );
  const boot: Record<string, unknown> = {
    schemaVersion: 2,
    jobId: options.jobId,
    executionRef: `replay-${options.jobId}`,
    stage,
    module,
    recipeSha256,
    taskInput: {
      ...taskInput,
      schemaVersion: 3,
      recipe: replayed,
      recipeSha256,
    },
  };
  if (stage === "caption") {
    const segments = readFileSync(
      need(join(jobCache, "outputs/segments.json")),
    );
    writeFileSync(join(options.ioDir, "segments.json"), segments);
    boot.segmentsSha256 = sha256(segments);
  }
  writeFileSync(join(options.ioDir, "bootstrap.json"), JSON.stringify(boot));
  const env = { ...process.env, APP_ENV: "local" };
  const args = [
    "-m",
    "stateaction_processing",
    "run-stage",
    "--io-dir",
    options.ioDir,
  ];
  const code = (
    deps.run ??
    ((a, e, c) =>
      spawnSync(deps.python, a, { env: e, cwd: c, stdio: "inherit" }).status ??
      1)
  )(args, env, deps.workerDir);
  const receiptPath = join(options.ioDir, "receipt.json");
  return {
    exitCode: code,
    module,
    receipt: existsSync(receiptPath)
      ? (JSON.parse(readFileSync(receiptPath, "utf8")) as Record<
          string,
          unknown
        >)
      : null,
  };
}
