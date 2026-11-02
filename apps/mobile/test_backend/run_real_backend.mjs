// REAL-BACKEND harness for the mobile auth client (SA-17 x SA-15 x SA-13).
//
// Starts the SAME backend code a Render deployment runs: the production
// `next build` output of apps/web served by `next start`, real Better Auth
// email/password routes and cookies, and a uniquely named throwaway Postgres
// migrated and seeded by the published catalog migrator. Next connects only
// as the restricted `stateaction_app` role. Then it runs the app's own Dart
// client/controller/ledger/gate code (`flutter test test_backend/...`) against
// it over real HTTP. Nothing here is a fake server; nothing is cached.
//
// A loopback TCP relay sits in front of Next so the Dart test can take the
// backend offline (connection refused) and back without restarting it, and
// a token-protected loopback control endpoint performs operator actions
// (expire/age/revoke sessions, change access rows) with the migration owner
// credential, exactly as an operator would in SQL.
//
// Not Google, not Tailscale/HTTPS, not a phone, not hosted qualification.
//
//   node apps/mobile/test_backend/run_real_backend.mjs   (needs docker, web build, flutter)
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, connect } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { startCatalogPostgres } from "../../../packages/server/test-auth/postgres.mjs";

const mobileDir = fileURLToPath(new URL("..", import.meta.url));
const webDir = fileURLToPath(new URL("../../web/", import.meta.url));
const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const nextBin = createRequire(join(webDir, "package.json")).resolve(
  "next/dist/bin/next",
);

const PASSWORD = "mobile-e2e " + randomBytes(9).toString("base64url");
const CONTROL_TOKEN = randomBytes(24).toString("base64url");

async function freePort() {
  const server = createTcpServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

/** Loopback TCP relay that can refuse connections (offline) on demand. */
function relay(listenPort, targetPort) {
  const sockets = new Set();
  let server = null;
  const online = () =>
    new Promise((resolve, reject) => {
      if (server) return resolve();
      server = createTcpServer((client) => {
        const upstream = connect(targetPort, "127.0.0.1");
        sockets.add(client).add(upstream);
        const drop = () => {
          client.destroy();
          upstream.destroy();
          sockets.delete(client);
          sockets.delete(upstream);
        };
        client.on("error", drop).on("close", drop);
        upstream.on("error", drop).on("close", drop);
        client.pipe(upstream).pipe(client);
      });
      server.once("error", reject);
      server.listen(listenPort, "127.0.0.1", resolve);
    });
  const offline = () =>
    new Promise((resolve) => {
      if (!server) return resolve();
      for (const s of sockets) s.destroy();
      sockets.clear();
      server.close(() => resolve());
      server = null;
    });
  return { online, offline };
}

const sqlText = (v) => `'${String(v).replace(/'/g, "''")}'`;
const interval = (v) => {
  if (!/^-?\d+ (seconds|minutes|hours|days)$/.test(v))
    throw new Error("bad interval");
  return `interval ${sqlText(v)}`;
};

let db,
  next,
  control,
  exitCode = 1,
  logs = "";
try {
  if (spawnSync("docker", ["version"], { stdio: "ignore" }).status !== 0)
    throw new Error("docker is required for the throwaway Postgres");
  db = await startCatalogPostgres();
  const nextPort = await freePort();
  const relayPort = await freePort();
  const origin = `http://127.0.0.1:${relayPort}`;
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    APP_ENV: "local",
    // Render-style component settings; Next resolves the restricted app DSN.
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
  if (boot.status !== 0)
    throw new Error(`catalog bootstrap failed:\n${boot.stderr}`);
  const users = JSON.parse(boot.stdout);

  next = spawn(
    process.execPath,
    [nextBin, "start", "-p", String(nextPort), "-H", "127.0.0.1"],
    {
      cwd: webDir,
      env: { ...env, NODE_ENV: "production" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  next.stdout.on("data", (c) => (logs += c));
  next.stderr.on("data", (c) => (logs += c));
  const link = relay(relayPort, nextPort);
  await link.online();
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`${origin}/api/v1/me`);
      if (res.status === 401) break;
    } catch {}
    if (i > 120 || next.exitCode !== null)
      throw new Error(`next start failed:\n${logs}`);
    await sleep(500);
  }

  const userId = (label) => {
    const user = users[label];
    if (!user) throw new Error(`unknown user ${label}`);
    return sqlText(user.id);
  };
  const actions = {
    // Server-side expiry of every session row for the user.
    expire: ({ user }) =>
      db.ownerSql(
        `UPDATE session SET "expiresAt" = now() - interval '1 second' WHERE "userId" = ${userId(user)}`,
      ),
    // Move expiry so Better Auth's updateAge refresh window applies.
    age: ({ user, by }) =>
      db.ownerSql(
        `UPDATE session SET "expiresAt" = now() + ${interval(by)} WHERE "userId" = ${userId(user)}`,
      ),
    revoke: ({ user }) =>
      db.ownerSql(`DELETE FROM session WHERE "userId" = ${userId(user)}`),
    sessions: ({ user }) =>
      db.ownerSql(
        `SELECT count(*) FROM session WHERE "userId" = ${userId(user)}`,
      ),
    expiry: ({ user }) =>
      db.ownerSql(
        `SELECT coalesce(max(floor(extract(epoch FROM "expiresAt") * 1000)), 0) FROM session WHERE "userId" = ${userId(user)}`,
      ),
    access: ({ user, role, enabled }) => {
      if (!["collector", "staff", "customer"].includes(role))
        throw new Error("bad role");
      return db.ownerSql(
        `INSERT INTO access (user_id, role, enabled, granted_by) VALUES (${userId(user)}, ${sqlText(role)}, ${enabled ? "true" : "false"}, 'sa17-test-operator')
         ON CONFLICT (user_id, role) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      );
    },
    offline: () => link.offline(),
    online: () => link.online(),
  };
  const expected = Buffer.from(`Bearer ${CONTROL_TOKEN}`);
  control = createHttpServer(async (req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? "");
    const action = actions[new URL(req.url, "http://x").pathname.slice(1)];
    if (
      auth.length !== expected.length ||
      !timingSafeEqual(auth, expected) ||
      req.method !== "POST" ||
      !action
    ) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const result = await action(body ? JSON.parse(body) : {});
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ result: result ?? null }));
    } catch (error) {
      res.writeHead(500).end(String(error.message));
    }
  });
  await new Promise((r) => control.listen(0, "127.0.0.1", r));

  const flutter = spawn(
    "flutter",
    ["test", "--reporter=expanded", "test_backend/real_backend_auth_test.dart"],
    {
      cwd: mobileDir,
      stdio: "inherit",
      env: {
        ...process.env,
        SA17_BACKEND_ORIGIN: origin,
        SA17_BACKEND_MODE: "local-control",
        SA17_CONTROL_URL: `http://127.0.0.1:${control.address().port}`,
        SA17_CONTROL_TOKEN: CONTROL_TOKEN,
        SA17_USERS: JSON.stringify(users),
        SA17_PASSWORD: PASSWORD,
      },
    },
  );
  exitCode = await new Promise((resolve) =>
    flutter.on("exit", (code) => resolve(code ?? 1)),
  );
} catch (error) {
  console.error(error.message);
  if (logs) console.error(`--- next output ---\n${logs}`);
  exitCode = 1;
} finally {
  control?.close();
  if (next && next.exitCode === null) {
    try {
      process.kill(-next.pid, "SIGTERM");
    } catch {}
    await sleep(500);
  }
  db?.stop();
}
process.exit(exitCode);
