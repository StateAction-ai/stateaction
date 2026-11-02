import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { JobsApi } from "../src/api-client.js";
import type { ControllerSettings } from "../src/config.js";
import { runController } from "../src/controller.js";
import { JournalCorrupt, JournalStore, type Journal } from "../src/journal.js";
import { bootId } from "../src/proc.js";
import { closeStubs, startStub } from "./stub-api.js";

const root = mkdtempSync(join(tmpdir(), "sa26-journal-"));
after(() => {
  closeStubs();
  rmSync(root, { recursive: true, force: true });
});
const now = Date.now();
const valid = (jobId: string, patch: Record<string, unknown> = {}) => ({
  version: 1,
  jobId,
  runRef: "run-1",
  executionRef: `local-${randomUUID()}`,
  phase: "running",
  bootId: bootId(),
  startDeadline: new Date(now + 60_000).toISOString(),
  executionDeadline: new Date(now + 120_000).toISOString(),
  pid: 4242,
  pgid: 4242,
  sid: 4242,
  startTicks: "12345",
  ...patch,
});
const put = (store: JournalStore, jobId: string, value: unknown) => {
  store.ensure(jobId);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  writeFileSync(join(store.dir(jobId), "journal.json"), text, { mode: 0o600 });
  return text;
};

describe("strict versioned journal", () => {
  const store = new JournalStore(join(root, "state"));
  test("a complete record round-trips", () => {
    const jobId = randomUUID();
    const journal = valid(jobId) as unknown as Journal;
    store.write(journal);
    assert.deepEqual(store.read(jobId), journal);
  });
  const cases: Record<string, (jobId: string) => unknown> = {
    "unknown phase": (id) => valid(id, { phase: "adopted" }),
    "NaN deadline": (id) => valid(id, { executionDeadline: "not-a-time" }),
    "start after execution deadline": (id) =>
      valid(id, { startDeadline: new Date(now + 999_999).toISOString() }),
    "running without identity": (id) =>
      valid(id, { pid: undefined, pgid: undefined, sid: undefined }),
    "partial identity": (id) => valid(id, { sid: undefined }),
    "negative pid": (id) => valid(id, { pid: -1 }),
    "unsafe pid": (id) => valid(id, { pid: 2 ** 60 }),
    "bad start ticks": (id) => valid(id, { startTicks: "12 34" }),
    "exited without exit": (id) => valid(id, { phase: "exited" }),
    "spawning with a pid": (id) => valid(id, { phase: "spawning" }),
    "evidence flag before exit": (id) => valid(id, { evidenceRecorded: true }),
    "extra key": (id) => valid(id, { token: "x" }),
    "other job": () => valid(randomUUID()),
    "not an object": () => "[1]",
    torn: () => '{"version":1,"jobI',
  };
  for (const [name, make] of Object.entries(cases))
    test(`${name} is corruption and the original is preserved`, () => {
      const jobId = randomUUID();
      const original = put(store, jobId, make(jobId));
      assert.throws(() => store.read(jobId), JournalCorrupt);
      assert.equal(
        readFileSync(join(store.dir(jobId), "journal.json"), "utf8"),
        original,
      );
    });

  test("a valid-JSON journal with an unknown phase never records evidence or changes the file", async () => {
    const jobId = randomUUID();
    const stub = await startStub({
      jobId,
      state: "running",
      submission: "already_recorded",
      executionDeadline: new Date(now + 60_000),
    });
    const settings: ControllerSettings = {
      apiUrl: stub.url,
      stateDir: join(root, "state"),
      python: "/nonexistent",
      renewIntervalMs: 500,
      pollIntervalMs: 100,
      leaseWaitMs: 0,
      reapGraceMs: 1000,
      apiTimeoutMs: 5000,
      pipeline: "local_fixture_noop",
    };
    const original = put(store, jobId, valid(jobId, { phase: "mystery" }));
    const out = await runController(
      { settings, api: new JobsApi(stub.url, "cap", 5000), store },
      { jobId, runRef: "run-1" },
    );
    assert.equal(
      out.outcome === "needs_operator" || out.outcome === "submit_unknown",
      true,
    );
    assert.ok(!stub.actions().includes("record_execution_evidence"));
    assert.ok(!stub.actions().includes("record_worker_submission"));
    assert.equal(
      readFileSync(join(store.dir(jobId), "journal.json"), "utf8"),
      original,
    );
    await stub.stop();
  });
});
