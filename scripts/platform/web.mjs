import { loadEnvFile } from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
// Loading via API avoids Next forwarding --env-file into unsupported NODE_OPTIONS.
loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const cli = require.resolve("next/dist/bin/next");
const command = process.argv[2];
if (!["dev", "start"].includes(command))
  throw new Error("Expected dev or start");
process.argv = [process.execPath, cli, command, "--hostname", "127.0.0.1"];
await import(pathToFileURL(cli).href);
