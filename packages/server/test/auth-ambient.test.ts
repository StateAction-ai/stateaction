// Better Auth 1.7.15 reads BETTER_AUTH_TRUSTED_ORIGINS (appended, wildcards
// included, at context creation and on every request) and BETTER_AUTH_SECRETS
// (overrides options.secret) straight from process.env. These tests check the
// effective awaited `auth.$context`, the injected-versus-ambient boundary and
// real process.env, not only the parsed config. No database is contacted:
// every refusal happens before Better Auth touches the pool.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { betterAuth } from "better-auth";
import pg from "pg";
import { authConfig, AuthConfigError } from "../src/auth/config.js";
import { verifyEffectiveContext } from "../src/auth/ambient.js";
import { createAuth } from "../src/auth/instance.js";
import {
  authRouteHandlers,
  createAuthRuntime,
  meRoute,
  pageIdentity,
  signInMethods,
} from "../src/auth/runtime.js";

const SECRET = "validated-secret-0123456789abcdefghijklmnop";
const STRAY = "stray-secret-value-should-never-appear-0123456789";
const env = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://u:p@127.0.0.1:1/never-contacted",
  BETTER_AUTH_URL: "http://127.0.0.1:3999",
  BETTER_AUTH_SECRET: SECRET,
  AUTH_TRUSTED_ORIGINS: "http://localhost:3999",
  AUTH_LOCAL_PASSWORD: "true",
};
const AMBIENT = ["BETTER_AUTH_TRUSTED_ORIGINS", "BETTER_AUTH_SECRETS"];
const pools: pg.Pool[] = [];
const pool = () => {
  const p = new pg.Pool({ connectionString: env.DATABASE_URL });
  pools.push(p);
  return p;
};
afterEach(async () => {
  for (const name of AMBIENT) delete process.env[name];
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

function captureErrors() {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) =>
    lines.push(args.map(String).join(" "));
  return {
    lines,
    restore: () => {
      console.error = original;
    },
  };
}

test("injected env: unsupported Better Auth settings fail closed, values never echoed", () => {
  for (const [name, value] of [
    ["BETTER_AUTH_TRUSTED_ORIGINS", "https://evil.example,*"],
    ["BETTER_AUTH_TRUSTED_ORIGINS", ""],
    ["BETTER_AUTH_SECRETS", `1:${STRAY}`],
    ["BETTER_AUTH_SECRETS", ""],
  ] as const)
    assert.throws(
      () => authConfig({ ...env, [name]: value }),
      (e: unknown) =>
        e instanceof AuthConfigError &&
        e.message.includes(name) &&
        !e.message.includes(STRAY) &&
        !e.message.includes("evil.example"),
      name,
    );
});

test("AUTH_SECRET may only repeat BETTER_AUTH_SECRET", () => {
  assert.equal(authConfig({ ...env, AUTH_SECRET: SECRET }).secret, SECRET);
  assert.throws(
    () => authConfig({ ...env, AUTH_SECRET: STRAY }),
    (e: unknown) => e instanceof AuthConfigError && !e.message.includes(STRAY),
  );
});

test("clean config: the awaited Better Auth context uses exactly the validated origins and secret", async () => {
  const config = authConfig(env);
  const auth = createAuth(config, pool(), {});
  const ctx = await auth.$context;
  assert.deepEqual([...new Set(ctx.trustedOrigins)].sort(), [
    "http://127.0.0.1:3999",
    "http://localhost:3999",
  ]);
  assert.equal(ctx.secret, config.secret);
  assert.equal(ctx.secretConfig, config.secret);
  assert.doesNotThrow(() => verifyEffectiveContext(ctx, config));
  assert.deepEqual(auth.options.advanced?.ipAddress?.ipAddressHeaders, [
    "x-forwarded-for",
  ]);
});

test("injected env clean but ambient env dirty: construction is refused", () => {
  const config = authConfig(env); // the injected env has neither setting
  for (const name of AMBIENT) {
    const ambient = { [name]: name.endsWith("SECRETS") ? `1:${STRAY}` : "*" };
    assert.throws(() => createAuth(config, pool(), ambient), AuthConfigError);
    assert.throws(
      () => createAuthRuntime(config, { pool: pool(), ambientEnv: ambient }),
      (e: unknown) =>
        e instanceof AuthConfigError &&
        e.message.includes(name) &&
        !e.message.includes(STRAY),
    );
  }
  // The real process environment is the default boundary.
  process.env.BETTER_AUTH_TRUSTED_ORIGINS = "https://evil.example,*";
  assert.throws(() => createAuth(config, pool()), AuthConfigError);
  assert.throws(
    () => createAuthRuntime(config, { pool: pool() }),
    AuthConfigError,
  );
});

test("ambient setting appearing after construction: every entry point answers 503 without Better Auth", async () => {
  const config = authConfig(env);
  const runtime = createAuthRuntime(config, { pool: pool() });
  await runtime.ready();
  process.env.BETTER_AUTH_TRUSTED_ORIGINS = "https://evil.example,*";
  process.env.BETTER_AUTH_SECRETS = `1:${STRAY}`;
  const errors = captureErrors();
  try {
    const get = () => runtime;
    const signIn = await authRouteHandlers(get).POST(
      new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({
          email: "a@b.invalid",
          password: "x".repeat(12),
        }),
      }),
    );
    assert.equal(signIn.status, 503);
    assert.match(signIn.headers.get("cache-control") ?? "", /no-store/);
    const body = await signIn.text();
    assert.doesNotMatch(body, /BETTER_AUTH|evil|stray/i);
    const me = await meRoute(get)(
      new Request(`${env.BETTER_AUTH_URL}/api/v1/me`),
    );
    assert.equal(me.status, 503);
    assert.deepEqual(await pageIdentity(new Headers(), get), {
      state: "unavailable",
    });
    assert.equal(await signInMethods(get), null);
  } finally {
    errors.restore();
  }
  assert.ok(errors.lines.length >= 1);
  for (const line of errors.lines) {
    assert.ok(!line.includes(STRAY), "secret value never logged");
    assert.ok(!line.includes("evil.example"), "origin value never logged");
  }
  // Removing the stray settings restores service without a restart.
  for (const name of AMBIENT) delete process.env[name];
  await runtime.ready();
});

test("context verifier catches the real Better Auth merge when the guard is bypassed", async () => {
  const config = authConfig(env);
  // Better Auth reads the env inside its async context creation, so keep the
  // setting present until the context resolves.
  process.env.BETTER_AUTH_TRUSTED_ORIGINS = "https://evil.example,*";
  const widened = await betterAuth({
    baseURL: config.baseURL,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    database: pool(),
    telemetry: { enabled: false },
  }).$context;
  delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  assert.ok(widened.trustedOrigins.includes("*"), "Better Auth merged the env");
  assert.throws(
    () => verifyEffectiveContext(widened, config),
    /trusted origins differ/,
  );

  process.env.BETTER_AUTH_SECRETS = `1:${STRAY}`;
  const replaced = await betterAuth({
    baseURL: config.baseURL,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    database: pool(),
    telemetry: { enabled: false },
  }).$context;
  delete process.env.BETTER_AUTH_SECRETS;
  assert.notEqual(replaced.secret, config.secret, "Better Auth replaced it");
  assert.throws(
    () => verifyEffectiveContext(replaced, config),
    (e: unknown) =>
      e instanceof AuthConfigError &&
      /signing secret differs/.test(e.message) &&
      !e.message.includes(STRAY),
  );
});
