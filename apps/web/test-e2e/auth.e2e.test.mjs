// REAL-CATALOG E2E (SA-15 x SA-13): the production `next build` output served
// by `next start`, real Better Auth 1.7.15 routes and cookies, and a
// throwaway Postgres migrated and seeded by the published SA-13 migrator and
// local seed. Next connects ONLY as the restricted `stateaction_app` role, and
// roles come from catalog `access` rows (CatalogAccessStore); operator
// changes use the migration owner credential. Requests mimic browser (Origin +
// Fetch Metadata) and native (neither) clients over raw HTTP, plus one real
// headless Chrome. Not Google, native app, Tailscale or hosted qualification.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { findChrome, launchChrome } from "./chrome.mjs";
import { validateValue } from "@stateaction/contracts";
import { startCatalogPostgres } from "../../../packages/server/test-auth/postgres.mjs";
import {
  waitForGroupExit,
  leaked,
} from "../../../scripts/platform/process-wait.mjs";

const webDir = fileURLToPath(new URL("..", import.meta.url));
const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const nextBin = createRequire(join(webDir, "package.json")).resolve(
  "next/dist/bin/next",
);
const PASSWORD = "e2e-only " + randomBytes(9).toString("base64url");
const SESSION = "better-auth.session_token";

let db,
  next,
  origin,
  users,
  env,
  logs = "";

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

let ipCounter = 0;
class Jar {
  cookies = new Map();
  // TEST-ONLY simulated client address for Better Auth's per-IP limiter.
  ip = `198.51.100.${++ipCounter}`;
  apply(headers) {
    for (const line of [headers["set-cookie"] ?? []].flat()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/max-age=0/i.test(line) || !value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function call(path, { method = "GET", body, headers = {}, jar } = {}) {
  const h = { ...headers };
  if (jar?.cookies.size) h.cookie = jar.header();
  h["x-forwarded-for"] ??= jar?.ip ?? `198.51.100.${++ipCounter}`;
  return new Promise((resolve, reject) => {
    const req = request(origin + path, { method, headers: h }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        jar?.apply(res.headers);
        resolve({ status: res.statusCode, headers: res.headers, text });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

const browserPost = (jar, body, extra = {}) => ({
  method: "POST",
  jar,
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

async function signIn(label) {
  const jar = new Jar();
  const res = await call(
    "/api/auth/sign-in/email",
    browserPost(jar, { email: users[label].email, password: PASSWORD }),
  );
  assert.equal(res.status, 200, `${label}: ${res.text}`);
  assert.ok(jar.cookies.get(SESSION));
  return jar;
}

const page = (path, jar) =>
  call(path, {
    jar,
    headers: {
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    },
  });

// Operator actions on session/access rows, with the migration owner credential.
const psql = (sqlText) => db.ownerSql(sqlText);
const quoted = (id) => `'${id.replace(/[^A-Za-z0-9_-]/g, "")}'`;
const tokenOf = (cookieValue) => decodeURIComponent(cookieValue).split(".")[0];
const rowExpiry = (token) =>
  Number(
    psql(
      `SELECT floor(extract(epoch FROM "expiresAt") * 1000) FROM session WHERE token = '${token.replace(/[^A-Za-z0-9_-]/g, "")}'`,
    ),
  );
const moveExpiry = (token, interval) =>
  psql(
    `UPDATE session SET "expiresAt" = now() + interval '${interval}' WHERE token = '${token.replace(/[^A-Za-z0-9_-]/g, "")}'`,
  );

function assertNoStore(res, what) {
  assert.match(
    String(res.headers["cache-control"]),
    /no-store/,
    `${what}: ${res.headers["cache-control"]}`,
  );
  assert.doesNotMatch(
    String(res.headers["cache-control"]),
    /public|s-maxage/,
    what,
  );
}

before(async () => {
  db = await startCatalogPostgres();
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    APP_ENV: "local",
    // TEST-ONLY: trust the loopback harness peer for simulated client addresses (rejected on hosted).
    AUTH_TRUSTED_PROXIES: "127.0.0.1,::1",
    // Hosted-like component settings (Render supplies these, never a DSN);
    // Next resolves them through the shared applicationDatabaseUrl.
    DATABASE_HOST: new URL(db.appUrl).hostname,
    DATABASE_PORT: new URL(db.appUrl).port,
    DATABASE_NAME: new URL(db.appUrl).pathname.slice(1),
    APP_DB_PASSWORD: decodeURIComponent(new URL(db.appUrl).password),
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    AUTH_LOCAL_PASSWORD: "true",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const boot = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "test-auth/catalog-bootstrap-cli.ts",
    ],
    {
      cwd: serverDir,
      env: {
        PATH: env.PATH,
        HOME: env.HOME,
        CATALOG_OWNER_URL: db.ownerUrl,
        AUTH_TEST_PASSWORD: PASSWORD,
      },
      encoding: "utf8",
    },
  );
  assert.equal(boot.status, 0, boot.stderr);
  users = JSON.parse(boot.stdout);
  next = spawn(
    process.execPath,
    [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"],
    {
      cwd: webDir,
      env: { ...env, NODE_ENV: "production" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  next.stdout.on("data", (c) => (logs += c));
  next.stderr.on("data", (c) => (logs += c));
  for (let i = 0; ; i++) {
    try {
      if ((await call("/login")).status === 200) break;
    } catch {}
    if (i > 600 || next.exitCode !== null)
      throw new Error(`next start failed:\n${logs}`);
    await sleep(100);
  }
});

after(async () => {
  if (next && next.exitCode === null) {
    try {
      process.kill(-next.pid, "SIGTERM");
    } catch {}
    await waitForGroupExit(next.pid).catch(leaked);
  }
  await db?.stop();
});

describe("Next.js production server with Better Auth", () => {
  test("protected page redirects anonymous visitors to /login, privately", async () => {
    const res = await page("/");
    assert.equal(res.status, 307);
    assert.match(res.headers.location, /\/login$/);
    assertNoStore(res, "/");
  });

  test("login page offers local password sign-in, hides operator settings and is not cacheable", async () => {
    const res = await page("/login");
    assert.equal(res.status, 200);
    assertNoStore(res, "/login");
    assert.match(res.text, /Sign in/);
    assert.match(res.text, /type="password"/);
    assert.doesNotMatch(res.text, /Continue with Google/); // no Google settings here
    assert.doesNotMatch(
      res.text,
      /BETTER_AUTH|DATABASE_URL|APP_DB_PASSWORD|AUTH_LOCAL_PASSWORD|test-fixture/,
    );
    assert.ok(!res.text.includes(env.BETTER_AUTH_SECRET));
  });

  test("anonymous session lookup returns null with no-store", async () => {
    const res = await call("/api/auth/get-session");
    assert.equal(res.status, 200);
    assert.equal(res.text, "null");
    assertNoStore(res, "get-session");
  });

  test("staff sign-in -> home page shows server roles -> /api/v1/me agrees", async () => {
    const jar = await signIn("staff");
    const home = await page("/pipeline", jar);
    assert.equal(home.status, 200, "staff role opens the staff page");
    assertNoStore(home, "home");
    assert.match(home.text, /Account menu for Seed Staff/);
    const me = await call("/api/v1/me", { jar });
    assert.equal(me.status, 200);
    assertNoStore(me, "me");
    const body = JSON.parse(me.text);
    assert.ok(validateValue("http.success-envelope.v1", body).valid);
    assert.deepEqual(validateValue("http.me.v1", body.data), {
      valid: true,
      value: body.data,
    });
    assert.equal(body.data.user.id, users.staff.id);
    assert.deepEqual(body.data.access, { status: "active", roles: ["staff"] });
    const login = await page("/login", jar);
    assert.equal(login.status, 307, "signed-in users skip the login page");
  });

  test("page loads never extend the session; /api/v1/me extends row and cookie together", async () => {
    const jar = await signIn("staff");
    const token = tokenOf(jar.cookies.get(SESSION));
    moveExpiry(token, "5 days");
    const before = rowExpiry(token);
    const home = await page("/data-browser", jar);
    assert.equal(home.status, 200);
    const pageCookies = [home.headers["set-cookie"] ?? []].flat();
    assert.ok(
      !pageCookies.some((c) => c.startsWith(`${SESSION}=`)),
      "the page response cannot carry a refresh",
    );
    assert.equal(rowExpiry(token), before, "SSR did not extend the row");
    assert.match(home.text, /Account menu for/);
    const started = Date.now();
    const me = await call("/api/v1/me", { jar });
    assert.equal(me.status, 200);
    const cookie = [me.headers["set-cookie"] ?? []]
      .flat()
      .find((c) => c.startsWith(`${SESSION}=`));
    assert.ok(cookie, "/api/v1/me re-issues the cookie");
    const maxAge = Number(/Max-Age=(\d+)/i.exec(cookie)[1]);
    const after = rowExpiry(token);
    assert.ok(after > before + 86400e3, "row extended");
    assert.equal(
      new Date(JSON.parse(me.text).data.session.expiresAt).getTime(),
      after,
    );
    assert.ok(Math.abs(started + maxAge * 1000 - after) < 5000);
  });

  test("real browser: the home page's SessionRefresh keeps cookie and row expiry in step", async (t) => {
    const binary = await findChrome();
    if (!binary) {
      t.skip(
        "no Chrome/Chromium binary; set CHROME_BIN to run the browser case",
      );
      return;
    }
    const jar = await signIn("collector");
    const token = tokenOf(jar.cookies.get(SESSION));
    moveExpiry(token, "5 days");
    const before = rowExpiry(token);
    const chrome = await launchChrome(binary);
    try {
      await chrome.send("Network.enable");
      await chrome.send("Network.setCookie", {
        name: SESSION,
        value: jar.cookies.get(SESSION),
        url: origin,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
        expires: Math.floor(before / 1000),
      });
      // Every browser request passes the harness's per-client address.
      await chrome.send("Network.setExtraHTTPHeaders", {
        headers: { "x-forwarded-for": jar.ip },
      });
      await chrome.send("Page.enable");
      await chrome.send("Page.navigate", { url: `${origin}/data-browser` });
      let after = before;
      for (let i = 0; i < 100 && after === before; i++) {
        await sleep(100);
        after = rowExpiry(token);
      }
      assert.ok(
        after > before + 86400e3,
        "the browser's /me call extended the row",
      );
      let stored;
      for (let i = 0; i < 50; i++) {
        const { cookies } = await chrome.send("Network.getCookies", {
          urls: [origin],
        });
        stored = cookies.find((c) => c.name === SESSION);
        if (stored && Math.abs(stored.expires * 1000 - after) < 5000) break;
        await sleep(100);
      }
      assert.ok(stored, "browser kept the session cookie");
      assert.ok(
        Math.abs(stored.expires * 1000 - after) < 5000,
        `cookie ${stored.expires * 1000} vs row ${after}`,
      );
      assert.equal(stored.httpOnly, true);
      const { result } = await chrome.send("Runtime.evaluate", {
        expression: "document.body.innerText",
        returnByValue: true,
      });
      assert.match(result.value, /Capture accounts use the Android app/);
    } finally {
      await chrome.close();
    }
  });

  test("the Next server reaches the catalog only as stateaction_app", async () => {
    await signIn("customer");
    const roles = psql(
      "SELECT DISTINCT usename FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND usename IS NOT NULL ORDER BY 1",
    ).split("\n");
    assert.deepEqual(roles, ["stateaction_app"]);
    assert.ok(!JSON.stringify(env).includes("migration_owner"));
    assert.equal(env.DATABASE_URL, undefined);
  });

  test("pending and disabled identities get explanatory pages, not the console", async () => {
    const pending = await page("/data-browser", await signIn("pending"));
    assert.equal(pending.status, 200);
    assert.match(pending.text, /Access pending/);
    assert.doesNotMatch(pending.text, /aria-label="Primary"/);
    const disabled = await page("/data-browser", await signIn("disabled"));
    assert.match(disabled.text, /Access disabled/);
  });

  test("role revocation applies to the next page load", async () => {
    const jar = await signIn("collector");
    assert.match(
      (await page("/data-browser", jar)).text,
      /Capture accounts use/,
    );
    psql(`DELETE FROM access WHERE user_id = ${quoted(users.collector.id)}`);
    assert.match((await page("/data-browser", jar)).text, /Access pending/);
  });

  test("cross-origin sign-out is refused; same-origin sign-out revokes server-side", async () => {
    const jar = await signIn("customer");
    const stale = jar.header();
    const evil = await call("/api/auth/sign-out", {
      method: "POST",
      jar,
      body: "{}",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    });
    assert.equal(evil.status, 403);
    assert.equal((await call("/api/v1/me", { jar })).status, 200);
    const out = await call("/api/auth/sign-out", browserPost(jar, {}));
    assert.equal(out.status, 200);
    assertNoStore(out, "sign-out");
    assert.equal(jar.cookies.get(SESSION), undefined);
    const replay = await call("/api/v1/me", { headers: { cookie: stale } });
    assert.equal(replay.status, 401);
    const home = await page("/", undefined);
    assert.equal(home.status, 307);
    const replayPage = await call("/data-browser", {
      headers: { cookie: stale },
    });
    assert.equal(
      replayPage.status,
      307,
      "revoked cookie cannot open the console",
    );
  });

  test("native-style sign-in without Origin works against the same backend", async () => {
    const jar = new Jar();
    const res = await call("/api/auth/sign-in/email", {
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
    assert.equal(res.status, 200);
    const me = JSON.parse((await call("/api/v1/me", { jar })).text);
    assert.equal(me.data.user.id, users.collector.id);
  });

  test("sign-up is disabled in the deployed route", async () => {
    const res = await call(
      "/api/auth/sign-up/email",
      browserPost(undefined, {
        email: "x@auth-test.invalid",
        password: PASSWORD,
        name: "X",
      }),
    );
    assert.ok(res.status >= 400 && res.status < 500, String(res.status));
  });
});
