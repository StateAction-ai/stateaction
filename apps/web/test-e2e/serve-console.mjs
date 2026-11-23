// Starts the real stack and keeps it running for manual/agent-browser checks.
// Prints one JSON line (origin, seeded emails, password) to stdout; stop with
// SIGTERM. The password is a throwaway for this ephemeral database only.
//
// `--seed annotations` (SA-96) also uploads simulated recordings through the real SA-71 path and
// runs them through the local loopback controller with stub or replay modules (zero model spend),
// then prints the recordings, job ids and stage states. Needs the built web app, the built jobs
// app (`pnpm --filter @stateaction/jobs... build`), the processing venv and the Render CLI.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startStack } from "./harness.mjs";

const args = process.argv.slice(2);
const seedAt = args.indexOf("--seed");
const seed = seedAt === -1 ? undefined : args[seedAt + 1];
if (seed !== undefined && seed !== "annotations") {
  console.error(`unknown --seed ${seed} (supported: annotations)`);
  process.exit(2);
}
let seedMod;
let dirs;
let stack;
let stopRunner = () => {};
if (seed) {
  const guards = await import("./seed-scenarios.mjs");
  try {
    guards.refuseNonLocalEnv(process.env);
    for (const sc of Object.values({
      ...guards.SYNTHETIC_SCENARIOS,
      ...guards.REPLAY_SCENARIOS,
    }))
      guards.refuseSpend(sc.recipe);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  seedMod = await import("./seed-annotations.mjs");
  dirs = seedMod.newSeedDirs();
}
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const python =
  process.env.PYTHON_EXECUTABLE ??
  join(repoRoot, "workers/processing/.venv/bin/python");
const stackOptions = seed
  ? {
      storage: true,
      extraEnv: {
        ...seedMod.jobsEnv(python),
        STATEACTION_LOCAL_RECIPE_DIR: dirs.recipes,
      },
    }
  : {};
stack = await startStack(stackOptions);
const done = async () => {
  stopRunner();
  await stack.stop();
  process.exit(0);
};
process.on("SIGTERM", done);
process.on("SIGINT", done);
let seeded;
if (seed) {
  try {
    const result = await seedMod.seedAnnotations(stack, {
      dirs,
      python,
      renderCli:
        process.env.RENDER_CLI ??
        join(repoRoot, "artifacts/platform-tools/render/render"),
      log: (line) => console.error(`[seed] ${line}`),
    });
    stopRunner = result.stopRunner;
    seeded = result.summary;
  } catch (error) {
    console.error(
      "seed failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    await stack.stop();
    process.exit(1);
  }
}
console.log(
  JSON.stringify({
    origin: stack.origin,
    password: stack.password,
    users: stack.users,
    ...(seeded && { seed: seeded }),
  }),
);
// STATEACTION_SEED_EXIT=1: print the result, tear everything down and exit (repeat-run checks).
if (process.env.STATEACTION_SEED_EXIT === "1") await done();
setInterval(() => {}, 1 << 30);
