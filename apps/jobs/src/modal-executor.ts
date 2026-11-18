import { CALL_ID } from "./journal.js";

/**
 * SA-42 Modal executor seam. The controller talks to Modal ONLY through this
 * interface; a fake implements it in tests and a thin adapter over the official
 * SDK implements it in production (`modal-sdk.ts`). The processing container
 * never sees a Modal credential.
 */

/** Scoped bootstrap handed to the Modal function as its single spawn argument (JSON string). */
export type ModalBootstrap = {
  schemaVersion: 1;
  apiUrl: string;
  jobId: string;
  bootstrapToken: string;
  /** Modal runs the production pipeline only. */
  pipeline: "hand_pose_cpu_v1";
};

/**
 * What the thin wrapper returns after the shared CLI has exited and been reaped
 * inside the container. It is the ONLY value that can prove a terminal call.
 */
export type ModalRunResult = {
  schemaVersion: 1;
  functionCallId: string;
  exitCode: number;
};

/**
 * One bounded observation of a call. Only `returned` can ever lead to
 * `provider_call_terminal` evidence, and only after `parseRunResult` accepts the
 * value for the exact recorded call. A poll timeout, a function timeout, a
 * cancelled/failed/internal error or a lost connection is NEVER terminal proof.
 */
export type CallObservation =
  | { kind: "pending"; detail: string }
  | { kind: "unavailable"; detail: string }
  | { kind: "returned"; value: unknown };

/** The adapter stopped before invoking the provider spawn. */
export class ModalSpawnNotSent extends Error {
  constructor() {
    super("modal spawn blocked by its bound or controller authorization");
    this.name = "ModalSpawnNotSent";
  }
}

export interface ModalClient {
  /**
   * Spawn one call and resolve its provider call ID. Check authorization immediately
   * before invoking the provider. A rejected spawn never authorizes a retry.
   */
  spawn(bootstrap: ModalBootstrap, canSubmit: () => boolean): Promise<string>;
  /** Bounded observation (never waits longer than the adapter's poll window). */
  poll(callId: string): Promise<CallObservation>;
  /** A cancel REQUEST with container termination. Returning is not proof of anything. */
  cancel(callId: string): Promise<void>;
  /** Release client resources when the controller entry settles. Never throws. */
  close?(): void;
}

/** Strict: exact keys, the exact call this controller recorded, a small integer exit code. */
export function parseRunResult(
  value: unknown,
  callId: string,
): ModalRunResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (
    keys.length !== 3 ||
    !keys.every((k) =>
      ["schemaVersion", "functionCallId", "exitCode"].includes(k),
    )
  )
    return undefined;
  if (v.schemaVersion !== 1) return undefined;
  if (
    typeof v.functionCallId !== "string" ||
    !CALL_ID.test(v.functionCallId) ||
    v.functionCallId !== callId
  )
    return undefined;
  if (
    typeof v.exitCode !== "number" ||
    !Number.isSafeInteger(v.exitCode) ||
    Math.abs(v.exitCode) > 255
  )
    return undefined;
  return {
    schemaVersion: 1,
    functionCallId: v.functionCallId,
    exitCode: v.exitCode,
  };
}
