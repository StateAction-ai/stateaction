import assert from "node:assert/strict";
import test from "node:test";
import type { ModalControllerSettings } from "../src/config.js";
import { ModalSpawnNotSent, parseRunResult } from "../src/modal-executor.js";
import { createModalSdkClient } from "../src/modal-sdk.js";
import { CALL_ID, validateModalJournal } from "../src/journal.js";

const settings: ModalControllerSettings = {
  executor: "modal",
  apiUrl: "https://stateaction.example.com",
  stateDir: "/tmp/x",
  renewIntervalMs: 100,
  pollIntervalMs: 20,
  leaseWaitMs: 0,
  reapGraceMs: 100,
  apiTimeoutMs: 100,
  appName: "stateaction-processing",
  functionName: "process_recording",
  environmentName: "main",
  pipeline: "hand_pose_cpu_v1",
};

// Mirrors the real SDK's class relationships: the (deprecated) instanceof shim makes a poll
// TimeoutError ALSO an instance of FunctionTimeoutError, so the adapter must test TimeoutError first.
class TimeoutError extends Error {}
class FunctionTimeoutError extends Error {
  static [Symbol.hasInstance](instance: unknown) {
    return (
      instance instanceof Error && /Timeout/.test(instance.constructor.name)
    );
  }
}
class RemoteError extends Error {
  constructor(m: string) {
    super(m);
    this.name = "RemoteError";
  }
}
function fakeSdk(
  get: () => Promise<unknown>,
  spawn?: () => Promise<unknown>,
  lookup?: () => Promise<void>,
) {
  const log: {
    ctor?: unknown;
    spawn?: unknown;
    cancel?: unknown;
    from?: unknown;
    closed?: boolean;
  } = {};
  const call = {
    functionCallId: "fc-ABC123",
    get: async () => get(),
    cancel: async (p?: unknown) => {
      log.cancel = p;
    },
  };
  class ModalClient {
    constructor(p?: unknown) {
      log.ctor = p;
    }
    functions = {
      fromName: async (a: string, n: string, p?: unknown) => {
        log.from = { a, n, p };
        await lookup?.();
        return {
          spawn: async (args?: unknown[]) => {
            log.spawn = args;
            await spawn?.();
            return call;
          },
        };
      },
    };
    functionCalls = { fromId: async () => call };
    close() {
      log.closed = true;
    }
  }
  return { log, mod: { ModalClient, TimeoutError, FunctionTimeoutError } };
}
const withCreds = async <T>(fn: () => Promise<T>) => {
  Object.assign(process.env, {
    MODAL_TOKEN_ID: "ak-t",
    MODAL_TOKEN_SECRET: "as-t",
  });
  try {
    return await fn();
  } finally {
    delete process.env.MODAL_TOKEN_ID;
    delete process.env.MODAL_TOKEN_SECRET;
  }
};

test("spawn passes ONE JSON string argument and returns the provider call ID; credentials stay in the client", async () => {
  const { log, mod } = fakeSdk(async () => undefined);
  const client = createModalSdkClient(settings, async () => mod as never);
  const boot = {
    schemaVersion: 1 as const,
    apiUrl: "https://stateaction.example.com",
    jobId: "7e0b7a58-0f3b-4b0f-9d1a-2f6a1b0c1d2e",
    bootstrapToken: `sa_svc_${"A".repeat(43)}`,
    pipeline: "hand_pose_cpu_v1" as const,
  };
  const id = await withCreds(() => client.spawn(boot, () => true));
  assert.equal(id, "fc-ABC123");
  assert.deepEqual(log.spawn, [JSON.stringify(boot)]);
  // Per-RPC deadline and NO SDK-level retry (a retried spawn RPC could start a second call).
  assert.deepEqual(log.ctor, {
    tokenId: "ak-t",
    tokenSecret: "as-t",
    timeoutMs: 100,
    maxRetries: 0,
    environment: "main",
  });
  assert.deepEqual(log.from, {
    a: "stateaction-processing",
    n: "process_recording",
    p: { environment: "main" },
  });
});

test("without both Modal credentials the adapter refuses before any provider call", async () => {
  const { log, mod } = fakeSdk(async () => undefined);
  const client = createModalSdkClient(settings, async () => mod as never);
  await assert.rejects(
    () => client.spawn({} as never, () => true),
    /MODAL_TOKEN_ID/,
  );
  assert.equal(log.spawn, undefined);
});

test("poll classifies: a returned value, our poll timeout, a function timeout and other errors; none but a value can be terminal", async () => {
  const cases: [() => Promise<unknown>, string, string | undefined][] = [
    [async () => ({ ok: 1 }), "returned", undefined],
    [
      async () => {
        throw new TimeoutError("Timeout exceeded: 1000ms");
      },
      "pending",
      "poll_timeout",
    ],
    [
      async () => {
        throw new FunctionTimeoutError("Timeout: remote");
      },
      "unavailable",
      "function_timeout",
    ],
    [
      async () => {
        throw new RemoteError("Remote error: secret-bearing text");
      },
      "unavailable",
      "RemoteError",
    ],
    [
      async () => {
        throw "weird";
      },
      "unavailable",
      "unknown_error",
    ],
  ];
  for (const [get, kind, detail] of cases) {
    const { mod } = fakeSdk(get);
    const client = createModalSdkClient(settings, async () => mod as never);
    const seen = await withCreds(() => client.poll("fc-ABC123"));
    assert.equal(seen.kind, kind);
    if (seen.kind !== "returned") {
      assert.equal(seen.detail, detail);
      // The provider message is never carried forward.
      assert.ok(!JSON.stringify(seen).includes("secret-bearing"));
    }
  }
});

test("a spawn that never answers is bounded and surfaces as a failure the controller treats as UNCERTAIN (no retry here)", async () => {
  let calls = 0;
  const { mod } = fakeSdk(
    async () => undefined,
    () => {
      calls++;
      return new Promise(() => undefined); // never resolves
    },
  );
  const client = createModalSdkClient(settings, async () => mod as never);
  const started = Date.now();
  await assert.rejects(
    () => withCreds(() => client.spawn({} as never, () => true)),
    /bound/,
  );
  assert.ok(Date.now() - started < 2000);
  assert.equal(calls, 1, "the adapter never retries a spawn");
});

test("a function lookup that resolves after the spawn timer fires cannot issue a call", async (t) => {
  // Timers can fire while the high-resolution deadline is still in the future.
  t.mock.method(performance, "now", () => 0);
  const lookup = Promise.withResolvers<void>();
  const { log, mod } = fakeSdk(
    async () => undefined,
    undefined,
    () => lookup.promise,
  );
  const client = createModalSdkClient(settings, async () => mod as never);
  await assert.rejects(
    () => withCreds(() => client.spawn({} as never, () => true)),
    ModalSpawnNotSent,
  );
  assert.ok(log.from);
  lookup.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(log.spawn, undefined);
});

test("authorization is checked after lookup and before invoking spawn", async () => {
  let authorized = true;
  const { log, mod } = fakeSdk(
    async () => undefined,
    undefined,
    async () => {
      authorized = false;
    },
  );
  const client = createModalSdkClient(settings, async () => mod as never);
  await assert.rejects(
    () => withCreds(() => client.spawn({} as never, () => authorized)),
    ModalSpawnNotSent,
  );
  assert.equal(log.spawn, undefined);
});

test("a poll that never answers is unavailable (not pending, not terminal)", async () => {
  const { mod } = fakeSdk(() => new Promise(() => undefined));
  const client = createModalSdkClient(
    { ...settings, apiTimeoutMs: 20 },
    async () => mod as never,
  );
  const seen = await withCreds(() => client.poll("fc-ABC123"));
  assert.deepEqual(seen, { kind: "unavailable", detail: "operation_timeout" });
});

test("missing credentials make a poll unavailable and close releases the SDK client", async () => {
  const { log, mod } = fakeSdk(async () => ({ ok: 1 }));
  const client = createModalSdkClient(settings, async () => mod as never);
  assert.deepEqual(await client.poll("fc-ABC123"), {
    kind: "unavailable",
    detail: "sdk_unavailable",
  });
  await withCreds(() => client.poll("fc-ABC123"));
  client.close?.();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(log.closed, true);
});

test("cancel requests container termination", async () => {
  const { log, mod } = fakeSdk(async () => undefined);
  const client = createModalSdkClient(settings, async () => mod as never);
  await withCreds(() => client.cancel("fc-ABC123"));
  assert.deepEqual(log.cancel, { terminateContainers: true });
});

test("parseRunResult accepts only the exact structured result for the recorded call", () => {
  const id = "fc-ABC123";
  assert.deepEqual(
    parseRunResult({ schemaVersion: 1, functionCallId: id, exitCode: 0 }, id),
    {
      schemaVersion: 1,
      functionCallId: id,
      exitCode: 0,
    },
  );
  for (const bad of [
    null,
    [],
    "x",
    { schemaVersion: 1, functionCallId: "fc-OTHER", exitCode: 0 },
    { schemaVersion: 2, functionCallId: id, exitCode: 0 },
    { schemaVersion: 1, functionCallId: id, exitCode: 1.5 },
    { schemaVersion: 1, functionCallId: id, exitCode: 999 },
    { schemaVersion: 1, functionCallId: id },
    { schemaVersion: 1, functionCallId: id, exitCode: 0, extra: 1 },
  ])
    assert.equal(parseRunResult(bad, id), undefined, JSON.stringify(bad));
});

test("Modal journal validation: call ID exists exactly from 'submitted', strict keys, bounded exit", () => {
  const job = "7e0b7a58-0f3b-4b0f-9d1a-2f6a1b0c1d2e";
  const base = {
    version: 1,
    executor: "modal",
    jobId: job,
    runRef: "run-1",
    startDeadline: "2026-11-02T00:00:00Z",
    executionDeadline: "2026-11-02T06:00:00Z",
  };
  assert.ok(validateModalJournal({ ...base, phase: "intent" }, job));
  assert.ok(validateModalJournal({ ...base, phase: "spawning" }, job));
  assert.ok(
    validateModalJournal(
      { ...base, phase: "submitted", callId: "fc-ABC" },
      job,
    ),
  );
  assert.ok(
    validateModalJournal(
      { ...base, phase: "terminal", callId: "fc-ABC", exitCode: -9 },
      job,
    ),
  );
  for (const bad of [
    { ...base, phase: "spawning", callId: "fc-ABC" },
    { ...base, phase: "submitted" },
    { ...base, phase: "submitted", callId: "local-1" },
    { ...base, phase: "terminal", callId: "fc-ABC" },
    { ...base, phase: "terminal", callId: "fc-ABC", exitCode: 999 },
    { ...base, phase: "intent", exitCode: 0 },
    { ...base, phase: "mystery" },
    { ...base, phase: "intent", extra: 1 },
    { ...base, executor: "local", phase: "intent" },
    { ...base, phase: "intent", executionRecorded: true },
  ])
    assert.throws(
      () => validateModalJournal(bad, job),
      /Journal corrupt/,
      JSON.stringify(bad),
    );
  assert.ok(CALL_ID.test("fc-" + "a".repeat(77)));
  assert.ok(!CALL_ID.test("fc-" + "a".repeat(78)));
});
