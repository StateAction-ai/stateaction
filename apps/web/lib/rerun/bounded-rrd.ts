// Bounded, credential-free fetch of one authorized clip RRD.
//
// Framework independent and free of the viewer package so it is unit-testable
// in plain Node. The caller supplies a URL that the server issued for exactly
// this clip; this module never mints, widens or persists one.

export type ClipSourceErrorCode =
  | "origin_not_allowed"
  | "expired"
  | "unavailable"
  | "too_large"
  | "bad_content_type"
  | "not_rrd"
  | "aborted";

export class ClipSourceError extends Error {
  readonly code: ClipSourceErrorCode;
  constructor(code: ClipSourceErrorCode, message: string) {
    super(message);
    this.name = "ClipSourceError";
    this.code = code;
  }
}

/** Every RRD written by the pinned SDK starts with this container magic. */
export const RRD_MAGIC = "RRF2";
export const DEFAULT_MAX_RRD_BYTES = 128 * 1024 * 1024;

// Object stores answer an expired or invalid signature with 401/403 (and some
// with 410). The caller reacts by asking the server for a fresh URL.
const EXPIRED_STATUSES = new Set([401, 403, 410]);
const ALLOWED_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-rerun",
  "application/vnd.rerun.rrd",
]);

export interface FetchBoundedOptions {
  /** Origins (scheme://host[:port]) the server may point the browser at. */
  allowedOrigins: readonly string[];
  maxBytes?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function assertAllowedOrigin(
  url: string,
  allowedOrigins: readonly string[],
): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ClipSourceError("origin_not_allowed", "Clip URL is not valid.");
  }
  const secure =
    parsed.protocol === "https:" ||
    (parsed.protocol === "http:" && LOOPBACK.has(parsed.hostname));
  if (!secure || !allowedOrigins.includes(parsed.origin)) {
    throw new ClipSourceError(
      "origin_not_allowed",
      "Clip URL origin is not an allowed storage origin.",
    );
  }
  return parsed;
}

export async function fetchBoundedRrd(
  url: string,
  options: FetchBoundedOptions,
): Promise<Blob> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RRD_BYTES;
  const parsed = assertAllowedOrigin(url, options.allowedOrigins);
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(parsed.href, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw new ClipSourceError("aborted", "Clip load was cancelled.");
    }
    throw new ClipSourceError(
      "unavailable",
      `Clip could not be fetched: ${error instanceof Error ? error.message : "network error"}`,
    );
  }
  if (EXPIRED_STATUSES.has(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    throw new ClipSourceError("expired", "Clip link has expired.");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ClipSourceError(
      "unavailable",
      `Clip storage answered ${response.status}.`,
    );
  }
  const type = (response.headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (type && !ALLOWED_TYPES.has(type)) {
    await response.body?.cancel().catch(() => undefined);
    throw new ClipSourceError(
      "bad_content_type",
      `Unexpected clip content type ${type}.`,
    );
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ClipSourceError("too_large", "Clip exceeds the size limit.");
  }
  if (!response.body) {
    throw new ClipSourceError("unavailable", "Clip response had no body.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ClipSourceError("too_large", "Clip exceeds the size limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ClipSourceError) throw error;
    if (options.signal?.aborted) {
      throw new ClipSourceError("aborted", "Clip load was cancelled.");
    }
    throw new ClipSourceError("unavailable", "Clip download was interrupted.");
  }
  // Network chunks may split the magic, so inspect the assembled bytes.
  const blob = new Blob(chunks as BlobPart[], {
    type: "application/octet-stream",
  });
  if ((await blob.slice(0, 4).text()) !== RRD_MAGIC) {
    throw new ClipSourceError("not_rrd", "Clip is not a Rerun recording.");
  }
  return blob;
}
