import assert from "node:assert/strict";
import test from "node:test";
import { authConfig, AuthConfigError } from "../src/auth/config.js";
import { applicationDatabaseUrl } from "../src/config.js";
import {
  CatalogAccessStore,
  decideAccess,
  type Queryable,
} from "../src/auth/access.js";
import { createAuth, DISABLED_AUTH_PATHS } from "../src/auth/instance.js";
import pg from "pg";

const local = {
  APP_ENV: "local",
  DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
  BETTER_AUTH_URL: "http://127.0.0.1:3000",
  BETTER_AUTH_SECRET: "x".repeat(40),
  AUTH_LOCAL_PASSWORD: "true",
};
const hosted = {
  APP_ENV: "production",
  DATABASE_URL: "postgresql://u:p@db.internal:5432/db",
  BETTER_AUTH_URL: "https://app.stateaction.example",
  BETTER_AUTH_SECRET: "y".repeat(40),
  GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "google-secret",
};

test("local loopback password mode is accepted with insecure cookies only on loopback", () => {
  const config = authConfig(local);
  assert.equal(config.localPassword, true);
  assert.equal(config.secureCookies, false);
  assert.deepEqual(config.trustedOrigins, ["http://127.0.0.1:3000"]);
  assert.equal(config.google, null);
  assert.deepEqual(config.accessSource, { kind: "catalog" });
});

test("Tailscale HTTPS origin gives Secure cookies and explicit trusted origins", () => {
  const config = authConfig({
    ...local,
    BETTER_AUTH_URL: "https://tim-work-pc.taila68f99.ts.net:8444",
    AUTH_TRUSTED_ORIGINS:
      "http://127.0.0.1:3000, https://tim-work-pc.taila68f99.ts.net:8444",
  });
  assert.equal(config.secureCookies, true);
  assert.deepEqual(config.trustedOrigins, [
    "https://tim-work-pc.taila68f99.ts.net:8444",
    "http://127.0.0.1:3000",
  ]);
});

test("development (non-hosted, Tailscale HTTPS) allows seeded password sign-in", () => {
  const config = authConfig({
    ...local,
    APP_ENV: "development",
    BETTER_AUTH_URL: "https://tim-work-pc.taila68f99.ts.net:8444",
  });
  assert.equal(config.appEnv, "development");
  assert.equal(config.localPassword, true);
  assert.equal(config.secureCookies, true);
  // ...but never on Render, whatever APP_ENV says.
  for (const appEnv of ["development", "local", "test"])
    assert.throws(
      () =>
        authConfig({
          ...local,
          APP_ENV: appEnv,
          RENDER: "true",
          BETTER_AUTH_URL: "https://stateaction-web.onrender.com",
        }),
      AuthConfigError,
      appEnv,
    );
  // Development off loopback still needs HTTPS.
  assert.throws(
    () =>
      authConfig({
        ...local,
        APP_ENV: "development",
        BETTER_AUTH_URL: "http://tim-work-pc.taila68f99.ts.net:8444",
      }),
    AuthConfigError,
  );
});

test("database URL can come from an injected resolver; failures stay generic", () => {
  const env = { ...local, DATABASE_URL: "" };
  const config = authConfig(env, {
    resolveDatabaseUrl: () => "postgresql://app@db.internal/app",
  });
  assert.equal(config.databaseUrl, "postgresql://app@db.internal/app");
  assert.throws(() => authConfig(env), AuthConfigError);
  assert.throws(
    () =>
      authConfig(env, {
        resolveDatabaseUrl: () => {
          throw new Error("APP_DB_PASSWORD=hunter2");
        },
      }),
    (e: Error) =>
      e instanceof AuthConfigError && !e.message.includes("hunter2"),
  );
});

test("hosted Google configuration is accepted", () => {
  const config = authConfig(hosted);
  assert.equal(config.localPassword, false);
  assert.equal(config.secureCookies, true);
  assert.deepEqual(config.google, {
    clientId: hosted.GOOGLE_CLIENT_ID,
    clientSecret: hosted.GOOGLE_CLIENT_SECRET,
  });
});

test("missing or unsafe settings fail closed", () => {
  const without = (key: string, base: Record<string, string> = local) => {
    const copy = { ...base };
    delete copy[key];
    return copy;
  };
  const bad: Record<string, string>[] = [
    without("APP_ENV"),
    { ...local, APP_ENV: "dev" },
    without("BETTER_AUTH_SECRET"),
    { ...local, BETTER_AUTH_SECRET: "short" },
    {
      ...local,
      BETTER_AUTH_SECRET: "replace-with-a-random-secret-of-32-chars",
    },
    without("DATABASE_URL"),
    without("BETTER_AUTH_URL"),
    { ...local, BETTER_AUTH_URL: "http://192.168.1.10:3000" },
    { ...local, BETTER_AUTH_URL: "https://host.example/app" },
    { ...local, BETTER_AUTH_URL: "ftp://host.example" },
    { ...local, AUTH_TRUSTED_ORIGINS: "https://*.example" },
    { ...local, AUTH_TRUSTED_ORIGINS: "http://evil.example" },
    { ...local, AUTH_LOCAL_PASSWORD: "yes" },
    { ...local, AUTH_LOCAL_PASSWORD: "false" }, // no sign-in method left
    { ...local, GOOGLE_CLIENT_ID: "id-without-secret" },
    // Local password mode is never available in hosted environments.
    { ...hosted, AUTH_LOCAL_PASSWORD: "true" },
    { ...hosted, APP_ENV: "staging", AUTH_LOCAL_PASSWORD: "true" },
    { ...local, RENDER: "true", BETTER_AUTH_URL: "https://x.onrender.com" },
    { ...hosted, BETTER_AUTH_URL: "http://app.stateaction.example" },
    { ...hosted, BETTER_AUTH_URL: "http://127.0.0.1:3000" },
    // The test-only access store cannot be selected outside APP_ENV=test.
    {
      ...local,
      AUTH_ACCESS_SOURCE: "test-fixture",
      AUTH_TEST_ACCESS_FIXTURE: "/tmp/x.json",
    },
    {
      ...local,
      APP_ENV: "development",
      AUTH_ACCESS_SOURCE: "test-fixture",
      AUTH_TEST_ACCESS_FIXTURE: "/tmp/x.json",
    },
    {
      ...hosted,
      AUTH_ACCESS_SOURCE: "test-fixture",
      AUTH_TEST_ACCESS_FIXTURE: "/tmp/x.json",
    },
    { ...local, APP_ENV: "test", AUTH_ACCESS_SOURCE: "test-fixture" },
    { ...local, AUTH_ACCESS_SOURCE: "header" },
  ];
  for (const env of bad)
    assert.throws(() => authConfig(env), AuthConfigError, JSON.stringify(env));
});

test("access decision: pending, disabled, active with only enabled roles", () => {
  assert.deepEqual(decideAccess([]), { status: "pending", roles: [] });
  assert.deepEqual(decideAccess([{ role: "staff", enabled: false }]), {
    status: "disabled",
    roles: [],
  });
  assert.deepEqual(
    decideAccess([
      { role: "customer", enabled: true },
      { role: "staff", enabled: false },
      { role: "collector", enabled: true },
    ]),
    { status: "active", roles: ["collector", "customer"] },
  );
});

test("catalog adapter reads the access table by user and rejects unknown rows", async () => {
  const calls: unknown[][] = [];
  const db = (rows: Record<string, unknown>[]): Queryable => ({
    async query(text: string, values: unknown[]) {
      calls.push([text, values]);
      return { rows } as never;
    },
  });
  const grants = await new CatalogAccessStore(
    db([{ role: "staff", enabled: true }]),
  ).grantsFor("opaque-user-1");
  assert.deepEqual(grants, [{ role: "staff", enabled: true }]);
  assert.deepEqual(calls[0], [
    "SELECT role, enabled FROM access WHERE user_id = $1",
    ["opaque-user-1"],
  ]);
  await assert.rejects(
    new CatalogAccessStore(db([{ role: "admin", enabled: true }])).grantsFor(
      "u",
    ),
  );
  await assert.rejects(
    new CatalogAccessStore(db([{ role: "staff", enabled: "t" }])).grantsFor(
      "u",
    ),
  );
});

test("Better Auth instance: sign-up, linking and telemetry are off; HTTPS uses __Secure- cookies", async () => {
  const pool = new pg.Pool({ connectionString: hosted.DATABASE_URL });
  try {
    const auth = createAuth(
      authConfig({ ...hosted, AUTH_LOCAL_PASSWORD: "false" }),
      pool,
    );
    const ctx = await auth.$context;
    assert.equal(
      ctx.authCookies.sessionToken.name,
      "__Secure-better-auth.session_token",
    );
    assert.equal(ctx.authCookies.sessionToken.attributes.secure, true);
    assert.equal(ctx.authCookies.sessionToken.attributes.httpOnly, true);
    assert.equal(ctx.authCookies.sessionToken.attributes.sameSite, "lax");
    assert.equal(auth.options.emailAndPassword?.enabled, false);
    assert.equal(auth.options.emailAndPassword?.disableSignUp, true);
    assert.equal(auth.options.account?.accountLinking?.enabled, false);
    assert.equal(auth.options.telemetry?.enabled, false);
    assert.equal(auth.options.session?.cookieCache?.enabled, false);
    assert.equal(auth.options.advanced?.disableOriginCheck, false);
    assert.equal(auth.options.advanced?.disableCSRFCheck, false);
    for (const path of [
      "/sign-up/email",
      "/link-social",
      "/delete-user",
      "/change-email",
    ])
      assert.ok(DISABLED_AUTH_PATHS.includes(path), path);
    // Disabled paths answer 404 before touching the database.
    const response = await auth.handler(
      new Request(`${hosted.BETTER_AUTH_URL}/api/auth/link-social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "google" }),
      }),
    );
    assert.equal(response.status, 404);
  } finally {
    await pool.end();
  }
});

test("component database settings resolve through the shared application resolver with DATABASE_URL absent", () => {
  const { DATABASE_URL: _unused, ...rest } = local;
  const component = {
    DATABASE_HOST: "db.internal",
    DATABASE_PORT: "5433",
    DATABASE_NAME: "stateaction",
    APP_DB_PASSWORD: "p@ss/w:rd",
  };
  const opts = { resolveDatabaseUrl: applicationDatabaseUrl };
  const config = authConfig({ ...rest, ...component }, opts);
  const url = new URL(config.databaseUrl);
  assert.equal(url.username, "stateaction_app");
  assert.equal(decodeURIComponent(url.password), "p@ss/w:rd");
  assert.equal(
    `${url.hostname}:${url.port}${url.pathname}`,
    "db.internal:5433/stateaction",
  );
  // Without the resolver the default still demands DATABASE_URL.
  assert.throws(() => authConfig({ ...rest, ...component }), AuthConfigError);
  // Incomplete component settings fail closed.
  assert.throws(
    () => authConfig({ ...rest, DATABASE_HOST: "h" }, opts),
    AuthConfigError,
  );
  // Production refuses any explicit DSN that is not the restricted role.
  assert.throws(
    () =>
      authConfig(
        { ...hosted, DATABASE_URL: "postgresql://owner:p@h/db" },
        opts,
      ),
    AuthConfigError,
  );
  // Local password sign-in: allowed locally/in development, refused hosted.
  for (const APP_ENV of ["local", "development"])
    assert.equal(
      authConfig({ ...rest, ...component, APP_ENV }, opts).localPassword,
      true,
    );
  const refused = [
    { APP_ENV: "staging" },
    { APP_ENV: "production" },
    { APP_ENV: "development", RENDER: "true" },
  ];
  for (const extra of refused)
    assert.throws(
      () =>
        authConfig(
          {
            ...rest,
            ...component,
            BETTER_AUTH_URL: "https://x.example",
            ...extra,
          },
          opts,
        ),
      AuthConfigError,
      JSON.stringify(extra),
    );
});
