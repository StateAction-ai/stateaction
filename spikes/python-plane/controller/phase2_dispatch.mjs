import assert from "node:assert/strict";
import { renderTaskStarterFromEnv } from "../../../packages/server/dist/jobs/dispatch.js";

const [jobId] = process.argv.slice(2);
assert.match(jobId, /^[a-f0-9-]{36}$/);
const localUrl = process.env.SPIKE_LOCAL_RENDER_URL;
const starter = renderTaskStarterFromEnv(
  localUrl
    ? { APP_ENV: "local", RENDER_LOCAL_DEV_URL: localUrl }
    : {
        APP_ENV: "production",
        PROCESS_RECORDING_TASK_SLUG: "zz-spike-python/process-recording",
        RENDER_API_KEY: process.env.RENDER_API_KEY,
      },
);
assert.ok(starter);
try {
  const started = await starter.start(
    { jobId, dispatchKey: `job:${jobId}` },
    AbortSignal.timeout(10000),
  );
  assert.match(started.taskRunId, /^trn-[A-Za-z0-9]+$/);
  console.log(started.taskRunId);
} catch (error) {
  console.error(error instanceof Error ? error.name : "DispatchError");
  process.exitCode = 1;
}
