import { parseArgs } from "node:util";
import { JobsApi } from "./api-client.js";
import { apiUrl, controllerToken } from "./config.js";
import { buildDiag } from "./diag.js";
import { JournalStore } from "./journal.js";

// SA-96: `pnpm --filter @stateaction/jobs diag -- --job <id> --out <file.tgz>`. Prints counts only.
try {
  const { values } = parseArgs({
    options: {
      job: { type: "string" },
      out: { type: "string" },
      "cache-dir": { type: "string" },
    },
  });
  if (!values.job || !values.out)
    throw new Error(
      "usage: diag --job <id> --out <file.tgz> [--cache-dir <dir>]",
    );
  const state = process.env.JOBS_STATE_DIR;
  if (!state) throw new Error("JOBS_STATE_DIR is required");
  const api = new JobsApi(apiUrl(), controllerToken(), 30_000);
  const result = await buildDiag(
    { api, store: new JournalStore(state), cacheDir: values["cache-dir"] },
    values.job,
    values.out,
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(
    "diag failed:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exitCode = 1;
}
