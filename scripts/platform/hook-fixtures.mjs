import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const require = createRequire(new URL("../../package.json", import.meta.url));
const lefthook = require.resolve("lefthook/bin/index.js");
const staged = fileURLToPath(new URL("./check-staged.mjs", import.meta.url));
const push = fileURLToPath(new URL("./check-push.mjs", import.meta.url));
export const invoke = (directory, command, args) =>
  spawnSync(command, args, {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      LEFTHOOK_VERBOSE: "false",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
export const git = (directory, ...args) => {
  const result = invoke(directory, "git", args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};
function repository() {
  const directory = mkdtempSync(join(tmpdir(), "stateaction hooks "));
  git(directory, "init", "--initial-branch=feature/sa-11");
  git(directory, "config", "user.name", "StateAction hook tests");
  git(directory, "config", "user.email", "hook-test@invalid");
  writeFileSync(join(directory, "data with spaces.json"), '{"value": 0}\n');
  git(directory, "add", "--", "data with spaces.json");
  git(directory, "commit", "-m", "fixture baseline");
  writeFileSync(
    join(directory, "lefthook.yml"),
    `pre-commit:\n  commands:\n    staged-content:\n      run: ${JSON.stringify(`'${process.execPath}' '${staged}'`)}\n      stage_fixed: false\npre-push:\n  commands:\n    protect-main:\n      run: ${JSON.stringify(`'${process.execPath}' '${push}'`)}\n      use_stdin: true\n`,
  );
  const install = invoke(directory, process.execPath, [lefthook, "install"]);
  assert.equal(install.status, 0, install.stderr || install.stdout);
  assert.ok(
    readFileSync(join(directory, ".git/hooks/pre-commit"), "utf8").includes(
      "lefthook",
    ),
  );
  return directory;
}
export function withRepository(run) {
  const directory = repository();
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
