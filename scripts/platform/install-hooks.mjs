import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const require = createRequire(new URL("../../package.json", import.meta.url));
const git = (args) => spawnSync("git", args, { encoding: "utf8" });
const directory = git(["rev-parse", "--git-dir"]);
if (directory.status !== 0) process.exit(0); // Source archives have no hooks.
const top = git(["rev-parse", "--show-toplevel"]);
if (top.status !== 0 || resolve(top.stdout.trim()) !== resolve(process.cwd())) {
  console.log(
    "Source archive inside another repository: ancestor hooks left untouched.",
  );
  process.exit(0);
}
const common = git(["rev-parse", "--git-common-dir"]);
if (resolve(directory.stdout.trim()) !== resolve(common.stdout.trim())) {
  console.log(
    "Linked worktree: shared hooks left untouched. Install hooks on the final active clone; see scripts/platform/README.md.",
  );
  process.exit(0);
}
const existing = git(["config", "--get", "core.hooksPath"]);
if (existing.status === 0) {
  console.log(
    "Existing core.hooksPath preserved. Integrate Lefthook deliberately; see scripts/platform/README.md.",
  );
  process.exit(0);
}
const result = spawnSync(
  process.execPath,
  [require.resolve("lefthook/bin/index.js"), "install"],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
