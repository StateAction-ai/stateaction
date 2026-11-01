import assert from "node:assert/strict";
import test from "node:test";
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
const invoke = (directory, command, args) =>
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
const git = (directory, ...args) => {
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
function withRepository(run) {
  const directory = repository();
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
test("actual installed pre-commit accepts a formatted filename with spaces", () =>
  withRepository((directory) => {
    writeFileSync(join(directory, "data with spaces.json"), '{ "value": 1 }\n');
    git(directory, "add", "--", "data with spaces.json");
    git(directory, "commit", "-m", "formatted staged data");
  }));
test("actual installed pre-commit rejects malformed formatting without changing index/worktree", () =>
  withRepository((directory) => {
    const content = '{"value":1}\n';
    const file = join(directory, "data with spaces.json");
    writeFileSync(file, content);
    git(directory, "add", "--", "data with spaces.json");
    const before = git(directory, "rev-parse", ":data with spaces.json");
    const result = invoke(directory, "git", ["commit", "-m", "must fail"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Staged check failed/);
    assert.equal(git(directory, "rev-parse", ":data with spaces.json"), before);
    assert.equal(readFileSync(file, "utf8"), content);
  }));
test("partial staging validates good index content and preserves bad unstaged content", () =>
  withRepository((directory) => {
    const file = join(directory, "data with spaces.json");
    const indexed = '{ "value": 1 }\n';
    const unstaged = '{"value":2}\n';
    writeFileSync(file, indexed);
    git(directory, "add", "--", "data with spaces.json");
    writeFileSync(file, unstaged);
    git(directory, "commit", "-m", "only intended staged hunk");
    assert.equal(git(directory, "show", "HEAD:data with spaces.json"), indexed);
    assert.equal(readFileSync(file, "utf8"), unstaged);
  }));
test("partial staging rejects bad index even when worktree formatting is good", () =>
  withRepository((directory) => {
    const file = join(directory, "data with spaces.json");
    const indexed = '{"value":1}\n';
    const unstaged = '{ "value": 2 }\n';
    writeFileSync(file, indexed);
    git(directory, "add", "--", "data with spaces.json");
    writeFileSync(file, unstaged);
    const result = invoke(directory, "git", [
      "commit",
      "-m",
      "must reject index",
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(git(directory, "show", ":data with spaces.json"), indexed);
    assert.equal(readFileSync(file, "utf8"), unstaged);
  }));
test("actual installed pre-push allows a ticket branch and rejects direct main", () =>
  withRepository((directory) => {
    const remote = mkdtempSync(join(tmpdir(), "stateaction bare "));
    try {
      git(remote, "init", "--bare");
      git(directory, "remote", "add", "origin", remote);
      git(directory, "push", "origin", "HEAD:refs/heads/feature/sa-11");
      const result = invoke(directory, "git", [
        "push",
        "origin",
        "HEAD:refs/heads/main",
      ]);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stdout + result.stderr,
        /Direct pushes to main are prohibited/,
      );
      const refs = git(remote, "for-each-ref", "--format=%(refname)");
      assert.match(refs, /refs\/heads\/feature\/sa-11/);
      assert.doesNotMatch(refs, /refs\/heads\/main/);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  }));

test("actual pre-commit checks staged Python with spaces and rejects invalid syntax", () =>
  withRepository((directory) => {
    const path = "value with spaces.py";
    writeFileSync(join(directory, path), "value = 1\n");
    git(directory, "add", "--", path);
    git(directory, "commit", "-m", "valid staged Python");
    writeFileSync(join(directory, path), "value = (\n");
    git(directory, "add", "--", path);
    const before = git(directory, "rev-parse", `:${path}`);
    const result = invoke(directory, "git", [
      "commit",
      "-m",
      "invalid staged Python",
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(git(directory, "rev-parse", `:${path}`), before);
    assert.equal(readFileSync(join(directory, path), "utf8"), "value = (\n");
  }));

test("setup in a nested source archive preserves ancestor hooks", () =>
  withRepository((directory) => {
    const nested = join(directory, "source archive");
    mkdirSync(nested);
    const before = readFileSync(
      join(directory, ".git/hooks/pre-commit"),
      "utf8",
    );
    const installer = fileURLToPath(
      new URL("./install-hooks.mjs", import.meta.url),
    );
    const result = invoke(nested, process.execPath, [installer]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /ancestor hooks left untouched/);
    assert.equal(
      readFileSync(join(directory, ".git/hooks/pre-commit"), "utf8"),
      before,
    );
  }));
