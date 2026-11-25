// Run under agent-resource against a built local stack.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const test = fileURLToPath(new URL("./review.e2e.test.mjs", import.meta.url));
const run = spawnSync(
  process.execPath,
  ["--test", "--test-name-pattern", "SA-150 pending review", test],
  {
    stdio: "inherit",
  },
);
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
