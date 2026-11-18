import { JobsApi } from "./api-client.js";
import { apiUrl, repairToken } from "./config.js";
import { REPAIR_TIMEOUT_MS, repairOnce } from "./repair.js";

// Render cron entrypoint: runs once, prints counts only (never a token or URL), exits.
try {
  const api = new JobsApi(apiUrl(), repairToken(), REPAIR_TIMEOUT_MS);
  console.log(JSON.stringify(await repairOnce(api)));
} catch (error) {
  console.error(
    "repair failed:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exitCode = 1;
}
