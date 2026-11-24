import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  floraCheckpointPins,
  immutableModalAppName,
  requestSha256,
  sha256Hex,
} from "@stateaction/contracts";
import {
  inspectModalDeployment,
  type ModalInspectionApi,
} from "../src/modal-deployment.js";
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

test("a stage spawn looks the function up in the app its module binding names", async () => {
  const stage = (module: string) => ({
    schemaVersion: 2 as const,
    apiUrl: "https://stateaction.example.com",
    jobId: "7e0b7a58-0f3b-4b0f-9d1a-2f6a1b0c1d2e",
    bootstrapToken: `sa_svc_${"A".repeat(43)}`,
    stage: "segment" as const,
    module,
    recipeSha256: "a".repeat(64),
  });
  const bound: ModalControllerSettings = {
    ...settings,
    stageFunctions: {
      "flora_tempseg_vllm_fp8@1": "flora_tempseg",
      "flora_captioner_vllm_fp8@1": "flora_captioner",
    },
    stageApps: { "flora_tempseg_vllm_fp8@1": "stateaction-flora-stages" },
  };
  const lookups: Array<[unknown, unknown]> = [];
  for (const [module, app, fn] of [
    ["flora_tempseg_vllm_fp8@1", "stateaction-flora-stages", "flora_tempseg"],
    ["flora_captioner_vllm_fp8@1", "stateaction-processing", "flora_captioner"],
  ]) {
    const { log, mod } = fakeSdk(async () => undefined);
    const client = createModalSdkClient(bound, async () => mod as never);
    const id = await withCreds(() =>
      client.spawn(stage(module!) as never, () => true),
    );
    assert.equal(id, "fc-ABC123");
    lookups.push([
      (log.from as { a: unknown }).a,
      (log.from as { n: unknown }).n,
    ]);
    assert.deepEqual(lookups.at(-1), [app, fn]);
  }
  // The hand_pose v1 bootstrap keeps the controller's app and function.
  const { log, mod } = fakeSdk(async () => undefined);
  const client = createModalSdkClient(bound, async () => mod as never);
  await withCreds(() =>
    client.spawn(
      {
        schemaVersion: 1,
        apiUrl: "https://stateaction.example.com",
        jobId: "7e0b7a58-0f3b-4b0f-9d1a-2f6a1b0c1d2e",
        bootstrapToken: `sa_svc_${"A".repeat(43)}`,
        pipeline: "hand_pose_cpu_v1",
      },
      () => true,
    ),
  );
  assert.deepEqual(
    [(log.from as { a: unknown }).a, (log.from as { n: unknown }).n],
    ["stateaction-processing", "process_recording"],
  );
});

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

test("bound Modal spawn checks fresh immutable identity, image and bounded resources", async () => {
  const module = "hand_pose_cpu_v1@1";
  const codeRevision = "a".repeat(40);
  const paramsSha256 = requestSha256({});
  const appName = immutableModalAppName(module, codeRevision, paramsSha256);
  const deployed = {
    appName,
    codeRevision,
    paramsSha256,
    environment: "main",
    gpu: "none",
    maxBilledSeconds: 760,
    maxContainers: 1,
    maxCpuMilli: 4000,
    maxMemoryMib: 8192,
    microUsdPerGpuSecond: 0,
    microUsdPerCpuSecond: 211,
  };
  const bootstrap = {
    schemaVersion: 1 as const,
    apiUrl: "https://stateaction.example.com",
    jobId: "7e0b7a58-0f3b-4b0f-9d1a-2f6a1b0c1d2e",
    bootstrapToken: "fixture",
    pipeline: "hand_pose_cpu_v1" as const,
    stage: "hand_pose" as const,
    module,
  };
  const schedule = {
    maxContainers: 1,
    minContainers: 0,
    bufferContainers: 0,
    scaledownWindow: 0,
  };
  const variant = {
    appName,
    imageId: "im-approved",
    mountIds: ["mo-source"],
    secretIds: [] as string[],
    moduleName: "modal_app",
    functionName: settings.functionName,
    timeoutSecs: 600,
    startupTimeoutSecs: 100,
    retryPolicy: { retries: 0 },
    schedulerPlacement: { nonpreemptible: true },
    resources: {
      milliCpu: 4000,
      milliCpuMax: 4000,
      memoryMb: 8192,
      memoryMbMax: 8192,
      gpuConfig: { count: 0, gpuType: "" },
    },
  };
  const response = {
    functionId: "fu-approved",
    handleMetadata: { definitionId: "fd-approved", appId: "ap-approved" },
    function: {
      moduleName: "modal_app",
      functionName: settings.functionName,
      implementationName: "process_recording",
      rankedFunctions: [{ rank: 0, function: variant }],
    },
  };
  let failLookup = false;
  let calls = 0;
  let returnedId = response.functionId;
  const chain: string[] = [];
  const { mod } = fakeSdk(async () => undefined);
  const api = {
    functionGet: async (request: unknown) => {
      assert.deepEqual(request, {
        appName,
        objectTag: settings.functionName,
        environmentName: "main",
        appVersion: 0,
      });
      chain.push("inspect");
      if (failLookup) throw new Error("provider unavailable");
      return response;
    },
    functionGetSchedulingParams: async ({
      functionId,
    }: {
      functionId: string;
    }) => {
      assert.equal(functionId, response.functionId);
      return { autoscalerConfiguration: { settings: schedule } };
    },
  };
  class InspectableClient extends mod.ModalClient {
    cpClient = api;
    override functions = {
      fromName: async () => {
        throw new Error("name-based handle forbidden");
      },
      fromId: async (id: string) => {
        chain.push(id);
        return {
          functionId: returnedId,
          spawn: async () => {
            chain.push("spawn");
            calls++;
            return { functionCallId: "fc-ABC123" };
          },
        };
      },
    };
  }
  const identity = await inspectModalDeployment(
    api as unknown as ModalInspectionApi,
    deployed,
    settings.functionName,
  );
  assert.ok(identity);
  // Modal's Python SDK omits scheduler placement for GPU functions without a region.
  const { schedulerPlacement: _placement, ...defaultPlacement } = variant;
  const inspectGpu = (schedulerPlacement?: {
    nonpreemptible: boolean;
    regions?: string[];
    InstanceTypes?: string[];
    Zone?: string;
    Lifecycle?: string;
  }) =>
    inspectModalDeployment(
      {
        ...api,
        functionGet: async () => ({
          ...response,
          function: {
            ...response.function,
            rankedFunctions: [
              {
                rank: 0,
                function: {
                  ...defaultPlacement,
                  ...(schedulerPlacement ? { schedulerPlacement } : {}),
                  resources: {
                    ...variant.resources,
                    gpuConfig: { count: 1, gpuType: "RTX-PRO-6000" },
                  },
                },
              },
            ],
          },
        }),
      } as unknown as ModalInspectionApi,
      { ...deployed, gpu: "RTX-PRO-6000", microUsdPerGpuSecond: 842 },
      settings.functionName,
    );
  assert.ok(await inspectGpu());
  for (const placement of [
    { nonpreemptible: false },
    { nonpreemptible: false, regions: ["us-east"] },
    { nonpreemptible: false, InstanceTypes: ["premium"] },
    { nonpreemptible: false, Zone: "us-east-1a" },
    { nonpreemptible: false, Lifecycle: "on-demand" },
    { nonpreemptible: true, regions: ["eu-west"] },
  ]) {
    assert.equal(await inspectGpu(placement), undefined);
  }
  const cpuWithoutPlacement = {
    ...api,
    functionGet: async () => ({
      ...response,
      function: {
        ...response.function,
        rankedFunctions: [{ rank: 0, function: defaultPlacement }],
      },
    }),
  } as unknown as ModalInspectionApi;
  assert.equal(
    await inspectModalDeployment(
      cpuWithoutPlacement,
      deployed,
      settings.functionName,
    ),
    undefined,
  );
  const binding = { ...deployed, ...identity };
  const client = createModalSdkClient(
    { ...settings, appName },
    async () => ({ ...mod, ModalClient: InspectableClient }) as never,
  );
  await withCreds(async () => {
    const cannotSpawn = () =>
      assert.rejects(
        client.spawn(bootstrap, () => true, binding),
        ModalSpawnNotSent,
      );
    assert.equal(await client.checkFunction!(module, binding), true);
    variant.imageId = "im-redeployed";
    await cannotSpawn();
    variant.imageId = "im-approved";
    variant.mountIds = ["mo-unapproved"];
    await cannotSpawn();
    variant.mountIds = ["mo-source"];
    response.function.implementationName = "changed_entrypoint";
    await cannotSpawn();
    response.function.implementationName = "process_recording";
    variant.retryPolicy.retries = 1;
    await cannotSpawn();
    variant.retryPolicy.retries = 0;
    variant.resources.gpuConfig = { count: 1, gpuType: "H100" };
    await cannotSpawn();
    variant.resources.gpuConfig = { count: 0, gpuType: "" };
    schedule.maxContainers = 2;
    await cannotSpawn();
    schedule.maxContainers = 1;
    response.handleMetadata.definitionId = "fd-new";
    await cannotSpawn();
    response.handleMetadata.definitionId = binding.definitionId;
    failLookup = true;
    await cannotSpawn();
    failLookup = false;
    returnedId = "fu-other";
    await cannotSpawn();
    returnedId = binding.functionId;
    assert.equal(
      await client.checkFunction!(module, {
        ...binding,
        maxBilledSeconds: 759,
      }),
      false,
    );
    assert.equal(
      await client.checkFunction!(module, { ...binding, appName: "other-app" }),
      false,
    );
    assert.equal(
      await client.checkFunction!(module, {
        ...binding,
        codeRevision: "b".repeat(40),
      }),
      false,
    );
    assert.equal(calls, 0);

    chain.length = 0;
    assert.equal(
      await client.spawn(bootstrap, () => true, binding),
      "fc-ABC123",
    );
    assert.deepEqual(chain, ["inspect", binding.functionId, "spawn"]);
    assert.equal(calls, 1);
    // The stopped production function's read-only metadata returned an
    // empty definition ID, with this CPU limit, timeout and autoscaling shape.
    variant.secretIds = ["st-Added"];
    assert.equal(await client.checkFunction!(module, binding), false);
    await cannotSpawn();
    response.handleMetadata.definitionId = "";
    assert.equal(
      await inspectModalDeployment(
        api as unknown as ModalInspectionApi,
        deployed,
        settings.functionName,
      ),
      undefined,
    );
    variant.secretIds = [];
    variant.timeoutSecs = 1100;
    variant.startupTimeoutSecs = 120;
    schedule.scaledownWindow = 60;
    const observed = { ...deployed, maxBilledSeconds: 1350 };
    const fallback = await inspectModalDeployment(
      api as unknown as ModalInspectionApi,
      observed,
      settings.functionName,
    );
    assert.ok(fallback);
    assert.equal(
      fallback.definitionId,
      `definition-sha256-${fallback.definitionSha256}`,
    );
    const fallbackBinding = { ...observed, ...fallback };
    assert.equal(await client.checkFunction!(module, fallbackBinding), true);
    response.handleMetadata.appId = "";
    assert.equal(await client.checkFunction!(module, fallbackBinding), false);
    response.handleMetadata.appId = "ap-approved";
    response.functionId = "";
    assert.equal(await client.checkFunction!(module, fallbackBinding), false);
    response.functionId = "fu-approved";
    variant.imageId = "im-drift";
    assert.equal(await client.checkFunction!(module, fallbackBinding), false);
    await assert.rejects(
      client.spawn(bootstrap, () => true, fallbackBinding),
      ModalSpawnNotSent,
    );
    variant.imageId = "im-approved";
    assert.equal(
      await client.spawn(bootstrap, () => true, fallbackBinding),
      "fc-ABC123",
    );
    assert.equal(calls, 2);
    const planner = {
      schemaVersion: 1 as const,
      apiUrl: bootstrap.apiUrl,
      jobId: bootstrap.jobId,
      bootstrapToken: bootstrap.bootstrapToken,
      pipeline: "clip_plan_cpu_v1" as const,
    };
    chain.length = 0;
    await assert.rejects(
      client.spawn(planner, () => true),
      ModalSpawnNotSent,
    );
    assert.deepEqual(chain, []);
    assert.equal(calls, 2);
    assert.equal(
      await client.spawn(planner, () => true, fallbackBinding),
      "fc-ABC123",
    );
    assert.deepEqual(chain, ["inspect", fallbackBinding.functionId, "spawn"]);
    assert.equal(calls, 3);
    client.close();
  });
});

test("bound GPU spawn requires its exact model volume and published checkpoint manifest", async (t) => {
  const module = "flora_tempseg_vllm_fp8@1";
  const codeRevision = "c".repeat(40);
  const paramsSha256 = requestSha256({});
  const appName = immutableModalAppName(module, codeRevision, paramsSha256);
  const objectTag = "flora_tempseg";
  const environment = "main";
  const original = '{"fixture":"published checkpoint"}';
  let contents = original;
  const pins = structuredClone(floraCheckpointPins);
  pins.checkpoints.tempseg.manifestSha256 = sha256Hex(Buffer.from(original));
  const file = `flora/${pins.checkpoints.tempseg.checkpointId}/MANIFEST.json`;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.origin, "https://volume.example.test");
    return new Response(contents);
  });
  const deployed = {
    appName,
    environment,
    codeRevision,
    paramsSha256,
    gpu: "RTX-PRO-6000",
    maxBilledSeconds: 760,
    maxContainers: 1,
    maxCpuMilli: 4000,
    maxMemoryMib: 8192,
    microUsdPerGpuSecond: 842,
    microUsdPerCpuSecond: 247,
  };
  const mount = {
    volumeId: "vo-Approved",
    mountPath: "/models",
    readOnly: true,
    allowBackgroundCommits: false,
  };
  let volumeVersion = 2;
  let volumeEnvironment = environment;
  let signedReads = true;
  const fn = {
    appName,
    imageId: "im-Approved",
    timeoutSecs: 600,
    startupTimeoutSecs: 100,
    resources: {
      milliCpu: 4000,
      milliCpuMax: 4000,
      memoryMb: 8192,
      memoryMbMax: 8192,
      gpuConfig: { count: 1, gpuType: deployed.gpu },
    },
    volumeMounts: [mount],
  };
  const identity = {
    functionId: "fu-Approved",
    handleMetadata: { appId: "ap-Approved", definitionId: "" },
  };
  const cp = {
    async functionGet() {
      return {
        ...identity,
        function: {
          moduleName: "modal_stage",
          functionName: objectTag,
          rankedFunctions: [{ rank: 0, function: fn }],
        },
      };
    },
    async functionGetSchedulingParams() {
      return {
        autoscalerConfiguration: {
          settings: { maxContainers: 1, scaledownWindow: 0 },
        },
      };
    },
    async functionCallFetch() {
      return { functionCallInputs: [] };
    },
    async volumeList() {
      return {
        environmentName: volumeEnvironment,
        items: [
          {
            volumeId: mount.volumeId,
            metadata: { name: pins.volumeName, version: volumeVersion },
          },
        ],
      };
    },
    async volumeGetFile2(request: { volumeId: string; path: string }) {
      if (!signedReads) throw new Error("manifest lookup refused");
      assert.equal(request.volumeId, mount.volumeId);
      assert.equal(request.path, file);
      return {
        size: Buffer.byteLength(contents),
        start: 0,
        len: Buffer.byteLength(contents),
        getUrls: ["https://volume.example.test/fixture"],
      };
    },
  };
  let spawns = 0;
  const { mod } = fakeSdk(async () => undefined);
  class InspectableClient extends mod.ModalClient {
    cpClient = cp;
    override functions = {
      fromName: async () =>
        assert.fail("bound functions must use the verified ID"),
      fromId: async (id: string) => {
        assert.equal(id, identity.functionId);
        return {
          functionId: id,
          spawn: async () => {
            spawns++;
            return { functionCallId: "fc-Approved" };
          },
        };
      },
    };
  }
  const inspect: typeof inspectModalDeployment = (api, deployment, tag, ref) =>
    inspectModalDeployment(api, deployment, tag, ref, pins);
  const approved = await inspect(
    cp as unknown as ModalInspectionApi,
    deployed,
    objectTag,
    module,
  );
  assert.ok(approved);
  const binding = { ...deployed, ...approved };
  const client = createModalSdkClient(
    {
      ...settings,
      stageApps: { [module]: appName },
      stageFunctions: { [module]: objectTag },
    },
    async () => ({ ...mod, ModalClient: InspectableClient }) as never,
    inspect,
  );
  const bootstrap = {
    schemaVersion: 2 as const,
    apiUrl: settings.apiUrl,
    jobId: "7e0b7a58-0f3b-4b0f-9d1a-2f6a1b0c1d2e",
    bootstrapToken: "fixture",
    stage: "segment" as const,
    module,
    recipeSha256: "d".repeat(64),
  };

  await withCreds(async () => {
    const refuses = () =>
      assert.rejects(
        client.spawn(bootstrap, () => true, binding),
        ModalSpawnNotSent,
      );
    assert.equal(await client.checkFunction!(module, binding), true);
    mount.volumeId = "vo-Changed";
    await refuses();
    mount.volumeId = "vo-Approved";
    mount.mountPath = "/other";
    await refuses();
    mount.mountPath = "/models";
    mount.readOnly = false;
    await refuses();
    mount.readOnly = true;
    volumeVersion = 1;
    await refuses();
    volumeVersion = 2;
    volumeEnvironment = "other";
    await refuses();
    volumeEnvironment = environment;
    contents = original.replace("published", "different");
    await refuses();
    contents = original;
    signedReads = false;
    await refuses();
    signedReads = true;
    fn.volumeMounts = [];
    await refuses();
    fn.volumeMounts = [mount];
    assert.equal(spawns, 0);
    assert.equal(
      await client.spawn(bootstrap, () => true, binding),
      "fc-Approved",
    );
    assert.equal(spawns, 1);
    client.close();
  });
});

test("inspects the scrubbed live TempSeg and hand-pose deployment definitions", async (t) => {
  type Observed = {
    objectTag: string;
    lookup: Awaited<ReturnType<ModalInspectionApi["functionGet"]>>;
    schedule: Awaited<
      ReturnType<ModalInspectionApi["functionGetSchedulingParams"]>
    >;
  };
  const observations = JSON.parse(
    readFileSync(
      new URL("./fixtures/modal-deployment-window-3.json", import.meta.url),
      "utf8",
    ),
  ) as Record<"tempseg" | "handPose", Observed>;
  const manifest = Buffer.from("published checkpoint");
  const pins = structuredClone(floraCheckpointPins);
  pins.checkpoints.tempseg.manifestSha256 = sha256Hex(manifest);
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("published checkpoint"),
  );

  function inspect(
    fixture: Observed,
    module: string,
    bounds: {
      gpu: string;
      maxMemoryMib: number;
      maxCpuMilli: number;
      maxBilledSeconds: number;
      microUsdPerCpuSecond: number;
      microUsdPerGpuSecond: number;
    },
  ) {
    const appName =
      fixture.lookup.function!.rankedFunctions[0]!.function!.appName;
    const volumeId =
      fixture.lookup.function!.rankedFunctions[0]!.function!.volumeMounts[0]
        ?.volumeId;
    const api = {
      functionGet: async () => fixture.lookup,
      functionGetSchedulingParams: async () => fixture.schedule,
      volumeList: async () => ({
        environmentName: "main",
        items: [{ volumeId, metadata: { name: pins.volumeName, version: 2 } }],
      }),
      volumeGetFile2: async () => ({
        size: manifest.length,
        start: 0,
        len: manifest.length,
        getUrls: ["https://volume.example.test/scrubbed"],
      }),
    } as unknown as ModalInspectionApi;
    return inspectModalDeployment(
      api,
      { appName, environment: "main", maxContainers: 1, ...bounds },
      fixture.objectTag,
      module,
      pins,
    );
  }

  const gpu = {
    gpu: "RTX-PRO-6000",
    maxCpuMilli: 8000,
    maxMemoryMib: 65536,
    maxBilledSeconds: 930,
    microUsdPerCpuSecond: 247,
    microUsdPerGpuSecond: 842,
  };
  const tempsegModule = "flora_tempseg_vllm_fp8@1";
  const tempseg = observations.tempseg;
  const bound = await inspect(tempseg, tempsegModule, gpu);
  assert.ok(bound);
  assert.equal(
    bound.definitionId,
    "definition-sha256-" + bound.definitionSha256,
  );
  assert.equal(bound.functionId, tempseg.lookup.functionId);

  const definition = tempseg.lookup.function!;
  const fn = definition.rankedFunctions[0]!.function!;
  const mount = fn.volumeMounts[0]!;
  assert.equal(mount.allowBackgroundCommits, true);
  mount.allowBackgroundCommits = false;
  const changed = await inspect(tempseg, tempsegModule, gpu);
  assert.ok(changed);
  assert.notEqual(changed.definitionSha256, bound.definitionSha256);
  mount.readOnly = false;
  assert.equal(await inspect(tempseg, tempsegModule, gpu), undefined);
  mount.readOnly = true;
  mount.allowBackgroundCommits = true;

  for (const variantChanges of [
    { proxyId: "px-Fixture" },
    { routingRegion: "eu-west" },
    { cloudProviderStr: "gcp" },
    { cloudBucketMounts: [{}] },
    { sharedVolumeMounts: [{}] },
    { s3Mounts: [{}] },
    { maxConcurrentInputs: 2 },
    { ExperimentalBufferContainers: 1 },
    { ExperimentalTaskTemplatesEnabled: true },
    { singleUseContainers: false },
  ]) {
    const fixture = structuredClone(tempseg);
    Object.assign(
      fixture.lookup.function!.rankedFunctions[0]!.function!,
      variantChanges,
    );
    const candidate = await inspect(fixture, tempsegModule, gpu);
    if (variantChanges.singleUseContainers !== undefined) {
      assert.ok(candidate);
      assert.notEqual(candidate.definitionSha256, bound.definitionSha256);
    } else {
      assert.equal(candidate, undefined, JSON.stringify(variantChanges));
    }
  }
  definition.httpConfig!.proxyRegions = ["eu-west"];
  assert.equal(await inspect(tempseg, tempsegModule, gpu), undefined);
  definition.httpConfig!.proxyRegions = [];
  assert.equal(
    await inspect(tempseg, tempsegModule, {
      ...gpu,
      microUsdPerGpuSecond: 841,
    }),
    undefined,
  );
  assert.deepEqual(await inspect(tempseg, tempsegModule, gpu), bound);

  const cpu = {
    gpu: "none",
    maxCpuMilli: 4000,
    maxMemoryMib: 26215,
    maxBilledSeconds: 1350,
    microUsdPerCpuSecond: 328,
    microUsdPerGpuSecond: 0,
  };
  const handPoseModule = "hand_pose_cpu_v1@1";
  const handPose = observations.handPose;
  assert.ok(await inspect(handPose, handPoseModule, cpu));
  assert.equal(
    await inspect(handPose, handPoseModule, { ...cpu, maxMemoryMib: 8192 }),
    undefined,
  );
  assert.equal(
    await inspect(handPose, handPoseModule, {
      ...cpu,
      microUsdPerCpuSecond: 327,
    }),
    undefined,
  );
  handPose.schedule.autoscalerConfiguration!.settings!.scaledownWindow = 71;
  assert.equal(await inspect(handPose, handPoseModule, cpu), undefined);
});

test("preflight accepts real Modal SDK defaults and refuses a defined zero override", async (t) => {
  const records = JSON.parse(
    readFileSync(
      new URL("./fixtures/modal-deployment-wire.json", import.meta.url),
      "utf8",
    ),
  ) as Record<"handPose" | "tempseg", Record<string, string>>;
  const { serveModalWire } = await import("./modal-wire.js");
  const pins = structuredClone(floraCheckpointPins);
  pins.checkpoints.tempseg.manifestSha256 = sha256Hex(
    Buffer.from("published checkpoint"),
  );
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    assert.equal(url.origin, "https://volume.example.test");
    return new Response("published checkpoint");
  });

  const defaultGpu = {
    module: "flora_tempseg_vllm_fp8@1",
    tag: "flora_tempseg",
    gpu: "RTX-PRO-6000",
    maxMemoryMib: 65536,
    maxCpuMilli: 8000,
    maxBilledSeconds: 930,
    microUsdPerGpuSecond: 842,
    microUsdPerCpuSecond: 247,
  };
  const nonpreemptibleCpu = {
    module: "hand_pose_cpu_v1@1",
    tag: "process_recording",
    gpu: "none",
    maxMemoryMib: 26215,
    maxCpuMilli: 4000,
    maxBilledSeconds: 1250,
    microUsdPerGpuSecond: 0,
    microUsdPerCpuSecond: 328,
  };
  for (const [key, fixture] of [
    ["handPose", nonpreemptibleCpu],
    ["tempseg", defaultGpu],
  ] as const) {
    const responses = records[key];
    let override = false;
    const wire = await serveModalWire((method) =>
      override && method === "FunctionGetSchedulingParams"
        ? responses.DefinedZeroOverride
        : responses[method],
    );
    try {
      const functionLookup = await wire.api.functionGet({
        appName: "unused",
        objectTag: fixture.tag,
        environmentName: "main",
        appVersion: 0,
      });
      const fn = functionLookup.function!.rankedFunctions[0]!.function!;
      const deployment = {
        ...fixture,
        appName: fn.appName,
        environment: "main",
        maxContainers: 1,
      };
      const { autoscalerConfiguration } =
        await wire.api.functionGetSchedulingParams({
          functionId: functionLookup.functionId,
        });
      const overrides = autoscalerConfiguration!.overrideSettings!;
      assert.ok(Object.hasOwn(overrides, "minContainers"));
      assert.ok(Object.values(overrides).every((value) => value === undefined));
      if (key === "tempseg") {
        assert.ok(Object.hasOwn(fn, "schedulerPlacement"));
        assert.equal(fn.schedulerPlacement, undefined);
      }
      assert.ok(
        await inspectModalDeployment(
          wire.api,
          deployment,
          fixture.tag,
          fixture.module,
          pins,
        ),
      );

      if (key === "handPose") {
        override = true;
        const decoded = await wire.api.functionGetSchedulingParams({
          functionId: functionLookup.functionId,
        });
        assert.equal(
          decoded.autoscalerConfiguration?.overrideSettings?.minContainers,
          0,
        );
        assert.equal(
          await inspectModalDeployment(
            wire.api,
            deployment,
            fixture.tag,
            fixture.module,
            pins,
          ),
          undefined,
        );
      }
    } finally {
      await wire.close();
    }
  }
});
