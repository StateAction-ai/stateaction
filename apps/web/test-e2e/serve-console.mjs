// Starts the real stack and keeps it running for manual/agent-browser checks.
// Prints one JSON line (origin, seeded emails, password) to stdout; stop with
// SIGTERM. The password is a throwaway for this ephemeral database only.
//
// `--seed failure-fixtures` (SA-96) also uploads simulated recordings through the real SA-71 path and
// runs them through the local loopback controller with stub or replay modules (zero model spend),
// then prints the recordings, job ids and stage states. Needs the built web app, the built jobs
// app, the controller and processing venvs, and the pinned Render CLI.
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startStack } from "./harness.mjs";

const args = process.argv.slice(2);
const seedAt = args.indexOf("--seed");
const seed = seedAt === -1 ? undefined : args[seedAt + 1];
const bundles = seed === "cached" ? args.slice(seedAt + 2) : [];
if (
  seedAt !== -1 &&
  ((seed !== "failure-fixtures" && seed !== "cached") ||
    (seed === "cached" && !bundles.length))
) {
  console.error("Use --seed cached <bundle-dir> or --seed failure-fixtures");
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
    if (seed === "failure-fixtures") {
      for (const sc of Object.values({
        ...guards.SYNTHETIC_SCENARIOS,
        ...guards.REPLAY_SCENARIOS,
        ...guards.CANARY_SCENARIOS,
      }))
        guards.refuseSpend(sc.recipe);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  if (seed === "failure-fixtures") {
    seedMod = await import("./seed-annotations.mjs");
    dirs = seedMod.newSeedDirs();
  }
}
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const python =
  process.env.PYTHON_EXECUTABLE ??
  join(repoRoot, "workers/processing/.venv/bin/python");
const stackOptions = seedMod
  ? {
      storage: true,
      extraEnv: {
        ...seedMod.jobsEnv(python),
        STATEACTION_LOCAL_RECIPE_DIR: dirs.recipes,
      },
    }
  : {
      storage: bundles.length > 0,
      authOnly: true,
      storageProxy: (endpoint) => ({ endpoint, stop() {} }),
    };
stack = await startStack(stackOptions);
const done = async () => {
  stopRunner();
  await stack.stop();
  process.exit(0);
};
process.on("SIGTERM", done);
process.on("SIGINT", done);
let seeded;
if (bundles.length) {
  seeded = [];
  for (const bundle of bundles) {
    const imported = spawnSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "src/cached-import-cli.ts",
        "publish",
        resolve(bundle),
        stack.users.staff.email,
        "--approve-for-data",
      ],
      {
        cwd: join(repoRoot, "packages/server"),
        env: {
          ...stack.env,
          CACHED_IMPORT_OWNER_DATABASE_URL: stack.db.ownerUrl,
        },
        encoding: "utf8",
      },
    );
    if (imported.status !== 0) {
      console.error(
        imported.stderr || imported.error?.message || "Cached import failed",
      );
      await stack.stop();
      process.exit(1);
    }
    seeded.push(JSON.parse(imported.stdout));
  }
} else if (seedMod) {
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
