/**
 * Display-name rules shared by the Settings form (browser) and the guarded
 * own-profile endpoint (server). This module is pure and has no server-only
 * imports so a Client Component can use it; the server is authoritative and
 * the browser check only saves a round trip. A display name is untrusted text
 * for display: it never carries authority.
 */
export const DISPLAY_NAME_MAX = 80;

export type DisplayNameResult =
  | { ok: true; value: string }
  | { ok: false; reason: "required" | "too_long" | "invalid_characters" };

// C0/C1 controls, bidi overrides/isolates, zero-width and line/paragraph separators.
const FORBIDDEN = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]",
  "u",
);

export function parseDisplayName(input: unknown): DisplayNameResult {
  if (typeof input !== "string") return { ok: false, reason: "required" };
  const value = input.normalize("NFC").trim();
  if (value.length === 0) return { ok: false, reason: "required" };
  if (FORBIDDEN.test(value)) return { ok: false, reason: "invalid_characters" };
  if ([...value].length > DISPLAY_NAME_MAX)
    return { ok: false, reason: "too_long" };
  return { ok: true, value };
}

export const DISPLAY_NAME_MESSAGES = {
  required: "Enter a display name.",
  too_long: `Use at most ${DISPLAY_NAME_MAX} characters.`,
  invalid_characters: "Remove control or invisible characters.",
} as const;
