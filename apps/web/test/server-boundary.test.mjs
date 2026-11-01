import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
test("server package rejects ordinary browser/default-condition imports", () => {
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "import '@stateaction/server'"],
    { encoding: "utf8" },
  );
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /cannot be imported from a Client Component/);
});
