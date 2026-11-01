import assert from "node:assert/strict";
import test from "node:test";
import { assertLocalDispatch } from "../src/config.js";
import { requestPlatformVerification } from "../src/dispatch.js";
const env = {
  APP_ENV: "local",
  RENDER_USE_LOCAL_DEV: "true",
  RENDER_LOCAL_DEV_URL: "http://127.0.0.1:8120",
  LOCAL_SMOKE_TOKEN: "12345678901234567890123456789012",
};
test("development route refuses production and remote targets", () => {
  assert.doesNotThrow(() => assertLocalDispatch(env));
  for (const overrides of [
    { APP_ENV: "production" },
    { NODE_ENV: "production" },
    { RENDER_USE_LOCAL_DEV: "false" },
    { RENDER_LOCAL_DEV_URL: "https://api.render.com" },
    { LOCAL_SMOKE_TOKEN: "short" },
  ])
    assert.throws(() => assertLocalDispatch({ ...env, ...overrides }));
});
test("real handler rejects unauthenticated, malformed and oversized bodies before dispatch", async () => {
  const old = { ...process.env };
  Object.assign(process.env, env);
  try {
    const invoke = (body: string, token?: string) =>
      requestPlatformVerification(
        new Request("http://localhost/api", {
          method: "POST",
          body,
          ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        }),
      );
    assert.equal((await invoke("{}")).status, 401);
    assert.equal((await invoke("{}", env.LOCAL_SMOKE_TOKEN)).status, 400);
    assert.equal(
      (await invoke("x".repeat(4097), env.LOCAL_SMOKE_TOKEN)).status,
      413,
    );
    process.env.APP_ENV = "production";
    assert.equal((await invoke("{}", env.LOCAL_SMOKE_TOKEN)).status, 404);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});
