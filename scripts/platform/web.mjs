import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const command = process.argv[2];
if (!["dev", "start"].includes(command))
  throw new Error("Expected dev or start");
// Hosted = production, or any Render-hosted service (Render injects RENDER=true)
// such as a development/preview service. Local runs never set RENDER.
const hosted =
  process.env.APP_ENV === "production" || process.env.RENDER === "true";
// Hosted processes receive injected environment variables only. A local file
// is a development convenience: optional, never overriding injected values.
const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
if (!hosted && existsSync(envFile)) process.loadEnvFile(envFile);
else if (!hosted && !process.env.APP_ENV)
  throw new Error("Create .env from .env.example (APP_ENV is not set)");
if (!process.env.APP_ENV) throw new Error("APP_ENV is required");
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const cli = require.resolve("next/dist/bin/next");
// Loopback by default. Hosted must bind every interface on Render's PORT;
// a development machine may opt in (e.g. Tailscale) with STATEACTION_WEB_HOST.
const hostname = hosted
  ? "0.0.0.0"
  : (process.env.STATEACTION_WEB_HOST ?? "127.0.0.1");
const port = process.env.PORT ?? "3000";
if (!/^\d{1,5}$/.test(port)) throw new Error("PORT must be numeric");
process.argv = [
  process.execPath,
  cli,
  command,
  ...(command === "dev" ? ["--webpack"] : []),
  "--hostname",
  hostname,
  "--port",
  port,
];
await import(pathToFileURL(cli).href);
