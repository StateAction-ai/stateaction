import type { SaveResult } from "../components/settings-form";
import { privateSignal } from "./private-state";

/**
 * Browser transport. Every call hits the SAME Better Auth session as the rest
 * of the app (same-origin cookies, no tokens in JS) and carries the
 * X-StateAction-Client header the server requires on mutations.
 */
const JSON_HEADERS = {
  "Content-Type": "application/json",
  "X-StateAction-Client": "web",
} as const;

/**
 * Resolves only when the SERVER confirmed the session is gone: Better Auth
 * accepted the sign-out AND the same cookie is then refused by /api/v1/me.
 * Any other outcome (network error, non-2xx, still signed in) rejects so the
 * caller keeps private state and offers a retry.
 */
export async function revokeSession(): Promise<void> {
  const response = await fetch("/api/auth/sign-out", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: JSON_HEADERS,
    body: "{}",
  });
  if (!response.ok) throw new Error(`sign-out failed: ${response.status}`);
  const check = await fetch("/api/v1/me", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (check.status !== 401) throw new Error("session still active");
}

export async function saveDisplayName(name: string): Promise<SaveResult> {
  const response = await fetch("/api/v1/me/profile", {
    method: "PATCH",
    credentials: "same-origin",
    cache: "no-store",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
    signal: privateSignal(),
  }).catch(() => null);
  if (!response) return { ok: false, code: "unavailable" };
  if (response.status === 401) return { ok: false, code: "unauthenticated" };
  if (response.status === 422) return { ok: false, code: "invalid" };
  if (response.status === 403) return { ok: false, code: "stale" };
  if (!response.ok) return { ok: false, code: "unavailable" };
  const body: unknown = await response.json().catch(() => null);
  const saved =
    typeof body === "object" && body !== null && "data" in body
      ? (body as { data?: { user?: { name?: unknown } } }).data?.user?.name
      : undefined;
  return typeof saved === "string"
    ? { ok: true, name: saved }
    : { ok: false, code: "unavailable" };
}
