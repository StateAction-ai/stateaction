// Shared real-stack harness for SA-16 browser/HTTP checks: a throwaway
// Postgres migrated and seeded by the SA-13 migrator, the production
// `next build` output served by `next start`, real Better Auth, and Next
// connected ONLY as the restricted `stateaction_app` role. Same code and
// environment contract as Render; nothing here touches R2 or hosted resources.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { startCatalogPostgres } from "../../../packages/server/test-auth/postgres.mjs";
import { startSeaweedfs } from "./seaweedfs.mjs";
import { startOutageProxy } from "./outage-proxy.mjs";

export const webDir = fileURLToPath(new URL("..", import.meta.url));
const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const nextBin = createRequire(join(webDir, "package.json")).resolve(
  "next/dist/bin/next",
);
export const SESSION = "better-auth.session_token";

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

let ipCounter = 0;
export class Jar {
  cookies = new Map();
  // TEST-ONLY simulated client address for Better Auth's per-IP limiter.
  ip = `198.51.100.${(++ipCounter % 250) + 1}`;
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

export async function startStack({ storage = false } = {}) {
  const password = "e2e-only " + randomBytes(9).toString("base64url");
  const db = await startCatalogPostgres();
  let s3;
  let outage;
  try {
    if (storage) {
      s3 = await startSeaweedfs();
      outage = await startOutageProxy(s3.endpoint);
    }
  } catch (error) {
    outage?.stop();
    await s3?.stop();
    await db.stop();
    throw error;
  }
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    APP_ENV: "local",
    DATABASE_HOST: new URL(db.appUrl).hostname,
    DATABASE_PORT: new URL(db.appUrl).port,
    DATABASE_NAME: new URL(db.appUrl).pathname.slice(1),
    APP_DB_PASSWORD: decodeURIComponent(new URL(db.appUrl).password),
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    AUTH_LOCAL_PASSWORD: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    ...(s3 && {
      S3_ENDPOINT: outage.endpoint,
      S3_REGION: "us-east-1",
      S3_BUCKET: s3.bucket ?? "stateaction-sa21-e2e",
      S3_ACCESS_KEY_ID: s3.accessKeyId,
      S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
      PROCESSING_PROFILE_REVISION: "sa21-e2e-1",
      SUPPORTED_RGB_PROFILES: "h264_mcap_v1",
    }),
  };
  let logs = "";
  let next;
  const stop = async () => {
    if (next && next.exitCode === null) {
      try {
        process.kill(-next.pid, "SIGTERM");
      } catch {}
      await sleep(500);
    }
    await db.stop();
    outage?.stop();
    await s3?.stop();
  };
  try {
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
          AUTH_TEST_PASSWORD: password,
        },
        encoding: "utf8",
      },
    );
    if (boot.status !== 0) throw new Error(boot.stderr);
    const users = JSON.parse(boot.stdout);
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
    const probe = (path) =>
      new Promise((resolve, reject) => {
        const req = request(origin + path, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        req.on("error", reject);
        req.end();
      });
    for (let i = 0; ; i++) {
      try {
        if ((await probe("/login")) === 200) break;
      } catch {}
      if (i > 120 || next.exitCode !== null)
        throw new Error(`next start failed:\n${logs}`);
      await sleep(500);
    }
    return {
      db,
      s3,
      outage,
      origin,
      env,
      users,
      password,
      stop,
      logs: () => logs,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

export function call(
  origin,
  path,
  { method = "GET", body, headers = {}, jar } = {},
) {
  const h = { ...headers };
  if (jar?.cookies.size) h.cookie = jar.header();
  h["x-forwarded-for"] ??= jar?.ip ?? `198.51.100.${(++ipCounter % 250) + 1}`;
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

export const browserHeaders = (origin, extra = {}) => ({
  "content-type": "application/json",
  origin,
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "x-stateaction-client": "web",
  ...extra,
});

export async function signIn(stack, label) {
  const jar = new Jar();
  const res = await call(stack.origin, "/api/auth/sign-in/email", {
    method: "POST",
    jar,
    body: JSON.stringify({
      email: stack.users[label].email,
      password: stack.password,
    }),
    headers: browserHeaders(stack.origin),
  });
  if (res.status !== 200)
    throw new Error(`${label}: ${res.status} ${res.text}`);
  return jar;
}
