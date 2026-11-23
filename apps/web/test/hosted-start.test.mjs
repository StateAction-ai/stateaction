import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
const script = new URL("../../../scripts/platform/web.mjs", import.meta.url);
test("start refuses to run without any environment", () => {
  const child = spawnSync(process.execPath, [script.pathname, "start"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      STATEACTION_ENV_FILE: "/nonexistent/stateaction.env",
    },
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /APP_ENV/);
});
test("start rejects a non-numeric PORT before listening", () => {
  const child = spawnSync(process.execPath, [script.pathname, "start"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      APP_ENV: "production",
      PORT: "x;y",
      STATEACTION_ENV_FILE: "/nonexistent/stateaction.env",
    },
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /PORT must be numeric/);
});
