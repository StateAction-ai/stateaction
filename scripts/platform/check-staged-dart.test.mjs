// Deliberately separate from backend hook tests: Android CI provisions pinned Dart.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, invoke, withRepository } from "./hook-fixtures.mjs";

const path = "source with spaces.dart";
const formatted = "void main() {\n  print('staged');\n}\n";
const unformatted = "void main(){print('unstaged');}\n";

test("installed hook accepts actual formatted Dart with filename spaces", () =>
  withRepository((directory) => {
    writeFileSync(join(directory, path), formatted);
    git(directory, "add", "--", path);
    git(directory, "commit", "-m", "formatted Dart");
    assert.equal(git(directory, "show", `HEAD:${path}`), formatted);
  }));

test("installed hook rejects actual malformed Dart without changing index or worktree", () =>
  withRepository((directory) => {
    const malformed = "void main( {\n";
    writeFileSync(join(directory, path), malformed);
    git(directory, "add", "--", path);
    const before = git(directory, "rev-parse", `:${path}`);
    const result = invoke(directory, "git", ["commit", "-m", "must fail"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /source with spaces\.dart/);
    assert.equal(git(directory, "rev-parse", `:${path}`), before);
    assert.equal(readFileSync(join(directory, path), "utf8"), malformed);
  }));

test("Dart partial staging accepts formatted index and preserves unformatted worktree", () =>
  withRepository((directory) => {
    writeFileSync(join(directory, path), formatted);
    git(directory, "add", "--", path);
    writeFileSync(join(directory, path), unformatted);
    git(directory, "commit", "-m", "only staged Dart");
    assert.equal(git(directory, "show", `HEAD:${path}`), formatted);
    assert.equal(readFileSync(join(directory, path), "utf8"), unformatted);
  }));

test("Dart partial staging rejects unformatted index when worktree is formatted", () =>
  withRepository((directory) => {
    writeFileSync(join(directory, path), unformatted);
    git(directory, "add", "--", path);
    const before = git(directory, "rev-parse", `:${path}`);
    writeFileSync(join(directory, path), formatted);
    const result = invoke(directory, "git", ["commit", "-m", "must fail"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Staged check failed/);
    assert.equal(git(directory, "rev-parse", `:${path}`), before);
    assert.equal(git(directory, "show", `:${path}`), unformatted);
    assert.equal(readFileSync(join(directory, path), "utf8"), formatted);
  }));
