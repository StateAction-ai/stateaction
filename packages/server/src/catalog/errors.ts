export type CatalogErrorCode =
  | "conflict"
  | "idempotency_conflict"
  | "not_found"
  | "forbidden"
  | "invalid_request";

/** Typed catalog failure; `code` aligns with the v1 HTTP error codes. */
export class CatalogError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
    readonly sqlstate?: string,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

const SQLSTATE: Record<string, CatalogErrorCode> = {
  SAC01: "conflict", // immutable/append-only
  SAC02: "conflict", // clip not approved
  SAC03: "conflict", // stale revision/sequence
  SAC04: "conflict", // lifecycle state
  SAC05: "forbidden",
  "23505": "conflict", // unique_violation
  "23503": "invalid_request", // foreign_key_violation
  "23514": "invalid_request", // check_violation
  "23502": "invalid_request", // not_null_violation
  "22P02": "invalid_request", // invalid_text_representation
  "40P01": "conflict", // deadlock_detected (should not occur with lock order)
  "55P03": "conflict", // lock_not_available (lock_timeout): safe to retry
};

export function toCatalogError(error: unknown): unknown {
  if (error instanceof CatalogError) return error;
  const state = (error as { code?: unknown })?.code;
  if (typeof state === "string" && SQLSTATE[state])
    return new CatalogError(SQLSTATE[state], (error as Error).message, state);
  return error;
}
