import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { JobsApi } from "../src/api-client.js";
import type {
  LocalControllerSettings,
  ModalControllerSettings,
} from "../src/config.js";
import { runController } from "../src/controller.js";
import { JournalStore, type ModalJournal } from "../src/journal.js";
import type {
  CallObservation,
  ModalBootstrap,
  ModalClient,
} from "../src/modal-executor.js";
import { closeStubs, startStub } from "./stub-api.js";

let root = "";
before(() => {
  root = mkdtempSync(join(tmpdir(), "sa42-unit-"));
});
after(() => {
  closeStubs();
  rmSync(root, { recursive: true, force: true });
});

const callId = () => `fc-${randomBytes(10).toString("hex")}`;
const settings = (apiUrl: string, graceMs = 400): ModalControllerSettings => ({
  executor: "modal",
  apiUrl,
  stateDir: join(root, `state-${randomUUID()}`),
  renewIntervalMs: 100,
  pollIntervalMs: 20,
  leaseWaitMs: 0,
  reapGraceMs: graceMs,
  apiTimeoutMs: 5000,
  appName: "stateaction-processing",
  functionName: "process_recording",
  pipeline: "hand_pose_cpu_v1",
});
const done = (id: string, exitCode = 0) => ({
  schemaVersion: 1,
  functionCallId: id,
  exitCode,
});
const returned = (value: unknown): CallObservation => ({
  kind: "returned",
  value,
});
const pending: CallObservation = { kind: "pending", detail: "poll_timeout" };

/** A fake Modal that records every spawn/cancel; behavior is injected per test. */
class FakeModal implements ModalClient {
  spawns: ModalBootstrap[] = [];
  cancels: string[] = [];
  polls = 0;
  constructor(
    private readonly impl: {
      spawn?: (b: ModalBootstrap) => Promise<string>;
      poll?: (
        id: string,
        n: number,
      ) => CallObservation | Promise<CallObservation>;
      cancel?: (id: string) => Promise<void>;
    } = {},
  ) {}
  async spawn(b: ModalBootstrap): Promise<string> {
    this.spawns.push(b);
    return (this.impl.spawn ?? (async () => callId()))(b);
  }
  async poll(id: string): Promise<CallObservation> {
    this.polls++;
    return await (
      this.impl.poll ?? ((i: string, _n: number) => returned(done(i)))
    )(id, this.polls);
  }
  async cancel(id: string): Promise<void> {
    this.cancels.push(id);
    await this.impl.cancel?.(id);
  }
}

const start = async (
  over: Partial<Parameters<typeof startStub>[0]> = {},
  deadlineMs = 60_000,
) =>
  startStub({
    jobId: randomUUID(),
    state: "submitting",
    submission: "recorded",
    statusBackend: "modal",
    // The contract carries whole seconds: use a whole-second instant at least `deadlineMs` ahead.
    executionDeadline: new Date(
      Math.ceil((Date.now() + deadlineMs) / 1000) * 1000,
    ),
    ...over,
  });
type Stub = Awaited<ReturnType<typeof start>>;
const api = (stub: Stub) => new JobsApi(stub.url, "cap", 5000);
let n = 0;
const enter = (
  stub: Stub,
  jobId: string,
  cfg: ModalControllerSettings,
  modal: ModalClient,
  events?: string[],
) =>
  runController(
    {
      settings: cfg,
      api: api(stub),
      store: new JournalStore(cfg.stateDir),
      modal,
      onEvent: (e) => events?.push(e),
    },
    { jobId, runRef: `run-${++n}` },
  );
const evidence = (stub: Stub) =>
  stub.calls.filter((c) => c.body?.action === "record_execution_evidence");
const claim = async (stub: Stub, jobId: string, id: string) =>
  fetch(`${stub.url}/internal/v1/jobs/${jobId}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      jobId,
      invocationNonce: randomBytes(32).toString("base64url"),
      executor: { kind: "modal", functionCallId: id },
    }),
  });
const seed = (
  store: JournalStore,
  jobId: string,
  over: Partial<ModalJournal> = {},
) => {
  const j: ModalJournal = {
    version: 1,
    executor: "modal",
    jobId,
    runRef: "run-0",
    phase: "spawning",
    startDeadline: new Date(Date.now() + 60_000).toISOString(),
    executionDeadline: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  };
  store.writeModal(j);
  return j;
};

// renew_lease is an independent heartbeat on its own timer: its request may reach the stub after
// the evidence request. The invariant is that evidence is recorded exactly once, after the
// execution record, and that nothing but heartbeats follows it.
function assertEvidenceIsTheLastStateChange(actions: string[]): void {
  const evidence = actions
    .map((a, i) => (a === "record_execution_evidence" ? i : -1))
    .filter((i) => i >= 0);
  assert.equal(
    evidence.length,
    1,
    `evidence recorded ${evidence.length} times`,
  );
  const at = evidence[0]!;
  const execution = actions.indexOf("record_execution");
  assert.ok(
    execution >= 0 && execution < at,
    "evidence must follow record_execution",
  );
  assert.deepEqual(
    actions.slice(at + 1).filter((a) => a !== "renew_lease"),
    [],
    "only lease renewals may follow the evidence",
  );
}

describe("evidence ordering assertion (negative checks)", () => {
  test("accepts late heartbeats after the evidence", () => {
    assertEvidenceIsTheLastStateChange([
      "record_worker_submission",
      "record_execution",
      "renew_lease",
      "record_execution_evidence",
      "renew_lease",
    ]);
  });
  test("fails when evidence is missing, duplicated, early or followed by another action", () => {
    for (const bad of [
      ["record_execution"],
      [
        "record_execution",
        "record_execution_evidence",
        "record_execution_evidence",
      ],
      ["record_execution_evidence", "record_execution"],
      [
        "record_execution",
        "record_execution_evidence",
        "record_worker_submission",
      ],
      [
        "record_execution",
        "record_execution_evidence",
        "renew_lease",
        "release",
      ],
    ])
      assert.throws(
        () => assertEvidenceIsTheLastStateChange(bad),
        bad.join(","),
      );
  });
});

describe("Modal executor in the shared controller (fake Modal, contract-shaped stub API)", () => {
  test("exactly one spawn: intent and journal precede it, the call ID is recorded after it, evidence is provider_call_terminal", async () => {
    const jobId = randomUUID();
    const stub = await start({ jobId });
    const cfg = settings(stub.url);
    const store = new JournalStore(cfg.stateDir);
    let atSpawn:
      | { actions: string[]; phase?: string; call?: string }
      | undefined;
    const id = callId();
    const modal = new FakeModal({
      spawn: async () => {
        const j = store.readModal(jobId);
        atSpawn = { actions: stub.actions(), phase: j?.phase, call: j?.callId };
        return id;
      },
      poll: (i, k) => (k < 3 ? pending : returned(done(i, 0))),
    });
    const out = await enter(stub, jobId, cfg, modal);
    assert.equal(modal.spawns.length, 1);
    assert.deepEqual(
      atSpawn?.actions.includes("record_worker_submission"),
      true,
    );
    assert.equal(atSpawn?.actions.includes("record_execution"), false);
    // The journal said "spawning" (no call ID) BEFORE the effect.
    assert.equal(atSpawn?.phase, "spawning");
    assert.equal(atSpawn?.call, undefined);
    assert.equal(out.outcome, "call_terminal");
    if (out.outcome !== "call_terminal") return;
    assert.equal(out.executionRef, id);
    assert.equal(out.evidence, "recorded");
    const recorded = stub.calls.find(
      (c) => c.body?.action === "record_execution",
    );
    assert.deepEqual(recorded?.body?.executor, {
      kind: "modal",
      functionCallId: id,
    });
    const ev = evidence(stub);
    assert.equal(ev.length, 1);
    const e = ev[0]!.body!.evidence as {
      kind: string;
      executionRef: string;
      detail: Record<string, string>;
    };
    assert.equal(e.kind, "provider_call_terminal");
    assert.equal(e.executionRef, id);
    assert.equal(e.detail.recovery, "spawned_by_this_run");
    assertEvidenceIsTheLastStateChange(stub.actions());
    assert.equal(store.readModal(jobId)?.phase, "terminal");
    // The spawn argument carries only the scoped bootstrap (no executionRef: Modal supplies the call ID).
    const boot = modal.spawns[0]!;
    assert.equal(boot.bootstrapToken, stub.token);
    assert.equal(boot.pipeline, "hand_pose_cpu_v1");
    assert.ok(!("executionRef" in boot));
    // The token is neither in the journal directory nor left on disk.
    const dir = store.dir(jobId);
    for (const name of readdirSync(dir))
      assert.ok(
        !readFileSync(join(dir, name), "utf8").includes(stub.token),
        name,
      );
    assert.ok(!existsSync(join(dir, "bootstrap.token")));
    await stub.stop();
  });

  test("a lost spawn acknowledgement stays uncertain: one spawn, never a second, never evidence", async () => {
    const jobId = randomUUID();
    const stub = await start({ jobId });
    const cfg = settings(stub.url);
    const modal = new FakeModal({
      spawn: async () => {
        throw new Error("connection reset after the request was sent");
      },
    });
    const first = await enter(stub, jobId, cfg, modal);
    assert.deepEqual(first, {
      outcome: "submit_unknown",
      reason: "spawn_outcome_uncertain",
    });
    assert.ok(stub.actions().includes("mark_submit_unknown"));
    assert.equal(
      new JournalStore(cfg.stateDir).readModal(jobId)?.phase,
      "spawning",
    );
    // A controller retry (new task entry, same journal) must not spawn again.
    stub.setState("submit_unknown");
    const again = await enter(stub, jobId, cfg, modal);
    assert.equal(again.outcome, "submit_unknown");
    assert.equal(modal.spawns.length, 1);
    assert.equal(evidence(stub).length, 0);
    assert.equal(
      stub.actions().filter((a) => a === "record_worker_submission").length,
      1,
    );
    await stub.stop();
  });

  test("a crash after reserving a spawn leaves the intent fenced", async () => {
    const jobId = randomUUID();
    const stub = await start({ jobId });
    const cfg = settings(stub.url);
    const store = new JournalStore(cfg.stateDir);
    seed(store, jobId, { phase: "intent" });
    store.saveToken(jobId, stub.token);
    assert.ok(store.reserveSpawn(jobId));
    const modal = new FakeModal();

    assert.deepEqual(await enter(stub, jobId, cfg, modal), {
      outcome: "submit_unknown",
      reason: "spawn_outcome_uncertain",
    });
    assert.equal(modal.spawns.length, 0);
    assert.equal(evidence(stub).length, 0);
    await stub.stop();
  });

  test("a crash between the 'spawning' journal and the call ID (no ID anywhere) never spawns or records evidence", async () => {
    const jobId = randomUUID();
    const stub = await start({ jobId });
    const cfg = settings(stub.url);
    const store = new JournalStore(cfg.stateDir);
    seed(store, jobId, { phase: "spawning" });
    const modal = new FakeModal();
    const out = await enter(stub, jobId, cfg, modal);
    assert.equal(out.outcome, "submit_unknown");
    assert.equal(modal.spawns.length, 0);
    assert.equal(modal.polls, 0);
    assert.equal(evidence(stub).length, 0);
    await stub.stop();
  });

  test("a 'spawning' journal whose call the worker already reported is ADOPTED (no second spawn)", async () => {
    const jobId = randomUUID();
    const id = callId();
    const stub = await start({
      jobId,
      state: "running",
      initialExecutionRef: id,
    });
    const cfg = settings(stub.url);
    const store = new JournalStore(cfg.stateDir);
    seed(store, jobId, { phase: "spawning" });
    const modal = new FakeModal();
    const out = await enter(stub, jobId, cfg, modal);
    assert.equal(out.outcome, "call_terminal");
    assert.equal(modal.spawns.length, 0);
    assert.equal(evidence(stub).length, 1);
    await stub.stop();
  });

  test("a known call ID in the journal is resumed on controller retry (no submission, no spawn)", async () => {
    const jobId = randomUUID();
    const id = callId();
    const stub = await start({ jobId, state: "running" });
    const cfg = settings(stub.url);
    const store = new JournalStore(cfg.stateDir);
    seed(store, jobId, { phase: "submitted", callId: id });
    const modal = new FakeModal({
      poll: (i, k) => (k < 3 ? pending : returned(done(i))),
    });
    const out = await enter(stub, jobId, cfg, modal);
    assert.equal(out.outcome, "call_terminal");
    assert.equal(modal.spawns.length, 0);
    assert.ok(!stub.actions().includes("record_worker_submission"));
    // The ID is (re)recorded because the previous run never acknowledged it.
    assert.ok(stub.actions().includes("record_execution"));
    const e = evidence(stub)[0]!.body!.evidence as {
      detail: Record<string, string>;
    };
    assert.equal(e.detail.recovery, "adopted_from_journal");
    await stub.stop();
  });

  test("a controller on ANOTHER instance (no journal) adopts the call the server already holds", async () => {
    const jobId = randomUUID();
    const id = callId();
    const stub = await start({
      jobId,
      state: "running",
      initialExecutionRef: id,
    });
    const cfg = settings(stub.url);
    const modal = new FakeModal({
      poll: (i, k) => (k < 2 ? pending : returned(done(i))),
    });
    const out = await enter(stub, jobId, cfg, modal);
    assert.equal(out.outcome, "call_terminal");
    assert.equal(modal.spawns.length, 0);
    assert.ok(!stub.actions().includes("record_worker_submission"));
    assert.equal(evidence(stub).length, 1);
    // The server's immutable deadline travelled with the identity.
    const j = new JournalStore(cfg.stateDir).readModal(jobId);
    assert.equal(j?.callId, id);
    assert.ok(j?.executionDeadline);
    await stub.stop();
  });

  test("no journal and no recorded call outside 'submitting' needs the operator and never spawns", async () => {
    const jobId = randomUUID();
    const stub = await start({ jobId, state: "running" });
    const cfg = settings(stub.url);
    const modal = new FakeModal();
    const out = await enter(stub, jobId, cfg, modal);
    assert.deepEqual(out, {
      outcome: "needs_operator",
      reason: "no_local_journal",
    });
    assert.equal(modal.spawns.length, 0);
    assert.equal(evidence(stub).length, 0);
    await stub.stop();
  });

  test("claim-before-record: the worker claim sets the same ID first; record_execution is idempotent", async () => {
    const jobId = randomUUID();
    const stub = await start({ jobId });
    const cfg = settings(stub.url);
    const id = callId();
    const modal = new FakeModal({
      spawn: async () => {
        // The container's worker wins its claim before the controller has recorded anything.
        const r = await claim(stub, jobId, id);
        assert.equal(r.status, 200);
        return id;
      },
    });
    const out = await enter(stub, jobId, cfg, modal);
    assert.equal(out.outcome, "call_terminal");
    assert.equal(stub.executionRef(), id);
    assert.equal(modal.spawns.length, 1);
    assert.equal(evidence(stub).length, 1);
    await stub.stop();
  });

  test("record-before-claim: the worker claim after the controller record carries the identical ID", async () => {
    const jobId = randomUUID();
    const stub = await start({ jobId });
    const cfg = settings(stub.url);
    const id = callId();
    let claimed: number | undefined;
    const modal = new FakeModal({
      spawn: async () => id,
      poll: async (i, k) => {
        if (k === 2) claimed = (await claim(stub, jobId, id)).status;
        return k < 4 ? pending : returned(done(i));
      },
    });
    const out = await enter(stub, jobId, cfg, modal);
    assert.equal(out.outcome, "call_terminal");
    assert.equal(claimed, 200);
    assert.equal(stub.executionRef(), id);
    await stub.stop();
  });

  test("mismatched IDs: a different server-recorded ID, a rejected record, or a malformed ID never produce evidence", async () => {
    // (a) journal says A, the server says B.
    {
      const jobId = randomUUID();
      const a = callId();
      const stub = await start({
        jobId,
        state: "running",
        initialExecutionRef: callId(),
      });
      const cfg = settings(stub.url);
      seed(new JournalStore(cfg.stateDir), jobId, {
        phase: "submitted",
        callId: a,
      });
      const modal = new FakeModal();
      const out = await enter(stub, jobId, cfg, modal);
      assert.deepEqual(out, {
        outcome: "needs_operator",
        reason: "execution_ref_mismatch",
        executionRef: a,
      });
      assert.equal(modal.polls, 0);
      assert.equal(evidence(stub).length, 0);
      await stub.stop();
    }
    // (b) the worker claimed with another ID than the spawn returned: the server refuses record_execution.
    {
      const jobId = randomUUID();
      const stub = await start({ jobId });
      const cfg = settings(stub.url);
      const modal = new FakeModal({
        spawn: async () => {
          await claim(stub, jobId, "fc-Wrong");
          return callId();
        },
      });
      const out = await enter(stub, jobId, cfg, modal);
      assert.equal(out.outcome, "needs_operator");
      if (out.outcome === "needs_operator")
        assert.equal(out.reason, "execution_ref_conflict");
      assert.equal(evidence(stub).length, 0);
      await stub.stop();
    }
    // (c) a spawn that returns a malformed ID is uncertain, not recorded.
    {
      const jobId = randomUUID();
      const stub = await start({ jobId });
      const cfg = settings(stub.url);
      const modal = new FakeModal({ spawn: async () => "not-an-fc-id" });
      const out = await enter(stub, jobId, cfg, modal);
      assert.equal(out.outcome, "submit_unknown");
      assert.ok(!stub.actions().includes("record_execution"));
      await stub.stop();
    }
  });

  test("only a structured result for THIS call is terminal: failures, timeouts, foreign or malformed values keep it uncertain", async () => {
    const cases: [string, (id: string) => CallObservation][] = [
      ["poll timeout (pending)", () => pending],
      [
        "function timeout",
        () => ({ kind: "unavailable", detail: "function_timeout" }),
      ],
      [
        "remote error / cancelled",
        () => ({ kind: "unavailable", detail: "RemoteError" }),
      ],
      [
        "internal failure",
        () => ({ kind: "unavailable", detail: "InternalFailure" }),
      ],
      ["another call's result", () => returned(done(callId()))],
      ["extra key", (i) => returned({ ...done(i), reason: "ok" })],
      ["string exit code", (i) => returned({ ...done(i), exitCode: "0" })],
      ["bare value", () => returned("done")],
    ];
    for (const [name, obs] of cases) {
      const jobId = randomUUID();
      const stub = await start({ jobId }, 400);
      const cfg = settings(stub.url, 150);
      const modal = new FakeModal({ poll: (i) => obs(i) });
      const out = await enter(stub, jobId, cfg, modal);
      assert.equal(out.outcome, "needs_operator", name);
      if (out.outcome === "needs_operator")
        assert.equal(
          out.reason,
          "call_not_provably_terminal_after_cancel",
          name,
        );
      assert.equal(evidence(stub).length, 0, name);
      // Our own deadline led to a cancel REQUEST; the slot stays held (no evidence).
      assert.equal(modal.cancels.length, 1, name);
      await stub.stop();
    }
  });

  test("a non-zero worker exit (e.g. lost claim 75) is still an observed terminal call and is recorded as such", async () => {
    const jobId = randomUUID();
    const stub = await start({ jobId });
    const cfg = settings(stub.url);
    const modal = new FakeModal({ poll: (i) => returned(done(i, 75)) });
    const out = await enter(stub, jobId, cfg, modal);
    assert.equal(out.outcome, "call_terminal");
    const e = evidence(stub)[0]!.body!.evidence as {
      detail: Record<string, string>;
    };
    assert.equal(e.detail.exitCode, "75");
    await stub.stop();
  });

  test("cancel while pending: a request is sent once with the call ID, and without an observed result it is NOT termination", async () => {
    const jobId = randomUUID();
    const id = callId();
    const stub = await start({ jobId, state: "cancel_requested" });
    const cfg = settings(stub.url, 200);
    seed(new JournalStore(cfg.stateDir), jobId, {
      phase: "submitted",
      callId: id,
    });
    const modal = new FakeModal({ poll: () => pending });
    const out = await enter(stub, jobId, cfg, modal);
    assert.deepEqual(out, {
      outcome: "needs_operator",
      reason: "call_not_provably_terminal_after_cancel",
      executionRef: id,
    });
    assert.deepEqual(modal.cancels, [id]);
    assert.equal(evidence(stub).length, 0);
    const j = new JournalStore(cfg.stateDir).readModal(jobId);
    assert.ok(j?.cancelRequestedAt);
    assert.equal(j?.phase, "submitted");
    await stub.stop();
  });

  test("cancel then an observed terminal result records provider_call_terminal with the cancel provenance", async () => {
    const jobId = randomUUID();
    const id = callId();
    const stub = await start({ jobId, state: "cancel_requested" });
    const cfg = settings(stub.url, 2000);
    seed(new JournalStore(cfg.stateDir), jobId, {
      phase: "submitted",
      callId: id,
    });
    const modal: FakeModal = new FakeModal({
      // Terminal only AFTER the cancel request has been issued.
      poll: (i) => (modal.cancels.length ? returned(done(i, -9)) : pending),
    });
    const out = await enter(stub, jobId, cfg, modal);
    assert.equal(out.outcome, "call_terminal");
    assert.deepEqual(modal.cancels, [id]);
    const e = evidence(stub)[0]!.body!.evidence as {
      detail: Record<string, string>;
    };
    assert.equal(e.detail.termination, "cancel_requested");
    assert.equal(e.detail.exitCode, "-9");
    await stub.stop();
  });

  test("the immutable execution deadline requests a cancel; no result means needs_operator with the slot held", async () => {
    const jobId = randomUUID();
    const stub = await start({ jobId }, 900);
    const cfg = settings(stub.url, 200);
    const id = callId();
    const modal = new FakeModal({
      spawn: async () => {
        await claim(stub, jobId, id); // the worker is running, so the start deadline no longer applies
        return id;
      },
      poll: () => pending,
    });
    const out = await enter(stub, jobId, cfg, modal);
    assert.equal(out.outcome, "needs_operator");
    assert.deepEqual(modal.cancels, [id]);
    assert.equal(evidence(stub).length, 0);
    const j = new JournalStore(cfg.stateDir).readModal(jobId);
    assert.equal(j?.termination, "execution_deadline");
    assert.ok(j?.cancelRequestedAt);
    await stub.stop();
  });

  test("the admitted backend is authoritative: a local-admitted job never spawns on Modal", async () => {
    const jobId = randomUUID();
    const stub = await start({ jobId, statusBackend: "local" });
    const cfg = settings(stub.url);
    const modal = new FakeModal();
    const out = await enter(stub, jobId, cfg, modal);
    assert.deepEqual(out, {
      outcome: "needs_operator",
      reason: "backend_mismatch",
    });
    assert.equal(modal.spawns.length, 0);
    assert.ok(!stub.actions().includes("record_worker_submission"));
    await stub.stop();
  });

  test("a lost submission acknowledgement never spawns", async () => {
    const jobId = randomUUID();
    const stub = await start({ jobId, submission: "already_recorded" });
    const cfg = settings(stub.url);
    const modal = new FakeModal();
    const out = await enter(stub, jobId, cfg, modal);
    assert.deepEqual(out, {
      outcome: "submit_unknown",
      reason: "intent_recorded_without_token",
    });
    assert.equal(modal.spawns.length, 0);
    await stub.stop();
  });

  test("a local journal for the same job is never guessed around by the Modal controller", async () => {
    const jobId = randomUUID();
    const stub = await start({ jobId, state: "running" });
    const cfg = settings(stub.url);
    const store = new JournalStore(cfg.stateDir);
    store.ensure(jobId);
    writeFileSync(join(store.dir(jobId), "journal.json"), "{}");
    const modal = new FakeModal();
    const out = await enter(stub, jobId, cfg, modal);
    assert.equal(out.outcome, "submit_unknown");
    assert.equal(modal.spawns.length, 0);
    await stub.stop();
  });

  test("without a Modal client the controller has no effect", async () => {
    const jobId = randomUUID();
    const stub = await start({ jobId });
    const cfg = settings(stub.url);
    const out = await runController(
      { settings: cfg, api: api(stub), store: new JournalStore(cfg.stateDir) },
      { jobId, runRef: "run-x" },
    );
    assert.deepEqual(out, {
      outcome: "no_effect",
      reason: "modal_client_missing",
    });
    assert.ok(!stub.actions().includes("record_worker_submission"));
    await stub.stop();
  });

  test("an expired start or execution deadline, or a missing token, blocks the spawn (no new paid call after expiry)", async () => {
    for (const [name, over] of [
      [
        "start deadline",
        { startDeadline: new Date(Date.now() - 1000).toISOString() },
      ],
      [
        "execution deadline",
        {
          startDeadline: new Date(Date.now() - 2000).toISOString(),
          executionDeadline: new Date(Date.now() - 1000).toISOString(),
        },
      ],
    ] as const) {
      const jobId = randomUUID();
      const stub = await start({ jobId });
      const cfg = settings(stub.url);
      const store = new JournalStore(cfg.stateDir);
      store.saveToken(jobId, stub.token);
      seed(store, jobId, { phase: "intent", ...over });
      const modal = new FakeModal();
      const out = await enter(stub, jobId, cfg, modal);
      assert.equal(out.outcome, "submit_unknown", name);
      assert.equal(modal.spawns.length, 0, name);
      assert.equal(evidence(stub).length, 0, name);
      await stub.stop();
    }
    // A journal at 'intent' with a live deadline but no token also never spawns.
    const jobId = randomUUID();
    const stub = await start({ jobId });
    const cfg = settings(stub.url);
    seed(new JournalStore(cfg.stateDir), jobId, { phase: "intent" });
    const modal = new FakeModal();
    assert.equal(
      (await enter(stub, jobId, cfg, modal)).outcome,
      "submit_unknown",
    );
    assert.equal(modal.spawns.length, 0);
    await stub.stop();
  });

  test("a lost controller lease stops supervision with no evidence and no second call", async () => {
    const jobId = randomUUID();
    const id = callId();
    const stub = await start({ jobId, state: "running", renewWins: false });
    const cfg = settings(stub.url);
    seed(new JournalStore(cfg.stateDir), jobId, {
      phase: "submitted",
      callId: id,
    });
    const modal = new FakeModal({ poll: () => pending });
    const out = await enter(stub, jobId, cfg, modal);
    assert.deepEqual(out, { outcome: "lease_lost", executionRef: id });
    assert.equal(modal.spawns.length, 0);
    assert.equal(evidence(stub).length, 0);
    await stub.stop();
  });

  test("an adopted call keeps the server's ORIGINAL start deadline, never the six-hour execution deadline", async () => {
    const jobId = randomUUID();
    const id = callId();
    const stub = await start(
      { jobId, state: "running", initialExecutionRef: id },
      3_600_000,
    );
    const cfg = settings(stub.url);
    const out = await enter(stub, jobId, cfg, new FakeModal());
    assert.equal(out.outcome, "call_terminal");
    const j = new JournalStore(cfg.stateDir).readModal(jobId)!;
    assert.ok(
      Date.parse(j.startDeadline) < Date.parse(j.executionDeadline) - 1_000_000,
    );
    await stub.stop();
  });

  test("the LOCAL executor refuses a job admitted to Modal and a foreign Modal journal before any submission or spawn", async () => {
    const local = (apiUrl: string): LocalControllerSettings => ({
      apiUrl,
      stateDir: join(root, `state-${randomUUID()}`),
      python: "/nonexistent",
      renewIntervalMs: 100,
      pollIntervalMs: 20,
      leaseWaitMs: 0,
      reapGraceMs: 200,
      apiTimeoutMs: 5000,
      pipeline: "local_fixture_noop",
    });
    {
      const jobId = randomUUID();
      const stub = await start({ jobId }); // admitted backend: modal
      const cfg = local(stub.url);
      const out = await runController(
        {
          settings: cfg,
          api: api(stub),
          store: new JournalStore(cfg.stateDir),
        },
        { jobId, runRef: "run-l1" },
      );
      assert.deepEqual(out, {
        outcome: "needs_operator",
        reason: "backend_mismatch",
      });
      assert.ok(!stub.actions().includes("record_worker_submission"));
      await stub.stop();
    }
    {
      const jobId = randomUUID();
      const stub = await start({ jobId, statusBackend: "local" });
      const cfg = local(stub.url);
      const store = new JournalStore(cfg.stateDir);
      seed(store, jobId, { phase: "submitted", callId: callId() });
      const out = await runController(
        { settings: cfg, api: api(stub), store },
        { jobId, runRef: "run-l2" },
      );
      assert.equal(out.outcome, "submit_unknown");
      assert.ok(!stub.actions().includes("record_worker_submission"));
      assert.equal(evidence(stub).length, 0);
      await stub.stop();
    }
  });
});
