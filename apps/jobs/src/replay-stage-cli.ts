import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { JobsApi } from "./api-client.js";
import { apiUrl, controllerToken } from "./config.js";
import { replayStage } from "./replay-stage.js";

// SA-96: `replay-stage --job <id> --stage caption [--module m] --io-dir <dir> [--allow-spend]`.
try {
  const { values } = parseArgs({
    options: {
      job: { type: "string" },
      stage: { type: "string" },
      module: { type: "string" },
      "io-dir": { type: "string" },
      "cache-dir": { type: "string" },
      "allow-spend": { type: "boolean" },
    },
  });
  if (!values.job || !values.stage || !values["io-dir"])
    throw new Error(
      "usage: replay-stage --job <id> --stage segment|caption [--module <id>] --io-dir <dir> [--cache-dir <dir>] [--allow-spend]",
    );
  const cacheDir = values["cache-dir"] ?? process.env.STATEACTION_SEED_CACHE;
  if (!cacheDir)
    throw new Error("--cache-dir or STATEACTION_SEED_CACHE is required");
  const python = process.env.PYTHON_EXECUTABLE;
  if (!python) throw new Error("PYTHON_EXECUTABLE is required");
  const result = await replayStage(
    {
      api: new JobsApi(apiUrl(), controllerToken(), 30_000),
      cacheDir,
      python,
      workerDir: fileURLToPath(
        new URL("../../../workers/processing/", import.meta.url),
      ),
    },
    {
      jobId: values.job,
      stage: values.stage,
      module: values.module,
      ioDir: values["io-dir"],
      allowSpend: values["allow-spend"],
    },
  );
  console.log(
    JSON.stringify({
      module: result.module,
      exitCode: result.exitCode,
      status: (result.receipt as { status?: string } | null)?.status ?? null,
      errorCode:
        (result.receipt as { errorCode?: string } | null)?.errorCode ?? null,
    }),
  );
  process.exitCode = result.exitCode === 0 || result.receipt ? 0 : 1;
} catch (error) {
  console.error(
    "replay-stage failed:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exitCode = 1;
}
