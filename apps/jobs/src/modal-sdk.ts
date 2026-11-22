import {
  modalCredentials,
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
type SdkFunction = { spawn(args?: unknown[]): Promise<SdkCall> };
type SdkClient = {
  close(): void;
  functions: {
    fromName(
      app: string,
      name: string,
      params?: { environment?: string },
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
  return {
    async spawn(
      bootstrap: ModalBootstrap,
      canSubmit: () => boolean,
    ): Promise<string> {
      const deadline = performance.now() + settings.apiTimeoutMs;
      // SA-91: a stage bootstrap names its module; each module has its own deployed function.
      // The sealing hand_pose stage keeps the v1 `run-job` shape (and the hand-pose function).
      const functionName =
        bootstrap.schemaVersion === 2
          ? modalFunctionFor(settings, bootstrap.module)
          : settings.functionName;
      if (functionName === undefined) throw new ModalSpawnNotSent();
      let issued = false;
      let expired = false;
      try {
        return await bounded(
          "spawn",
          settings.apiTimeoutMs,
          (async () => {
            const { client } = await sdk();
            const fn = await client.functions.fromName(
              settings.appName,
              functionName,
              settings.environmentName === undefined
                ? undefined
                : { environment: settings.environmentName },
            );
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
