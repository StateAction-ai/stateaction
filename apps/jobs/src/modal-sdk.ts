import {
  immutableModalAppName,
  type ModalRerunBinding,
} from "@stateaction/contracts";
import {
  inspectModalDeployment,
  type ModalInspectionApi,
} from "./modal-deployment.js";
import {
  HAND_POSE_MODULE,
  modalCredentials,
  modalAppFor,
  modalFunctionFor,
  type ModalControllerSettings,
} from "./config.js";
import {
  ModalSpawnNotSent,
  type CallObservation,
  type ModalBootstrap,
  type ModalClient,
} from "./modal-executor.js";

/**
 * Thin adapter over the official Modal JavaScript SDK (`modal`, pinned in
 * package.json; Beta). It only translates calls; every decision lives in the
 * controller. Verified against the 0.11.1 package source:
 *  - `Function_.spawn(args)` resolves a `FunctionCall` with `functionCallId`;
 *  - `FunctionCall.get({timeoutMs})` throws `TimeoutError` when OUR wait elapsed
 *    and `FunctionTimeoutError` for a remote function timeout. Note that
 *    `instanceof FunctionTimeoutError` is also true for the former (a deprecated
 *    compatibility shim), so `TimeoutError` MUST be tested first. The distinction
 *    only improves diagnostics: neither is terminal proof;
 *  - `FunctionCall.cancel({terminateContainers})` is a request.
 * The SDK is loaded lazily and only here, so the processing worker and the local
 * path never import it.
 */
type SdkCall = {
  functionCallId: string;
  get(params?: { timeoutMs?: number }): Promise<unknown>;
  cancel(params?: { terminateContainers?: boolean }): Promise<void>;
};
type SdkFunction = {
  functionId?: string;
  spawn(args?: unknown[]): Promise<SdkCall>;
};
type SdkClient = {
  close(): void;
  cpClient?: ModalInspectionApi &
    Partial<Pick<import("modal").ModalClient["cpClient"], "functionCallFetch">>;
  functions: {
    fromId?(functionId: string): Promise<SdkFunction>;
    fromName(
      app: string,
      name: string,
      params?: { environment?: string; version?: number },
    ): Promise<SdkFunction>;
  };
  functionCalls: { fromId(id: string): Promise<SdkCall> };
};
type SdkModule = {
  ModalClient: new (params?: {
    tokenId?: string;
    tokenSecret?: string;
    environment?: string;
    timeoutMs?: number;
    maxRetries?: number;
  }) => SdkClient;
  TimeoutError: new (message?: string) => Error;
  FunctionTimeoutError: new (message: string) => Error;
};

/** Poll window per observation; the controller loop enforces every real deadline itself. */
const POLL_WINDOW_MS = 1000;

/** The whole-operation bound the adapter itself failed to complete in time. */
export class ModalOperationTimeout extends Error {
  constructor(label: string) {
    super(`modal ${label} exceeded its bound`);
    this.name = "ModalOperationTimeout";
  }
}

/**
 * Bound a provider operation. The SDK exposes no abort for an in-flight request, so on expiry the
 * request may still complete later: a timed-out SPAWN is therefore UNCERTAIN (never a cancel,
 * never a retry), and the controller keeps its `spawning` journal.
 */
async function bounded<T>(
  label: string,
  ms: number,
  op: Promise<T>,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      op,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new ModalOperationTimeout(label));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // The losing branch may reject later; it must not become an unhandled rejection.
    op.catch(() => undefined);
  }
}

export function createModalSdkClient(
  settings: ModalControllerSettings,
  load: () => Promise<SdkModule> = async () => {
    // Indirect specifier: no static dependency, so type-checking and the local path never need the SDK.
    const specifier = "modal";
    return (await import(specifier)) as SdkModule;
  },
  inspect = inspectModalDeployment,
): ModalClient {
  let cached: Promise<{ mod: SdkModule; client: SdkClient }> | undefined;
  const sdk = () => {
    cached ??= (async () => {
      const mod = await load();
      const { tokenId, tokenSecret } = modalCredentials();
      const client = new mod.ModalClient({
        tokenId,
        tokenSecret,
        // Per-RPC deadline, and NO SDK-level retry: a retried spawn RPC could start a second call.
        timeoutMs: settings.apiTimeoutMs,
        maxRetries: 0,
        ...(settings.environmentName === undefined
          ? {}
          : { environment: settings.environmentName }),
      });
      return { mod, client };
    })();
    // A failed initialisation (missing credential, SDK load) must not be cached forever.
    cached.catch(() => {
      cached = undefined;
    });
    return cached;
  };
  const verify = async (
    client: SdkClient,
    module: string,
    binding: ModalRerunBinding,
  ) => {
    const objectTag = modalFunctionFor(settings, module);
    if (
      !objectTag ||
      !client.cpClient ||
      modalAppFor(settings, module) !== binding.appName ||
      immutableModalAppName(
        module,
        binding.codeRevision,
        binding.paramsSha256,
      ) !== binding.appName ||
      (settings.environmentName &&
        settings.environmentName !== binding.environment)
    )
      return false;
    const actual = await inspect(client.cpClient, binding, objectTag, module);
    if (
      actual?.functionId !== binding.functionId ||
      actual.definitionId !== binding.definitionId ||
      actual.definitionSha256 !== binding.definitionSha256
    )
      return false;
    if (binding.gpu !== "none") {
      // Verify the exact capability the GPU watchdog will need once a call exists.
      if (!client.cpClient.functionCallFetch) return false;
      await gpuInputs(client, binding.functionId);
    }
    return true;
  };
  async function gpuInputs(client: SdkClient, functionId: string) {
    const api = client.cpClient;
    if (!api?.functionCallFetch) throw new Error("GPU watchdog unavailable");
    return (
      await api.functionCallFetch({
        functionId,
        tail: { count: 10 },
        allVariants: true,
      })
    ).functionCallInputs;
  }
  return {
    async watchGpuCall(callId: string, binding: ModalRerunBinding) {
      return bounded(
        "GPU watchdog",
        settings.apiTimeoutMs,
        sdk().then(async ({ client }) => {
          const inputs = await gpuInputs(client, binding.functionId);
          return inputs.flatMap((input) =>
            input.functionCallId === callId && input.containerId
              ? [input.containerId]
              : [],
          );
        }),
      );
    },
    async checkFunction(module: string, binding: ModalRerunBinding) {
      try {
        return await bounded(
          "inspect immutable function",
          settings.apiTimeoutMs,
          sdk().then(({ client }) => verify(client, module, binding)),
        );
      } catch {
        return false;
      }
    },
    async spawn(
      bootstrap: ModalBootstrap,
      canSubmit: () => boolean,
      binding?: ModalRerunBinding,
    ): Promise<string> {
      const clipPlan =
        bootstrap.schemaVersion === 1 &&
        bootstrap.pipeline === "clip_plan_cpu_v1";
      if (clipPlan && (!binding || binding.gpu !== "none"))
        throw new ModalSpawnNotSent();
      const deadline = performance.now() + settings.apiTimeoutMs;
      // SA-91: a stage bootstrap names its module; each module has its own deployed function.
      // The sealing hand_pose stage keeps the v1 `run-job` shape (and the hand-pose function).
      const functionName =
        bootstrap.schemaVersion === 2
          ? modalFunctionFor(settings, bootstrap.module)
          : settings.functionName;
      if (functionName === undefined && !binding) throw new ModalSpawnNotSent();
      const appName =
        bootstrap.schemaVersion === 2
          ? modalAppFor(settings, bootstrap.module)
          : settings.appName;
      let issued = false;
      let expired = false;
      try {
        return await bounded(
          "spawn",
          settings.apiTimeoutMs,
          (async () => {
            const { client } = await sdk();
            let fn: SdkFunction | undefined;
            if (binding) {
              try {
                const module =
                  "module" in bootstrap
                    ? bootstrap.module
                    : clipPlan
                      ? HAND_POSE_MODULE
                      : undefined;
                if (!module || !(await verify(client, module, binding)))
                  throw new ModalSpawnNotSent();
                fn = await client.functions.fromId?.(binding.functionId);
              } catch {
                throw new ModalSpawnNotSent();
              }
            } else {
              fn = await client.functions.fromName(
                appName,
                functionName!,
                settings.environmentName === undefined
                  ? undefined
                  : { environment: settings.environmentName },
              );
            }
            if (!fn || (binding && fn.functionId !== binding.functionId))
              throw new ModalSpawnNotSent();
            // One JSON argument keeps the bootstrap out of argv, env and logs.
            const args = [JSON.stringify(bootstrap)];
            if (expired || performance.now() >= deadline || !canSubmit())
              throw new ModalSpawnNotSent();
            issued = true;
            const call = await fn.spawn(args);
            return call.functionCallId;
          })(),
          () => {
            expired = true;
          },
        );
      } catch (error) {
        if (!issued && error instanceof ModalOperationTimeout)
          throw new ModalSpawnNotSent();
        throw error;
      }
    },
    async poll(callId: string): Promise<CallObservation> {
      let loaded: { mod: SdkModule; client: SdkClient };
      try {
        loaded = await sdk();
      } catch {
        return { kind: "unavailable", detail: "sdk_unavailable" };
      }
      const { mod, client } = loaded;
      try {
        const value = await bounded(
          "poll",
          POLL_WINDOW_MS + settings.apiTimeoutMs,
          (async () => {
            const call = await client.functionCalls.fromId(callId);
            return call.get({ timeoutMs: POLL_WINDOW_MS });
          })(),
        );
        return { kind: "returned", value };
      } catch (error) {
        if (error instanceof ModalOperationTimeout)
          return { kind: "unavailable", detail: "operation_timeout" };
        // Order matters: TimeoutError (our wait elapsed) before FunctionTimeoutError.
        if (error instanceof mod.TimeoutError)
          return { kind: "pending", detail: "poll_timeout" };
        if (error instanceof mod.FunctionTimeoutError)
          return { kind: "unavailable", detail: "function_timeout" };
        // Class name only: never the message (it may carry provider payload).
        return {
          kind: "unavailable",
          detail: error instanceof Error ? error.name : "unknown_error",
        };
      }
    },
    async cancel(callId: string): Promise<void> {
      await bounded(
        "cancel",
        settings.apiTimeoutMs,
        (async () => {
          const { client } = await sdk();
          const call = await client.functionCalls.fromId(callId);
          await call.cancel({ terminateContainers: true });
        })(),
      );
    },
    close(): void {
      const pending = cached;
      cached = undefined;
      void pending?.then(({ client }) => client.close()).catch(() => undefined);
    },
  };
}
