// REAL-CATALOG AUTH INTEGRATION (SA-15 x SA-13). Real Better Auth 1.7.15 HTTP
// over a socket against a throwaway Postgres migrated by the published SA-13
// migrator and local seed. Better Auth and the access store connect ONLY as
// the restricted `stateaction_app` role, with grants from
// stateaction_grant_app_role. Operator changes (grant, revoke, disable, session
// expiry) use the migration owner credential, as an operator would. No
// fixture store and no DDL or grants as the app role. Not Google, native app,
// Tailscale or hosted Render qualification.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { validateValue } from "@stateaction/contracts";
import { CatalogAccessStore } from "../src/auth/access.js";
import { authConfig } from "../src/auth/config.js";
import { applicationDatabaseUrl } from "../src/config.js";
import {
  authRouteHandlers,
  createAuthRuntime,
  meRoute,
  pageIdentity,
  withHuman,
  type AuthRuntime,
} from "../src/auth/runtime.js";
import { successResponse } from "../src/auth/http.js";
import {
  bootstrapCatalog,
  type CatalogUserLabel,
  type CatalogUsers,
} from "./catalog-bootstrap.js";
import {
  Jar,
  SESSION_COOKIE,
  startHarness,
  type Harness,
} from "./http-harness.js";
import { startCatalogPostgres } from "./postgres.mjs";

const PASSWORD = "catalog seed password 0123";
let db: Awaited<ReturnType<typeof startCatalogPostgres>>;
let owner: pg.Pool;
let runtime: AuthRuntime;
let harness: Harness;
let users: CatalogUsers;

function route(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const get = () => runtime;
  if (path.startsWith("/api/auth/")) {
    const handlers = authRouteHandlers(get);
    return request.method === "GET"
      ? handlers.GET(request)
      : handlers.POST(request);
  }
  if (path === "/api/v1/me") return meRoute(get)(request);
  const guarded = (role: "collector" | "staff" | "customer") =>
    withHuman(
      request,
      { anyRole: [role] },
      (p, id, h) => successResponse({ userId: p.userId }, id, h),
      get,
    );
  if (path === "/harness/collector") return guarded("collector");
  if (path === "/harness/staff") return guarded("staff");
  if (path === "/harness/customer") return guarded("customer");
  return Promise.resolve(new Response("not found", { status: 404 }));
}

async function signIn(label: CatalogUserLabel): Promise<Jar> {
  const jar = new Jar();
  const response = await harness.call(
    "/api/auth/sign-in/email",
    harness.browserPost(jar, { email: users[label].email, password: PASSWORD }),
  );
  assert.equal(response.status, 200, `${label} sign-in`);
  assert.ok(jar.session, "session cookie issued");
  return jar;
}

async function me(jar: Jar) {
  const response = await harness.call("/api/v1/me", { jar });
  const body = (await response.json()) as any;
  if (response.status === 200) {
    assert.ok(validateValue("http.success-envelope.v1", body).valid);
    const data = validateValue("http.me.v1", body.data);
    assert.ok(data.valid, JSON.stringify(data));
  }
  return { response, body };
}

const status = async (path: string, jar: Jar) =>
  (await harness.call(path, { jar })).status;

before(async () => {
  db = await startCatalogPostgres();
  const boot = await bootstrapCatalog(db.ownerUrl, PASSWORD);
  assert.equal(boot.appRoleGranted, true);
  users = boot.users;
  owner = new pg.Pool({ connectionString: db.ownerUrl, max: 2 });
  harness = await startHarness(route);
  // Hosted-like component settings: no DATABASE_URL, only what the Render
  // Blueprint supplies (host/port/name + the generated role password), resolved
  // by the same exported resolver the Next runtime uses.
  const app = new URL(db.appUrl);
  assert.equal(app.username, "stateaction_app");
  const config = authConfig(
    {
      APP_ENV: "local",
      DATABASE_HOST: app.hostname,
      DATABASE_PORT: app.port,
      DATABASE_NAME: app.pathname.slice(1),
      APP_DB_PASSWORD: decodeURIComponent(app.password),
      BETTER_AUTH_URL: harness.origin,
      BETTER_AUTH_SECRET: "catalog-test-secret-0123456789abcdefghijkl",
      AUTH_LOCAL_PASSWORD: "true",
    },
    { resolveDatabaseUrl: applicationDatabaseUrl },
  );
  runtime = createAuthRuntime(config);
  await runtime.ready();
});

after(async () => {
  await harness?.close();
  await owner?.end();
  await runtime?.pool.end();
  db?.stop();
});

describe("Better Auth on the real SA-13 catalog as stateaction_app", () => {
  test("the default access source is the catalog, read over the restricted role", async () => {
    assert.deepEqual(runtime.config.accessSource, { kind: "catalog" });
    assert.ok(runtime.access instanceof CatalogAccessStore);
    const { rows } = await runtime.pool.query(
      `SELECT current_user AS who, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls
       FROM pg_roles r WHERE r.rolname = current_user`,
    );
    assert.deepEqual(rows[0], {
      who: "stateaction_app",
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolbypassrls: false,
    });
  });

  test("Better Auth's own schema check accepts the SA-13 migrated auth tables", async () => {
    const ctx = await runtime.auth.$context;
    assert.equal(typeof ctx.explicitSchemaCheck, "function");
    await ctx.explicitSchemaCheck!();
  });

  test("seeded collector, staff and customers sign in with roles from catalog rows", async () => {
    for (const [label, role] of [
      ["collector", "collector"],
      ["staff", "staff"],
      ["customer", "customer"],
      ["outsider", "customer"],
    ] as const) {
      const jar = await signIn(label);
      const { response, body } = await me(jar);
      assert.equal(response.status, 200);
      assert.equal(body.data.user.id, users[label].id);
      assert.deepEqual(body.data.access, { status: "active", roles: [role] });
      assert.equal(await status(`/harness/${role}`, jar), 200);
      for (const other of ["collector", "staff", "customer"] as const)
        if (other !== role)
          assert.equal(await status(`/harness/${other}`, jar), 403, other);
    }
  });

  test("the app role cannot grant itself access: access rows are read-only to it", async () => {
    for (const sql of [
      `INSERT INTO access (user_id, role) VALUES ('${users.pending.id}', 'staff')`,
      `UPDATE access SET enabled = true WHERE user_id = '${users.disabled.id}'`,
      `DELETE FROM access WHERE user_id = '${users.staff.id}'`,
    ])
      await assert.rejects(runtime.pool.query(sql), { code: "42501" }, sql);
    const { rows } = await owner.query(
      "SELECT role, enabled FROM access WHERE user_id = $1",
      [users.staff.id],
    );
    assert.deepEqual(rows, [{ role: "staff", enabled: true }]);
  });

  test("operator grant and revoke apply on the very next request (no role cache)", async () => {
    const jar = await signIn("collector");
    assert.equal(await status("/harness/staff", jar), 403);
    await owner.query(
      "INSERT INTO access (user_id, role, granted_by) VALUES ($1, 'staff', 'sa15-test-operator')",
      [users.collector.id],
    );
    try {
      assert.equal(await status("/harness/staff", jar), 200);
      const { body } = await me(jar);
      assert.deepEqual(body.data.access.roles, ["collector", "staff"]);
    } finally {
      await owner.query(
        "DELETE FROM access WHERE user_id = $1 AND role = 'staff'",
        [users.collector.id],
      );
    }
    assert.equal(await status("/harness/staff", jar), 403);
    assert.deepEqual((await me(jar)).body.data.access.roles, ["collector"]);
  });

  test("pending identity: signed in and told so, denied everywhere, until an operator grants a role", async () => {
    const jar = await signIn("pending");
    const { response, body } = await me(jar);
    assert.equal(response.status, 200);
    assert.deepEqual(body.data.access, { status: "pending", roles: [] });
    const denied = await harness.call("/harness/collector", { jar });
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as any).error.code, "forbidden");
    await owner.query(
      "INSERT INTO access (user_id, role, granted_by) VALUES ($1, 'collector', 'sa15-test-operator')",
      [users.pending.id],
    );
    try {
      assert.equal(await status("/harness/collector", jar), 200);
    } finally {
      await owner.query("DELETE FROM access WHERE user_id = $1", [
        users.pending.id,
      ]);
    }
    assert.equal(await status("/harness/collector", jar), 403);
  });

  test("disabled identity is denied; disabling an active session's only role denies the next request", async () => {
    const disabled = await signIn("disabled");
    assert.deepEqual((await me(disabled)).body.data.access, {
      status: "disabled",
      roles: [],
    });
    assert.equal(await status("/harness/collector", disabled), 403);

    const customer = await signIn("customer");
    assert.equal(await status("/harness/customer", customer), 200);
    await owner.query("UPDATE access SET enabled = false WHERE user_id = $1", [
      users.customer.id,
    ]);
    try {
      assert.equal(await status("/harness/customer", customer), 403);
      assert.deepEqual((await me(customer)).body.data.access, {
        status: "disabled",
        roles: [],
      });
      const page = await pageIdentity(
        new Headers({ cookie: customer.header() }),
        () => runtime,
      );
      assert.equal(page.state, "signed-in");
      assert.equal(
        page.state === "signed-in" && page.access.status,
        "disabled",
      );
    } finally {
      await owner.query("UPDATE access SET enabled = true WHERE user_id = $1", [
        users.customer.id,
      ]);
    }
    assert.equal(await status("/harness/customer", customer), 200);
  });

  test("expired session: 401, cookie cleared, and the app role deletes the row", async () => {
    const jar = await signIn("staff");
    const token = jar.token;
    await owner.query(
      `UPDATE session SET "expiresAt" = now() - interval '1 minute' WHERE token = $1`,
      [token],
    );
    const response = await harness.call("/api/v1/me", { jar });
    assert.equal(response.status, 401);
    assert.ok(
      response.headers
        .getSetCookie()
        .some(
          (c) => c.startsWith(`${SESSION_COOKIE}=`) && /Max-Age=0/i.test(c),
        ),
    );
    const { rowCount } = await owner.query(
      "SELECT 1 FROM session WHERE token = $1",
      [token],
    );
    assert.equal(rowCount, 0);
  });

  test("session refresh: page lookups never extend; /me extends row and cookie together", async () => {
    const jar = await signIn("collector");
    const token = jar.token;
    await owner.query(
      `UPDATE session SET "expiresAt" = now() + interval '5 days' WHERE token = $1`,
      [token],
    );
    const expiry = async () =>
      (
        await owner.query(`SELECT "expiresAt" FROM session WHERE token = $1`, [
          token,
        ])
      ).rows[0].expiresAt.getTime() as number;
    const before = await expiry();
    await pageIdentity(new Headers({ cookie: jar.header() }), () => runtime);
    assert.equal(await expiry(), before);
    const started = Date.now();
    const response = await harness.call("/api/v1/me", { jar });
    const cookie = response.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    assert.ok(cookie);
    const maxAge = Number(/Max-Age=(\d+)/i.exec(cookie)![1]);
    const after = await expiry();
    assert.ok(after > before + 86400e3);
    assert.ok(Math.abs(started + maxAge * 1000 - after) < 5000);
  });

  test("identity responses are private, uncacheable and vary on credentials", async () => {
    const jar = await signIn("customer");
    for (const path of ["/api/v1/me", "/api/auth/get-session"]) {
      const response = await harness.call(path, { jar });
      assert.equal(response.status, 200, path);
      const cache = response.headers.get("cache-control") ?? "";
      assert.match(cache, /private/, path);
      assert.match(cache, /no-store/, path);
      assert.match(response.headers.get("vary") ?? "", /Cookie/i, path);
    }
  });

  test("sign-out deletes the session row through the app role; the old cookie is dead", async () => {
    const jar = await signIn("outsider");
    const token = jar.token;
    const stale = jar.header();
    const out = await harness.call(
      "/api/auth/sign-out",
      harness.browserPost(jar, {}),
    );
    assert.equal(out.status, 200);
    const { rowCount } = await owner.query(
      "SELECT 1 FROM session WHERE token = $1",
      [token],
    );
    assert.equal(rowCount, 0);
    const replay = await harness.call("/api/v1/me", {
      headers: { cookie: stale },
    });
    assert.equal(replay.status, 401);
  });

  test("a wrong password for a seeded identity creates no session", async () => {
    const before = Number(
      (await owner.query("SELECT count(*) FROM session")).rows[0].count,
    );
    const jar = new Jar();
    const response = await harness.call(
      "/api/auth/sign-in/email",
      harness.browserPost(jar, {
        email: users.staff.email,
        password: "not the seed password",
      }),
    );
    assert.equal(response.status, 401);
    assert.equal(jar.session, undefined);
    const afterCount = Number(
      (await owner.query("SELECT count(*) FROM session")).rows[0].count,
    );
    assert.equal(afterCount, before);
  });
});
