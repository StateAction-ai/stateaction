// A separate OS process that runs the SHARED controller once, so a test can
// SIGKILL it ("controller loss") and later run it again with the same runRef.
import { JobsApi } from "../dist/api-client.js";
import { controllerSettings, controllerToken } from "../dist/config.js";
import { runController } from "../dist/controller.js";
import { JournalStore } from "../dist/journal.js";

// Test-only interleaving control (SA-136). With TEST_STALL_AFTER_RUNNING_MS the process behaves as
// a controller that is descheduled right after it journals the child `running` and before it hands
// the child its bootstrap: it stalls once, synchronously (the event loop is blocked, as in a real
// scheduling stall), after the first `running` journal write of the TEST_STALL_STAGE stage.
const stallMs = Number(process.env.TEST_STALL_AFTER_RUNNING_MS ?? 0);
class TestJournalStore extends JournalStore {
  stalled = false;
  write(journal) {
    super.write(journal);
    if (
      stallMs > 0 &&
      !this.stalled &&
      journal.phase === "running" &&
      journal.stage === process.env.TEST_STALL_STAGE
    ) {
      this.stalled = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
    }
  }
}

const settings = controllerSettings();
const outcome = await runController(
  {
    settings,
    api: new JobsApi(settings.apiUrl, controllerToken(), settings.apiTimeoutMs),
    store: new TestJournalStore(settings.stateDir),
  },
  { jobId: process.env.TEST_JOB_ID, runRef: process.env.TEST_RUN_REF },
);
console.log(JSON.stringify(outcome));
