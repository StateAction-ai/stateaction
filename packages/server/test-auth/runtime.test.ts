// INDEPENDENT-RUNTIME COVERAGE (SA-15 prep). Real Better Auth 1.7.15 HTTP,
// cookie and session behaviour over a real socket, against an isolated
// Postgres with the official generated auth schema. FIXTURE-ONLY: roles come
// from the explicitly TEST-ONLY fixture store, not the SA-13 catalog `access`
// table. Real catalog migration/seed/stateaction_app coverage is in
// catalog.test.ts and the Next E2E (web:auth-e2e).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
} from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { authConfig } from "../src/auth/config.js";
import {
  authRouteHandlers,
  createAuthRuntime,
  meRoute,
  pageIdentity,
  withHuman,
  type AuthRuntime,
} from "../src/auth/runtime.js";
import { successResponse } from "../src/auth/http.js";
import { validateValue } from "@stateaction/contracts";
import { startPostgres } from "./postgres.mjs";
import {
  migrateAuthSchema,
  seedTestIdentities,
  type IdentityLabel,
} from "./bootstrap.js";

const PASSWORD = "correct horse battery staple";
const SESSION = "better-auth.session_token";

let db: Awaited<ReturnType<typeof startPostgres>>;
let dir: string;
let fixture: string;
let server: Server;
let origin: string;
let runtime: AuthRuntime;
let users: Record<IdentityLabel, { id: string; email: string }>;
let sql: pg.Pool;

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers))
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(new URL(req.url ?? "/", origin), {
    method: req.method ?? "GET",
    headers,
    ...(body && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
  });
}

// Harness-only routes exercising the same guards later product routes use.
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
  if (path === "/harness/collector-read")
    return withHuman(
      request,
      { anyRole: ["collector"] },
      (p, id, h) => successResponse({ userId: p.userId }, id, h),
      get,
    );
  if (path === "/harness/staff-action")
    return withHuman(
      request,
      { anyRole: ["staff"] },
      (p, id, h) =>
        successResponse({ userId: p.userId, roles: p.access.roles }, id, h),
      get,
    );
  return Promise.resolve(new Response("not found", { status: 404 }));
}

// Each simulated client gets its own address; Better Auth rate-limits per IP
// (x-forwarded-for, as set by the hosting proxy).
let clients = 0;
const nextIp = () => `198.51.100.${++clients % 250}`;

class Jar {
  cookies = new Map<string, string>();
  ip = nextIp();
  apply(response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (/max-age=0/i.test(line) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  get session() {
    return this.cookies.get(SESSION);
  }
}

// Raw node:http client: unlike fetch() it adds no Fetch Metadata headers, so
// each case sends exactly the browser or native headers it simulates.
async function call(
  path: string,
  init: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    jar?: Jar;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {}))
    if (v !== "") headers[k.toLowerCase()] = v;
  if (init.jar?.cookies.size) headers.cookie = init.jar.header();
  // TEST-ONLY: simulated client address (see nextIp above).
  headers["x-forwarded-for"] ??= init.jar?.ip ?? nextIp();
  const response = await new Promise<Response>((resolve, reject) => {
    const req = request(
      origin + path,
      { method: init.method ?? "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers))
            if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
            else if (v !== undefined) h.set(k, v);
          resolve(
            new Response(chunks.length ? Buffer.concat(chunks) : null, {
              status: res.statusCode ?? 0,
              headers: h,
            }),
          );
        });
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.end(init.body);
    else req.end();
  });
  init.jar?.apply(response);
  return response;
}

const browserPost = (
  jar: Jar | undefined,
  body: unknown,
  extra: Record<string, string> = {},
) => ({
  method: "POST",
  ...(jar ? { jar } : {}),
  body: JSON.stringify(body),
  headers: {
    "content-type": "application/json",
    origin,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "x-stateaction-client": "web",
    ...extra,
  },
});

async function signIn(label: IdentityLabel, jar = new Jar()): Promise<Jar> {
  const response = await call(
    "/api/auth/sign-in/email",
    browserPost(jar, {
      email: users[label].email,
      password: PASSWORD,
    }),
  );
  assert.equal(response.status, 200, `${label} sign-in`);
  assert.ok(jar.session, "session cookie issued");
  return jar;
}

/** Every 200 from the actual route must satisfy the published contracts. */
function assertMeContract(body: any) {
  const envelope = validateValue("http.success-envelope.v1", body);
  assert.ok(envelope.valid, JSON.stringify(envelope));
  const data = validateValue("http.me.v1", body.data);
  assert.ok(data.valid, JSON.stringify(data));
}

async function me(jar: Jar) {
  const response = await call("/api/v1/me", { jar });
  const body = (await response.json()) as any;
  if (response.status === 200) assertMeContract(body);
  return { response, body };
}

async function setGrants(userId: string, grants: unknown[]) {
  const current = JSON.parse(await readFile(fixture, "utf8"));
  current[userId] = grants;
  await writeFile(fixture, JSON.stringify(current));
}

function assertPrivate(response: Response) {
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.match(response.headers.get("cache-control") ?? "", /private/);
}

before(async () => {
  db = await startPostgres();
  dir = await mkdtemp(join(tmpdir(), "sa15-auth-"));
  fixture = join(dir, "access.json");
  await writeFile(fixture, "{}");
  server = createServer(async (req, res) => {
    try {
      const response = await route(await toRequest(req));
      const headers: Record<string, string | string[]> = {};
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") headers[key] = value;
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers["set-cookie"] = cookies;
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(error);
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = authConfig({
    APP_ENV: "test",
    NODE_ENV: "test",
    DATABASE_URL: db.url,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: "test-only-secret-0123456789abcdefghijklmnop",
    AUTH_LOCAL_PASSWORD: "true",
    AUTH_ACCESS_SOURCE: "test-fixture",
    AUTH_TEST_ACCESS_FIXTURE: fixture,
  });
  runtime = createAuthRuntime(config);
  await migrateAuthSchema(runtime.auth);
  users = await seedTestIdentities(runtime.auth, PASSWORD, fixture);
  sql = new pg.Pool({ connectionString: db.url, max: 2 });
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await sql?.end();
  await runtime?.pool.end();
  await db?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("Better Auth local email/password runtime", () => {
  test("unauthenticated identity lookup is 401 and never cacheable", async () => {
    const response = await call("/api/v1/me");
    assert.equal(response.status, 401);
    assertPrivate(response);
    const body = (await response.json()) as any;
    assert.equal(body.error.code, "unauthenticated");
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  });

  test("wrong password is rejected without a session cookie", async () => {
    const jar = new Jar();
    const response = await call(
      "/api/auth/sign-in/email",
      browserPost(jar, {
        email: users.staff.email,
        password: "wrong password value",
      }),
    );
    assert.equal(response.status, 401);
    assert.equal(jar.session, undefined);
    assertPrivate(response);
  });

  test("sign-in issues an HttpOnly SameSite=Lax session cookie and /me reports server roles", async () => {
    const jar = new Jar();
    const response = await call(
      "/api/auth/sign-in/email",
      browserPost(jar, {
        email: users.staff.email,
        password: PASSWORD,
      }),
    );
    assert.equal(response.status, 200);
    assertPrivate(response);
    const cookie = response.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION}=`))!;
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=604800/);
    const { response: res, body } = await me(jar);
    assert.equal(res.status, 200);
    assertPrivate(res);
    assert.match(res.headers.get("vary") ?? "", /Cookie/);
    assert.deepEqual(body.data.user, {
      id: users.staff.id,
      email: users.staff.email,
      name: "Test staff",
    });
    assert.deepEqual(body.data.access, { status: "active", roles: ["staff"] });
    assert.ok(
      Date.parse(body.data.session.expiresAt) > Date.now() + 6 * 86400e3,
    );
  });

  test("user IDs stay the opaque Better Auth IDs stored in the database", async () => {
    const { rows } = await sql.query(`SELECT id FROM "user" WHERE email = $1`, [
      users.collector.email,
    ]);
    assert.equal(rows[0].id, users.collector.id);
    const { body } = await me(await signIn("collector"));
    assert.equal(body.data.user.id, rows[0].id);
  });

  test("role guards use server roles; client-supplied role fields are ignored", async () => {
    const staff = await signIn("staff");
    const collector = await signIn("collector");
    assert.equal(
      (await call("/harness/collector-read", { jar: staff })).status,
      403,
    );
    assert.equal(
      (await call("/harness/collector-read", { jar: collector })).status,
      200,
    );
    const forged = await call(
      "/harness/staff-action",
      browserPost(
        collector,
        { role: "staff", roles: ["staff"] },
        { "x-role": "staff" },
      ),
    );
    assert.equal(forged.status, 403);
    assertPrivate(forged);
    const ok = await call("/harness/staff-action", browserPost(staff, {}));
    assert.equal(ok.status, 200);
    assert.deepEqual(((await ok.json()) as any).data.roles, ["staff"]);
    // Profile updates cannot smuggle a role either.
    const update = await call(
      "/api/auth/update-user",
      browserPost(collector, { name: "Renamed", role: "staff" }),
    );
    assert.notEqual(update.status, 500);
    const { body } = await me(collector);
    assert.deepEqual(body.data.access.roles, ["collector"]);
  });

  test("a disabled extra role is not granted; only enabled roles count", async () => {
    const { body } = await me(await signIn("multi"));
    assert.deepEqual(body.data.access, {
      status: "active",
      roles: ["collector"],
    });
  });

  test("pending identity sees its identity but every protected route is denied", async () => {
    const jar = await signIn("pending");
    const { response, body } = await me(jar);
    assert.equal(response.status, 200);
    assert.deepEqual(body.data.access, { status: "pending", roles: [] });
    const denied = await call("/harness/collector-read", { jar });
    assert.equal(denied.status, 403);
    assert.equal(
      ((await denied.json()) as any).error.message,
      "Access pending",
    );
  });

  test("disabled identity is denied, and revoking a role denies the very next request", async () => {
    const disabled = await signIn("disabled");
    assert.deepEqual((await me(disabled)).body.data.access, {
      status: "disabled",
      roles: [],
    });
    assert.equal(
      (await call("/harness/collector-read", { jar: disabled })).status,
      403,
    );

    const collector = await signIn("collector");
    assert.equal(
      (await call("/harness/collector-read", { jar: collector })).status,
      200,
    );
    await setGrants(users.collector.id, [
      { role: "collector", enabled: false },
    ]);
    try {
      const denied = await call("/harness/collector-read", { jar: collector });
      assert.equal(denied.status, 403);
      assert.equal(
        ((await denied.json()) as any).error.message,
        "Access disabled",
      );
    } finally {
      await setGrants(users.collector.id, [
        { role: "collector", enabled: true },
      ]);
    }
  });

  test("expired session is rejected, its cookie cleared and its row deleted", async () => {
    const jar = await signIn("customer");
    const token = decodeURIComponent(jar.session!).split(".")[0];
    await sql.query(
      `UPDATE session SET "expiresAt" = now() - interval '1 minute' WHERE token = $1`,
      [token],
    );
    const stale = jar.header();
    const response = await call("/api/v1/me", { jar });
    assert.equal(response.status, 401);
    assert.ok(
      response.headers
        .getSetCookie()
        .some((c) => c.startsWith(`${SESSION}=`) && /Max-Age=0/i.test(c)),
      "session cookie cleared",
    );
    const { rowCount } = await sql.query(
      `SELECT 1 FROM session WHERE token = $1`,
      [token],
    );
    assert.equal(rowCount, 0);
    // Replaying the old cookie value does not resurrect it.
    const replay = await call("/api/v1/me", { headers: { cookie: stale } });
    assert.equal(replay.status, 401);
  });

  test("sessions inside the refresh window are extended and the cookie is re-issued", async () => {
    const jar = await signIn("customer");
    const token = decodeURIComponent(jar.session!).split(".")[0];
    await sql.query(
      `UPDATE session SET "expiresAt" = now() + interval '5 days' WHERE token = $1`,
      [token],
    );
    const response = await call("/api/v1/me", { jar });
    assert.equal(response.status, 200);
    const cookie = response.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION}=`));
    assert.ok(cookie, "refreshed cookie forwarded by /api/v1/me");
    assert.match(cookie, /Max-Age=604800/);
    const { rows } = await sql.query(
      `SELECT "expiresAt" FROM session WHERE token = $1`,
      [token],
    );
    assert.ok(rows[0].expiresAt.getTime() > Date.now() + 6.9 * 86400e3);
    // Better Auth 1.7.15 keeps the token value on refresh (documented).
    assert.equal(decodeURIComponent(jar.session!).split(".")[0], token);
  });

  test("Server Component lookup never extends the session; /me then moves DB and cookie expiry together", async () => {
    const jar = await signIn("staff");
    const token = decodeURIComponent(jar.session!).split(".")[0];
    await sql.query(
      `UPDATE session SET "expiresAt" = now() + interval '5 days' WHERE token = $1`,
      [token],
    );
    const before = (
      await sql.query(`SELECT "expiresAt" FROM session WHERE token = $1`, [
        token,
      ])
    ).rows[0].expiresAt.getTime();
    // What app/page.tsx does: a cookie-bearing lookup that cannot set cookies.
    const identity = await pageIdentity(
      new Headers({ cookie: jar.header() }),
      () => runtime,
    );
    assert.equal(identity.state, "signed-in");
    const afterPage = (
      await sql.query(`SELECT "expiresAt" FROM session WHERE token = $1`, [
        token,
      ])
    ).rows[0].expiresAt.getTime();
    assert.equal(afterPage, before, "SSR lookup did not consume the refresh");
    // The browser's SessionRefresh call reaches a route that sets cookies.
    const started = Date.now();
    const response = await call("/api/v1/me", { jar });
    assert.equal(response.status, 200);
    const cookie = response.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${SESSION}=`));
    assert.ok(cookie, "/me re-issues the session cookie");
    const maxAge = Number(/Max-Age=(\d+)/i.exec(cookie)![1]);
    const body = (await response.json()) as any;
    const db = (
      await sql.query(`SELECT "expiresAt" FROM session WHERE token = $1`, [
        token,
      ])
    ).rows[0].expiresAt.getTime();
    assert.ok(db > before + 86400e3, "row extended");
    assert.equal(new Date(body.data.session.expiresAt).getTime(), db);
    // Cookie lifetime and row expiry agree to within the request duration.
    const cookieExpiry = started + maxAge * 1000;
    assert.ok(Math.abs(cookieExpiry - db) < 5000, `${cookieExpiry} vs ${db}`);
    // A second /me inside the window does not refresh again.
    const again = await call("/api/v1/me", { jar });
    assert.equal(
      again.headers.getSetCookie().filter((c) => c.startsWith(`${SESSION}=`))
        .length,
      0,
    );
  });

  test("self-service profile edits are disabled; display names stay seeded", async () => {
    const jar = await signIn("pending");
    const response = await call(
      "/api/auth/update-user",
      browserPost(jar, { name: "Operator (verified)" }),
    );
    assert.equal(response.status, 404);
    const { rows } = await sql.query(`SELECT name FROM "user" WHERE id = $1`, [
      users.pending.id,
    ]);
    assert.notEqual(rows[0].name, "Operator (verified)");
  });

  test("each sign-in mints a new server token; forged or unsigned cookies are ignored", async () => {
    const a = await signIn("staff");
    const b = await signIn("staff");
    assert.notEqual(a.session, b.session);
    const { rows } = await sql.query(`SELECT token FROM session LIMIT 1`);
    const unsigned = await call("/api/v1/me", {
      headers: { cookie: `${SESSION}=${rows[0].token}` },
    });
    assert.equal(unsigned.status, 401);
    const forged = await call("/api/v1/me", {
      headers: { cookie: `${SESSION}=attacker.chosen` },
    });
    assert.equal(forged.status, 401);
    // Signing in while carrying a forged cookie still yields a fresh token.
    const jar = new Jar();
    jar.cookies.set(SESSION, "attacker.chosen");
    await signIn("staff", jar);
    assert.notEqual(jar.session, "attacker.chosen");
    assert.equal((await me(jar)).response.status, 200);
  });

  test("sign-out with an untrusted Origin is refused and the session survives", async () => {
    const jar = await signIn("staff");
    for (const bad of [
      { origin: "https://evil.example" },
      { origin: "null" },
    ]) {
      const response = await call("/api/auth/sign-out", {
        method: "POST",
        jar,
        body: "{}",
        headers: { "content-type": "application/json", ...bad },
      });
      assert.equal(response.status, 403, JSON.stringify(bad));
    }
    assert.equal((await me(jar)).response.status, 200);
  });

  test("sign-out revokes the session on the server", async () => {
    const jar = await signIn("staff");
    const stale = jar.header();
    const response = await call("/api/auth/sign-out", browserPost(jar, {}));
    assert.equal(response.status, 200);
    assertPrivate(response);
    assert.equal(jar.session, undefined, "cookie cleared");
    const replay = await call("/api/v1/me", { headers: { cookie: stale } });
    assert.equal(replay.status, 401);
  });

  test("revoking other sessions denies the other device's next request", async () => {
    const laptop = await signIn("collector");
    const phone = await signIn("collector");
    const response = await call(
      "/api/auth/revoke-other-sessions",
      browserPost(laptop, {}),
    );
    assert.equal(response.status, 200);
    assert.equal((await me(phone)).response.status, 401);
    assert.equal((await me(laptop)).response.status, 200);
  });

  test("self-registration is disabled and creates no user", async () => {
    const before = await sql.query(`SELECT count(*)::int AS n FROM "user"`);
    const response = await call(
      "/api/auth/sign-up/email",
      browserPost(undefined, {
        email: "intruder@auth-test.invalid",
        password: PASSWORD,
        name: "Intruder",
      }),
    );
    assert.ok(
      response.status >= 400 && response.status < 500,
      `status ${response.status}`,
    );
    const afterCount = await sql.query(`SELECT count(*)::int AS n FROM "user"`);
    assert.equal(afterCount.rows[0].n, before.rows[0].n);
  });

  test("login CSRF: cross-site navigation and untrusted origins cannot sign in", async () => {
    const body = JSON.stringify({
      email: users.staff.email,
      password: PASSWORD,
    });
    const navigation = await call("/api/auth/sign-in/email", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    });
    assert.equal(navigation.status, 403);
    const crossOrigin = await call("/api/auth/sign-in/email", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
      },
    });
    assert.equal(crossOrigin.status, 403);
    const redirect = await call(
      "/api/auth/sign-in/email",
      browserPost(undefined, {
        email: users.staff.email,
        password: PASSWORD,
        callbackURL: "https://evil.example/steal",
      }),
    );
    assert.equal(redirect.status, 403);
  });

  test("native-style client (no Origin/Fetch Metadata) signs in and stores the same session", async () => {
    const jar = new Jar();
    const response = await call("/api/auth/sign-in/email", {
      method: "POST",
      jar,
      body: JSON.stringify({
        email: users.collector.email,
        password: PASSWORD,
      }),
      headers: {
        "content-type": "application/json",
        "x-stateaction-client": "android",
      },
    });
    assert.equal(response.status, 200);
    const { body } = await me(jar);
    assert.deepEqual(body.data.access.roles, ["collector"]);
    // Native mutations still need the client header and JSON.
    const missing = await call("/harness/collector-read", {
      jar,
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    assert.equal(missing.status, 403);
  });

  test("human mutation guard: origin, fetch metadata, client header and JSON are enforced", async () => {
    const staff = await signIn("staff");
    const cases: [string, Record<string, string>][] = [
      ["evil origin", { origin: "https://evil.example" }],
      ["null origin", { origin: "null" }],
      ["cross-site", { "sec-fetch-site": "cross-site" }],
      ["same-site sibling", { "sec-fetch-site": "same-site" }],
      ["no client header", { "x-stateaction-client": "" }],
      ["form post", { "content-type": "application/x-www-form-urlencoded" }],
      ["text/plain", { "content-type": "text/plain" }],
    ];
    for (const [name, override] of cases) {
      const init = browserPost(staff, {}, override);
      const response = await call("/harness/staff-action", init);
      assert.equal(response.status, 403, name);
      assertPrivate(response);
    }
  });

  test("service bearer credentials cannot use human endpoints even beside a valid cookie", async () => {
    const jar = await signIn("staff");
    const bearer = `Bearer sa_svc_${"A".repeat(43)}`;
    const response = await call("/api/v1/me", {
      jar,
      headers: { authorization: bearer },
    });
    assert.equal(response.status, 401);
    const mutation = await call(
      "/harness/staff-action",
      browserPost(jar, {}, { authorization: bearer }),
    );
    assert.equal(mutation.status, 401);
  });

  test("repeated sign-in attempts from one address are rate limited", async () => {
    const ip = "203.0.113.77";
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await call(
        "/api/auth/sign-in/email",
        browserPost(
          undefined,
          {
            email: users.staff.email,
            password: "wrong password value",
          },
          { "x-forwarded-for": ip },
        ),
      );
      statuses.push(response.status);
    }
    assert.ok(statuses.includes(429), statuses.join(","));
  });

  test("the limiter keys only on X-Forwarded-For; a forged X-Real-IP cannot open new buckets", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await call(
        "/api/auth/sign-in/email",
        browserPost(
          undefined,
          { email: users.staff.email, password: "wrong password value" },
          {
            "x-forwarded-for": "203.0.113.88",
            "x-real-ip": `198.18.0.${i + 1}`,
          },
        ),
      );
      statuses.push(response.status);
    }
    assert.ok(statuses.includes(429), statuses.join(","));
  });

  test("operator configuration is never echoed to users", async () => {
    const broken = authRouteHandlers(() => {
      throw new Error("BETTER_AUTH_SECRET must be a random value");
    });
    const response = await broken.GET(
      new Request(`${origin}/api/auth/get-session`),
    );
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.doesNotMatch(text, /BETTER_AUTH|DATABASE_URL|secret/i);
  });
});
