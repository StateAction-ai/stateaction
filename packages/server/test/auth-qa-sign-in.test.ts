import assert from "node:assert/strict";
import test from "node:test";
import { authRouteHandlers, type AuthRuntime } from "../src/auth/runtime.js";

const origin = "https://qa.example.ts.net:8444";
const dev = {
  NODE_ENV: "development",
  APP_ENV: "development",
  AUTH_LOCAL_PASSWORD: "true",
  AUTH_QA_COLLECTOR_EMAIL: "collector@fixture.test",
  BETTER_AUTH_URL: origin,
};
const request = (
  base = origin,
  body = {
    email: dev.AUTH_QA_COLLECTOR_EMAIL,
    password: "fixture-password",
    rememberMe: true,
  },
  marker = "1",
  internal = base,
  forwarding: Record<string, string> = {},
) =>
  new Request(internal + "/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      origin: base,
      host: new URL(base).host,
      ...forwarding,
      "content-type": "application/json",
      "x-stateaction-qa-sign-in": marker,
      "x-stateaction-client": "android",
    },
    body: JSON.stringify(body),
  });

test("QA password exchanges are refused before Better Auth in production and on hosted origins", async () => {
  let calls = 0;
  for (const overrides of [
    { NODE_ENV: "production" },
    { RENDER: "true" },
    { APP_ENV: "production" },
    { APP_ENV: "staging" },
    { AUTH_QA_COLLECTOR_EMAIL: "" },
  ]) {
    const routes = authRouteHandlers(
      () => {
        calls++;
        throw new Error("must not initialize auth");
      },
      { ...dev, ...overrides },
    );
    const response = await routes.POST(request());
    assert.equal(response.status, 404);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
  const hosted = "https://qa.onrender.com";
  const routes = authRouteHandlers(
    () => {
      calls++;
      throw new Error("must not initialize auth");
    },
    { ...dev, BETTER_AUTH_URL: hosted },
  );
  assert.equal((await routes.POST(request(hosted))).status, 404);
  assert.equal(calls, 0);
});

test("the exact development origin and configured QA collector reach the ordinary password handler", async () => {
  let authCalls = 0;
  const routes = authRouteHandlers(
    () =>
      ({
        ready: async () => {},
        auth: {
          handler: async (req: Request) => {
            authCalls++;
            assert.equal((await req.json()).email, dev.AUTH_QA_COLLECTOR_EMAIL);
            return new Response(null, { status: 200 });
          },
        },
      }) as unknown as AuthRuntime,
    dev,
  );
  assert.equal((await routes.POST(request())).status, 200);
  assert.equal(
    (
      await routes.POST(
        request(origin, undefined, "1", "https://localhost:3000"),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await routes.POST(
        request(origin, undefined, "1", "http://localhost:3000", {
          host: "localhost:3000",
          "x-forwarded-host": "qa.example.ts.net:8444",
          "x-forwarded-proto": "https",
        }),
      )
    ).status,
    200,
  );
  for (const invalid of [
    request("https://elsewhere.ts.net"),
    request(origin, undefined, "1", "https://host.onrender.com"),
    request(origin, undefined, "1", "http://localhost:3000", {
      host: "host.onrender.com",
      "x-forwarded-host": "qa.example.ts.net:8444",
      "x-forwarded-proto": "https",
    }),
    request(origin, {
      email: "staff@fixture.test",
      password: "fixture-password",
      rememberMe: true,
    }),
    request(origin, {
      email: dev.AUTH_QA_COLLECTOR_EMAIL,
      password: "a".repeat(1025),
      rememberMe: true,
    }),
    request(origin, undefined, "0"),
  ])
    assert.equal((await routes.POST(invalid)).status, 404);
  assert.equal(authCalls, 3);
});
