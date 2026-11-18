#!/usr/bin/env node
// SA-43 provider-qualification harness (explicit opt-in).
//
// Drives the EXISTING built S3MultipartProvider / storageClient / presignObject
// from packages/server/dist against ONE already-existing private bucket and one
// agreed per-run key prefix. It is not a second transport. The run logic is in
// r2-qualification-run.mjs (injected I/O, tested against a fake store).
//
//   node scripts/platform/qualify-r2-transfers.mjs --config <owner-only.json>
//        [--execute]
//
// Without --execute the config is validated and the upload plan is printed
// (no network). Nothing is auto-discovered: no ~/.config, no .env, no ambient
// provider credentials. See docs/components/r2-transfer-qualification.md.
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ConfigError,
  readOwnerOnlyConfig,
  uploadPlan,
  validateConfig,
} from "./r2-qualification-lib.mjs";
import { runQualification } from "./r2-qualification-run.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const serverDir = join(repoRoot, "packages", "server");

function parseArgs(argv) {
  const out = { execute: false, config: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--execute") out.execute = true;
    else if (argv[i] === "--config") out.config = argv[++i] ?? null;
    else throw new ConfigError("usage: --config <file> [--execute]");
  }
  if (!out.config) throw new ConfigError("--config <file> is required");
  return out;
}

async function loadServerDeps() {
  const dist = (p) => pathToFileURL(join(serverDir, "dist", p)).href;
  try {
    const [provider, plan, storage] = await Promise.all([
      import(dist("transport/provider.js")),
      import(dist("transport/plan.js")),
      import(dist("storage.js")),
    ]);
    const req = createRequire(join(serverDir, "package.json"));
    const s3 = await import(
      pathToFileURL(req.resolve("@aws-sdk/client-s3")).href
    );
    return { provider, plan, storage, s3 };
  } catch {
    throw new ConfigError(
      "packages/server is not built; run the server build first (no auto-build)",
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let raw;
  try {
    raw = JSON.parse(readOwnerOnlyConfig(args.config));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("config is not valid JSON");
  }
  const cfg = validateConfig(raw, { repoRoot });
  if (!args.execute) {
    console.log(
      JSON.stringify({
        mode: "dry-run",
        endpointOrigin: cfg.provider.endpoint,
        runPrefix: cfg.runPrefix,
        budgets: cfg.budgets,
        uploadPlan: uploadPlan(cfg),
        note: "no provider call made; pass --execute to run",
      }),
    );
    return 0;
  }
  const deps = await loadServerDeps();
  const serverConfig = {
    appEnv: "development",
    databaseUrl: "",
    endpoint: cfg.provider.endpoint,
    publicEndpoint: cfg.provider.endpoint,
    region: cfg.provider.region,
    bucket: cfg.provider.bucket,
    accessKeyId: cfg.credentials.accessKeyId,
    secretAccessKey: cfg.credentials.secretAccessKey,
  };
  const control = deps.storage.storageClient(
    serverConfig,
    cfg.budgets.operationTimeoutMs,
  );
  const signing = deps.storage.storageClient(
    serverConfig,
    cfg.budgets.operationTimeoutMs,
    serverConfig.publicEndpoint,
  );
  try {
    const result = await runQualification(cfg, {
      provider: new deps.provider.S3MultipartProvider(
        control,
        signing,
        cfg.provider.bucket,
      ),
      control,
      ProviderUploadGone: deps.provider.ProviderUploadGone,
      ListPartsCommand: deps.s3.ListPartsCommand,
      DeleteObjectCommand: deps.s3.DeleteObjectCommand,
      planFor: deps.plan.planFor,
      partRange: deps.plan.partRange,
      presignGet: (key, ttl) =>
        deps.storage.presignObject(serverConfig, {
          method: "GET",
          key,
          expiresInSeconds: ttl,
        }),
      fetch: globalThis.fetch,
    });
    console.log(JSON.stringify(result.summary));
    return result.exitCode;
  } finally {
    control.destroy();
    signing.destroy();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    // Only our own config messages are echoed; provider errors never reach here.
    console.error(
      error instanceof ConfigError
        ? `config: ${error.message}`
        : `error: ${error?.name ?? "Error"}`,
    );
    process.exit(error instanceof ConfigError ? 3 : 1);
  },
);
