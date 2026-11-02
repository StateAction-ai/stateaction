import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { JobsApi } from "../src/api-client.js";
import type { ControllerSettings } from "../src/config.js";
import { runController } from "../src/controller.js";
import { JournalStore, type Journal } from "../src/journal.js";
import { bootId, readStat } from "../src/proc.js";
import { closeStubs, startStub } from "./stub-api.js";

const workerSrc = fileURLToPath(
  new URL("../../../workers/processing/src", import.meta.url),
);
let root = "";
let python = "";
before(() => {
  root = mkdtempSync(join(tmpdir(), "sa26-unit-"));
  // Stdlib-only worker: a wrapper puts the package on the path (no install, no venv).
  python = join(root, "python");
  writeFileSync(
    python,
    `#!/bin/sh\nPYTHONPATH='${workerSrc}' exec python3 "$@"\n`,
  );
  chmodSync(python, 0o700);
});
after(() => {
  closeStubs();
  rmSync(root, { recursive: true, force: true });
});

const settings = (apiUrl: string, hold: number): ControllerSettings => ({
  apiUrl,
  stateDir: join(root, "state"),
  python,
  renewIntervalMs: 500,
  pollIntervalMs: 100,
  leaseWaitMs: 0,
  reapGraceMs: 5000,
  apiTimeoutMs: 5000,
  pipeline: "local_fixture_noop",
  fixtureHoldSeconds: hold,
});
const workerProcesses = (ref: string) =>
  readdirSync("/proc")
    .filter((n) => /^\d+$/.test(n))
    .filter((n) => {
      try {
        return readFileSync(`/proc/${n}/cmdline`, "utf8").includes(ref);
      } catch {
        return false;
      }
    });

process.env.APP_ENV = "local";

describe("shared controller with real spawned children and a contract-shaped stub API", () => {
  test("fixed immutable deadline kills the verified group; evidence follows proof of an empty group", async () => {
    const jobId = randomUUID();
    const stub = await startStub({
      jobId,
      state: "submitting",
      submission: "recorded",
      executionDeadline: new Date(Date.now() + 4000),
    });
    const cfg = settings(stub.url, 120);
    const store = new JournalStore(cfg.stateDir);
    const api = new JobsApi(stub.url, "cap", 5000);
    const out = await runController(
      { settings: cfg, api, store },
      { jobId, runRef: "run-1" },
    );
    assert.equal(out.outcome, "child_exited");
    if (out.outcome !== "child_exited") return;
    assert.equal(out.evidence, "recorded");
    assert.equal(out.exit.signal, "SIGKILL");
    assert.equal(workerProcesses(out.executionRef).length, 0);
    const actions = stub.actions();
    assert.ok(
      actions.indexOf("record_worker_submission") <
        actions.indexOf("record_execution"),
    );
    assert.equal(actions.at(-1), "record_execution_evidence");
    const claimAt = stub.calls.findIndex((c) => c.path.endsWith("/claim"));
    assert.ok(
      claimAt >
        stub.calls.findIndex((c) => c.body?.action === "record_execution"),
    );
    // The bootstrap token never reaches the journal directory or the child log.
    const dir = store.dir(jobId);
    for (const name of readdirSync(dir))
      assert.ok(
        !readFileSync(join(dir, name), "utf8").includes(stub.token),
        name,
      );
    assert.ok(!readdirSync(dir).includes("bootstrap.token"));
    await stub.stop();
  });

  test("lost submission acknowledgement never spawns: the job is marked unknown and nothing is released", async () => {
    const jobId = randomUUID();
    const stub = await startStub({
      jobId,
      state: "submitting",
      submission: "already_recorded",
      executionDeadline: new Date(Date.now() + 60_000),
    });
    const cfg = settings(stub.url, 0);
    const out = await runController(
      {
        settings: cfg,
        api: new JobsApi(stub.url, "cap", 5000),
        store: new JournalStore(cfg.stateDir),
      },
      { jobId, runRef: "run-2" },
    );
    assert.deepEqual(out, {
      outcome: "submit_unknown",
      reason: "intent_recorded_without_token",
    });
    assert.ok(stub.actions().includes("mark_submit_unknown"));
    assert.ok(!stub.actions().includes("record_execution"));
    assert.ok(!stub.actions().includes("record_execution_evidence"));
    assert.ok(!stub.calls.some((c) => c.path.endsWith("/claim")));
    await stub.stop();
  });

  test("an uncertain spawn (journal at 'spawning', no pid) or a torn journal never spawns or records evidence", async () => {
    for (const mode of ["spawning", "torn"] as const) {
      const jobId = randomUUID();
      const stub = await startStub({
        jobId,
        state: "submitting",
        submission: "recorded",
        executionDeadline: new Date(Date.now() + 60_000),
      });
      const cfg = settings(stub.url, 30);
      const store = new JournalStore(cfg.stateDir);
      const ref = `local-${randomUUID()}`;
      const base: Journal = {
        version: 1,
        jobId,
        runRef: "run-3",
        executionRef: ref,
        phase: "spawning",
        bootId: bootId(),
        startDeadline: new Date(Date.now() + 60_000).toISOString(),
        executionDeadline: new Date(Date.now() + 60_000).toISOString(),
      };
      store.write(base);
      if (mode === "torn")
        writeFileSync(
          join(store.dir(jobId), "journal.json"),
          '{"version":1,"jobI',
        );
      const out = await runController(
        { settings: cfg, api: new JobsApi(stub.url, "cap", 5000), store },
        { jobId, runRef: "run-3" },
      );
      assert.equal(
        out.outcome === "needs_operator" || out.outcome === "submit_unknown",
        true,
        mode,
      );
      assert.equal(workerProcesses(ref).length, 0);
      assert.ok(!stub.actions().includes("record_execution_evidence"), mode);
      assert.ok(!stub.calls.some((c) => c.path.endsWith("/claim")), mode);
      await stub.stop();
    }
  });

  test("a restarted controller adopts the known running child by journal identity and never spawns another", async () => {
    const jobId = randomUUID();
    const stub = await startStub({
      jobId,
      state: "running",
      submission: "already_recorded",
      executionDeadline: new Date(Date.now() + 60_000),
    });
    const cfg = settings(stub.url, 3);
    const store = new JournalStore(cfg.stateDir);
    const ref = `local-${randomUUID()}`;
    // Simulate the first controller: spawn the real child, journal it, then "die".
    const { spawnChild } = await import("../src/local-process.js");
    store.ensure(jobId);
    const spawned = spawnChild(
      cfg,
      store,
      {
        version: 1,
        jobId,
        runRef: "run-4",
        executionRef: ref,
        phase: "spawning",
        bootId: bootId(),
        startDeadline: new Date(Date.now() + 60_000).toISOString(),
        executionDeadline: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        schemaVersion: 1,
        apiUrl: stub.url,
        jobId,
        bootstrapToken: stub.token,
        executionRef: ref,
        pipeline: "local_fixture_noop",
        fixtureHoldSeconds: 3,
      },
    );
    store.write(spawned.journal);
    const pid = spawned.journal.pid!;
    assert.ok(readStat(pid));
    const out = await runController(
      { settings: cfg, api: new JobsApi(stub.url, "cap", 5000), store },
      { jobId, runRef: "run-4" },
    );
    assert.equal(out.outcome, "child_exited");
    if (out.outcome === "child_exited") assert.equal(out.executionRef, ref);
    // Adoption did not run submission/execution/spawn again.
    assert.ok(!stub.actions().includes("record_worker_submission"));
    assert.ok(!stub.actions().includes("record_execution"));
    assert.equal(stub.calls.filter((c) => c.path.endsWith("/claim")).length, 1);
    assert.equal(workerProcesses(ref).length, 0);
    const evidence = stub.calls.find(
      (c) => c.body?.action === "record_execution_evidence",
    );
    assert.equal(
      (evidence!.body!.evidence as { detail: Record<string, string> }).detail
        .observation,
      "adopted_group_empty",
    );
    await stub.stop();
  });
});
