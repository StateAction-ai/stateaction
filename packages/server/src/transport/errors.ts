export type TransportErrorCode =
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "payload_too_large"
  | "unsupported_media_type"
  /** Provider failed or timed out; nothing was recorded that hides it. Retryable. */
  | "provider_unavailable"
  /** Provider state cannot be resolved without operator/SA-21 reconciliation. */
  | "provider_ambiguous";

export class TransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TransportError";
  }
  get status(): number {
    return STATUS[this.code];
  }
  get retryable(): boolean {
    return this.code === "provider_unavailable";
  }
}
const STATUS: Record<TransportErrorCode, number> = {
  invalid_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  provider_unavailable: 503,
  provider_ambiguous: 409,
};
