// A separate OS process that runs the SHARED controller once, so a test can
// SIGKILL it ("controller loss") and later run it again with the same runRef.
import { JobsApi } from "../dist/api-client.js";
import { controllerSettings, controllerToken } from "../dist/config.js";
import { runController } from "../dist/controller.js";
import { JournalStore } from "../dist/journal.js";

const settings = controllerSettings();
const outcome = await runController(
  {
    settings,
    api: new JobsApi(settings.apiUrl, controllerToken(), settings.apiTimeoutMs),
    store: new JournalStore(settings.stateDir),
  },
  { jobId: process.env.TEST_JOB_ID, runRef: process.env.TEST_RUN_REF },
);
console.log(JSON.stringify(outcome));
