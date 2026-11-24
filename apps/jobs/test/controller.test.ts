import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
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
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AmbiguousApiError, JobsApi } from "../src/api-client.js";
import type { LocalControllerSettings } from "../src/config.js";
import { runController } from "../src/controller.js";
import { JournalStore, type Journal } from "../src/journal.js";
import { inspect } from "../src/local-process.js";
import { bootId, liveMembers, readStat } from "../src/proc.js";
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

const settings = (apiUrl: string, hold: number): LocalControllerSettings => ({
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
  test("a session with an exited leader and live orphan members withholds proof and signals", async () => {
    const hold = join(root, randomUUID());
    writeFileSync(hold, "");
    const launcher = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
         spawn(process.execPath, ["-e",
           "const fs = require('node:fs'); const timer = setInterval(() => { if (!fs.existsSync(process.argv[1])) clearInterval(timer); }, 20); setTimeout(() => clearInterval(timer), 5000).unref();",
           process.argv[1],
         ], {
           stdio: "ignore",
         }).unref();`,
        hold,
      ],
      { detached: true, stdio: "ignore" },
    );
    try {
      assert.deepEqual(await once(launcher, "close"), [0, null]);
      const pid = launcher.pid!;
      assert.equal(readStat(pid), undefined);
      const deadline = new Date(Date.now() + 60_000).toISOString();
      const journal: Journal = {
        version: 1,
        jobId: randomUUID(),
        runRef: "run-orphan",
        executionRef: `local-${randomUUID()}`,
        phase: "running",
        bootId: bootId(),
        startDeadline: deadline,
        executionDeadline: deadline,
        pid,
        pgid: pid,
        sid: pid,
        startTicks: "0",
      };
      assert.deepEqual(inspect(journal), {
        kind: "unknown",
        reason: "execution_isolation_unproven",
      });
    } finally {
      rmSync(hold, { force: true });
      const pid = launcher.pid;
      if (pid !== undefined) {
        for (let i = 0; i < 100 && liveMembers(pid, pid).length > 0; i++)
          await delay(20);
        assert.equal(liveMembers(pid, pid).length, 0);
      }
    }
  });

  test("a live PID with newer start ticks cannot stand in for the recorded leader", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const closed = once(child, "close");
    try {
      await once(child, "spawn");
      const current = readStat(child.pid!);
      assert.ok(current);
      assert.equal(current.pid, current.session);
      assert.equal(current.pid, current.pgrp);
      const deadline = new Date(Date.now() + 60_000).toISOString();
      const journal: Journal = {
        version: 1,
        jobId: randomUUID(),
        runRef: "run-recycled-pid",
        executionRef: `local-${randomUUID()}`,
        phase: "running",
        bootId: bootId(),
        startDeadline: deadline,
        executionDeadline: deadline,
        pid: current.pid,
        pgid: current.pgrp,
        sid: current.session,
        startTicks: String(BigInt(current.startTicks) - 1n),
      };
      assert.deepEqual(inspect(journal), {
        kind: "unknown",
        reason: "leader_identity_changed",
      });
      assert.deepEqual(
        inspect({ ...journal, startTicks: current.startTicks }),
        {
          kind: "unknown",
          reason: "leader_identity_unconfirmed",
        },
      );
    } finally {
      child.stdin.end();
      await closed;
    }
  });

  test("an exited journal requires fixture isolation and a matching run to record evidence", async () => {
    const jobId = randomUUID();
    const runRef = "run-exited-without-isolation";
    const executionRef = `local-${randomUUID()}`;
    const deadline = new Date(Date.now() + 60_000);
    const stub = await startStub({
      jobId,
      state: "running",
      submission: "already_recorded",
      executionDeadline: deadline,
    });
    const cfg = settings(stub.url, 0);
    const store = new JournalStore(cfg.stateDir);
    try {
      const prior: Journal = {
        version: 1,
        jobId,
        runRef,
        executionRef,
        phase: "exited",
        bootId: bootId(),
        startDeadline: deadline.toISOString(),
        executionDeadline: deadline.toISOString(),
        pid: 4242,
        pgid: 4242,
        sid: 4242,
        startTicks: "1",
        exit: { code: 0, signal: null },
      };
      const api = new JobsApi(stub.url, "cap", 5000);
      for (const [journal, reason] of [
        [prior, "execution_isolation_unproven"],
        [
          { ...prior, singleProcess: true, runRef: "another-run" },
          "journal_run_mismatch",
        ],
      ] as const) {
        store.write(journal);
        assert.deepEqual(
          await runController({ settings: cfg, api, store }, { jobId, runRef }),
          { outcome: "needs_operator", reason, executionRef },
        );
      }
      assert.ok(!stub.actions().includes("record_execution_evidence"));
    } finally {
      await stub.stop();
    }
  });

  test("fixed immutable deadline kills the verified group; evidence follows proof of an empty group", async () => {
    const jobId = randomUUID();
    const stub = await startStub({
      jobId,
      state: "submitting",
      submission: "recorded",
      executionDeadline: new Date(Date.now() + 4000),
      // Let the controller enforce its deadline before the worker can exit on its own.
      workerExecutionDeadline: new Date(Date.now() + 60_000),
    });
    const cfg = settings(stub.url, 120);
    const store = new JournalStore(cfg.stateDir);
    const api = new JobsApi(stub.url, "cap", 5000);
    const act = api.act.bind(api);
    let evidencePending = false;
    let observeRenewal!: () => void;
    const renewedAfterEvidence = new Promise<void>((resolve) => {
      observeRenewal = resolve;
    });
    api.act = async (id, action) => {
      const renewingAfterEvidence =
        action.action === "renew_lease" && evidencePending;
      if (action.action === "record_execution_evidence") {
        assert.equal(workerProcesses(action.evidence.executionRef).length, 0);
      }
      const result = await act(id, action);
      if (action.action === "record_execution_evidence") {
        // Keep the evidence acknowledgement in flight across one renewal.
        evidencePending = true;
        await renewedAfterEvidence;
      } else if (renewingAfterEvidence) {
        observeRenewal();
      }
      return result;
    };
    const out = await runController(
      { settings: cfg, api, store },
      { jobId, runRef: "run-1" },
    );
    assert.equal(out.outcome, "child_exited", JSON.stringify(out));
    if (out.outcome !== "child_exited") return;
    assert.equal(out.evidence, "recorded");
    assert.equal(out.exit.signal, "SIGKILL");
    assert.equal(workerProcesses(out.executionRef).length, 0);
    const actions = stub.actions();
    assert.ok(
      actions.indexOf("record_worker_submission") <
        actions.indexOf("record_execution"),
    );
    const evidence = stub.calls.filter(
      (c) => c.body?.action === "record_execution_evidence",
    );
    assert.equal(evidence.length, 1);
    assert.equal(actions.at(-1), "renew_lease");
    assert.equal(
      actions.filter((action) => action !== "renew_lease").at(-1),
      "record_execution_evidence",
    );
    assert.partialDeepStrictEqual(evidence[0]?.body, {
      evidence: { detail: { termination: "execution_deadline" } },
    });
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

  test("lease expiry during a cancellation status poll leaves the child and journal for takeover", async () => {
    const jobId = randomUUID();
    const runRef = "run-lease-expiry";
    const executionRef = `local-${randomUUID()}`;
    const deadline = new Date(Date.now() + 60_000);
    const stub = await startStub({
      jobId,
      state: "running",
      submission: "already_recorded",
      executionDeadline: deadline,
    });
    const child = spawn(
      process.execPath,
      ["-e", "process.stdin.resume()", executionRef],
      { detached: true, stdio: ["pipe", "ignore", "ignore"] },
    );
    const closed = once(child, "close");
    let leaseExpiresAt = 0;
    let renewals = 0;
    let polls = 0;
    class ExpiringApi extends JobsApi {
      override async act(...args: Parameters<JobsApi["act"]>) {
        if (args[1].action === "renew_lease") {
          renewals++;
          throw new AmbiguousApiError("No renewal acknowledgement");
        }
        const result = await super.act(...args);
        if (!("granted" in result) || !result.granted) return result;
        leaseExpiresAt = Date.now() + 600;
        return { ...result, expiresAt: new Date(leaseExpiresAt).toISOString() };
      }

      override async status(id: string) {
        const result = await super.status(id);
        if (++polls === 1) return result;
        await delay(Math.max(0, leaseExpiresAt - Date.now()) + 20);
        return { ...result, state: "cancel_requested" };
      }
    }
    try {
      await once(child, "spawn");
      const stat = readStat(child.pid!);
      assert.ok(stat);
      const cfg = settings(stub.url, 0);
      const store = new JournalStore(cfg.stateDir);
      const journal: Journal = {
        version: 1,
        jobId,
        runRef,
        executionRef,
        phase: "running",
        bootId: bootId(),
        startDeadline: deadline.toISOString(),
        executionDeadline: deadline.toISOString(),
        pid: stat.pid,
        pgid: stat.pgrp,
        sid: stat.session,
        startTicks: stat.startTicks,
        singleProcess: true,
      };
      store.write(journal);
      const api = new ExpiringApi(stub.url, "cap", 5000);
      assert.deepEqual(
        await runController({ settings: cfg, api, store }, { jobId, runRef }),
        { outcome: "lease_lost", executionRef },
      );
      assert.equal(polls, 2);
      assert.equal(renewals, 1);
      assert.equal(inspect(journal).kind, "alive");
      assert.deepEqual(store.read(jobId), journal);
      assert.ok(!stub.actions().includes("record_execution_evidence"));
    } finally {
      child.stdin.end();
      await closed;
      await stub.stop();
    }
  });

  test("a previous boot's intent cannot launch a child", async () => {
    const jobId = randomUUID();
    const runRef = "run-previous-boot";
    const executionRef = `local-${randomUUID()}`;
    const deadline = new Date(Date.now() + 60_000);
    const stub = await startStub({
      jobId,
      state: "submitting",
      submission: "already_recorded",
      executionDeadline: deadline,
    });
    const cfg = settings(stub.url, 0);
    const store = new JournalStore(cfg.stateDir);
    const journal: Journal = {
      version: 1,
      jobId,
      runRef,
      executionRef,
      phase: "intent",
      bootId: randomUUID(),
      startDeadline: deadline.toISOString(),
      executionDeadline: deadline.toISOString(),
    };
    try {
      store.saveToken(jobId, stub.token);
      store.write(journal);
      const api = new JobsApi(stub.url, "cap", 5000);
      assert.deepEqual(
        await runController({ settings: cfg, api, store }, { jobId, runRef }),
        { outcome: "needs_operator", reason: "boot_changed", executionRef },
      );
      assert.deepEqual(store.read(jobId), journal);
      assert.ok(stub.actions().includes("mark_submit_unknown"));
      assert.ok(!stub.actions().includes("record_execution"));
      assert.ok(!stub.actions().includes("record_execution_evidence"));
      assert.ok(!stub.calls.some((c) => c.path.endsWith("/claim")));
    } finally {
      await stub.stop();
    }
  });

  test("a missing worker executable rejects cleanly and prevents another spawn", async () => {
    const jobId = randomUUID();
    const runRef = "run-missing-executable";
    const stub = await startStub({
      jobId,
      state: "submitting",
      submission: "recorded",
      executionDeadline: new Date(Date.now() + 60_000),
    });
    const cfg = {
      ...settings(stub.url, 0),
      python: join(root, "missing-python"),
    };
    const store = new JournalStore(cfg.stateDir);
    const api = new JobsApi(stub.url, "cap", 5000);
    try {
      const run = () =>
        runController({ settings: cfg, api, store }, { jobId, runRef });
      await assert.rejects(run(), /Local child failed to start/);
      const journal = store.read(jobId);
      assert.equal(journal?.phase, "spawning");
      assert.deepEqual(await run(), {
        outcome: "needs_operator",
        reason: "spawn_outcome_uncertain",
        executionRef: journal?.executionRef,
      });
      assert.ok(!stub.actions().includes("record_execution_evidence"));
      assert.ok(!stub.calls.some((c) => c.path.endsWith("/claim")));
    } finally {
      await stub.stop();
    }
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

  test("same-run takeover consumes the spawn reservation before a stale controller can spawn or replace its journal", async () => {
    const jobId = randomUUID();
    const deadline = new Date(Date.now() + 60_000);
    const stub = await startStub({
      jobId,
      state: "submitting",
      submission: "already_recorded",
      executionDeadline: deadline,
    });
    const cfg = settings(stub.url, 30);
    const successor = new JournalStore(cfg.stateDir);
    const prior: Journal = {
      version: 1,
      jobId,
      runRef: "run-takeover",
      executionRef: `local-${randomUUID()}`,
      phase: "execution_recorded",
      bootId: bootId(),
      startDeadline: deadline.toISOString(),
      executionDeadline: deadline.toISOString(),
    };
    const successorJournal: Journal = {
      ...prior,
      phase: "running",
      pid: 4242,
      pgid: 4242,
      sid: 4242,
      startTicks: "12345",
    };
    class StaleStore extends JournalStore {
      override loadToken(id: string): string | undefined {
        const token = super.loadToken(id);
        assert.ok(token);
        assert.equal(successor.reserveSpawn(id), true);
        successor.write(successorJournal);
        return token;
      }
    }
    successor.write(prior);
    successor.saveToken(jobId, stub.token);
    try {
      const out = await runController(
        {
          settings: cfg,
          api: new JobsApi(stub.url, "cap", 5000),
          store: new StaleStore(cfg.stateDir),
        },
        { jobId, runRef: prior.runRef },
      );
      assert.deepEqual(out, {
        outcome: "needs_operator",
        reason: "spawn_already_reserved",
        executionRef: prior.executionRef,
      });
      assert.deepEqual(successor.read(jobId), successorJournal);
      assert.equal(successor.reserveSpawn(jobId), false);
      assert.equal(workerProcesses(prior.executionRef).length, 0);
      assert.ok(!stub.actions().includes("record_execution_evidence"));
      assert.ok(!stub.calls.some((c) => c.path.endsWith("/claim")));
    } finally {
      await stub.stop();
    }
  });

  test("a crash after reserving a spawn but before updating the journal fails closed", async () => {
    const jobId = randomUUID();
    const deadline = new Date(Date.now() + 60_000);
    const stub = await startStub({
      jobId,
      state: "submitting",
      submission: "already_recorded",
      executionDeadline: deadline,
    });
    const cfg = settings(stub.url, 30);
    const store = new JournalStore(cfg.stateDir);
    const prior: Journal = {
      version: 1,
      jobId,
      runRef: "run-crash",
      executionRef: `local-${randomUUID()}`,
      phase: "execution_recorded",
      bootId: bootId(),
      startDeadline: deadline.toISOString(),
      executionDeadline: deadline.toISOString(),
    };
    store.write(prior);
    store.saveToken(jobId, stub.token);
    assert.equal(store.reserveSpawn(jobId), true);
    try {
      const out = await runController(
        { settings: cfg, api: new JobsApi(stub.url, "cap", 5000), store },
        { jobId, runRef: prior.runRef },
      );
      assert.deepEqual(out, {
        outcome: "needs_operator",
        reason: "spawn_already_reserved",
        executionRef: prior.executionRef,
      });
      assert.deepEqual(store.read(jobId), prior);
      assert.ok(!stub.actions().includes("record_execution_evidence"));
      assert.ok(!stub.calls.some((c) => c.path.endsWith("/claim")));
    } finally {
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
    const spawned = await spawnChild(cfg, store, {
      version: 1,
      jobId,
      runRef: "run-4",
      executionRef: ref,
      phase: "spawning",
      bootId: bootId(),
      startDeadline: new Date(Date.now() + 60_000).toISOString(),
      executionDeadline: new Date(Date.now() + 60_000).toISOString(),
    });
    store.write(spawned.journal);
    assert.equal(spawned.journal.singleProcess, true);
    assert.ok(!stub.calls.some((c) => c.path.endsWith("/claim")));
    spawned.provideBootstrap({
      schemaVersion: 1,
      apiUrl: stub.url,
      jobId,
      bootstrapToken: stub.token,
      executionRef: ref,
      pipeline: "local_fixture_noop",
      fixtureHoldSeconds: 3,
    });
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
      "adopted_single_process_exited",
    );
    await stub.stop();
  });
});
