import { createHash } from "node:crypto";

/**
 * sa-cjson-v1: the exact request-digest encoding documented in README.md.
 * Domain: null, booleans, safe integers, well-formed strings, arrays, objects.
 * Fractional or unsafe numbers and lone surrogates are rejected, never rounded.
 */
export class NoncanonicalValueError extends TypeError {
  readonly code = "noncanonical_value";
}

const SHORT: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

export function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function encodeString(value: string): string {
  if (!isWellFormed(value))
    throw new NoncanonicalValueError("String contains a lone surrogate");
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    out +=
      SHORT[ch] ??
      (code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : ch);
  }
  return `${out}"`;
}

function compareUtf16(a: string, b: string): number {
  // JavaScript string comparison is by UTF-16 code units.
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new NoncanonicalValueError("Only safe integers are canonical");
    return value === 0 ? "0" : String(value);
  }
  if (typeof value === "string") return encodeString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort(compareUtf16);
    return `{${keys
      .map(
        (key) =>
          `${encodeString(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new NoncanonicalValueError(`Unsupported value type ${typeof value}`);
}

export class MalformedJsonError extends TypeError {
  readonly code = "malformed_json";
}

/** Parse JSON text strictly, then return its sa-cjson-v1 encoding. */
export function canonicalJsonText(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new MalformedJsonError("Invalid JSON text");
  }
  return canonicalJson(value);
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** SHA-256 of the sa-cjson-v1 encoding: the idempotency request digest. */
export function requestSha256(value: unknown): string {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}

export type ReplayDecision = "replay" | "idempotency_conflict";

/** Compare a retried request with the digest stored for its idempotency scope. */
export function classifyReplay(
  storedSha256: string,
  request: unknown,
): ReplayDecision {
  return requestSha256(request) === storedSha256
    ? "replay"
    : "idempotency_conflict";
}

/** Manifests are hashed over their exact stored bytes, never a re-encoding. */
export function verifyStoredBytes(
  bytes: Uint8Array,
  declaredSha256: string,
): "match" | "digest_mismatch" {
  return sha256Hex(bytes) === declaredSha256 ? "match" : "digest_mismatch";
}
