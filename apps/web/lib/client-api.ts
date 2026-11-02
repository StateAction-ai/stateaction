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

export type JobControlOutcome =
  | {
      ok: true;
      state: string;
      retryJobId: string | null;
      replayed: boolean;
      instruction: string;
    }
  | {
      ok: false;
      code: "stale" | "refused" | "forbidden" | "unavailable";
      message: string;
    };

const CONTROL_TIMEOUT_MS = 15_000;
const CONTROL_MAX_BYTES = 16 * 1024;

/** Reads at most CONTROL_MAX_BYTES; anything larger is treated as unusable. */
async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CONTROL_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// Curated copy: server text is never shown, only mapped by its stable reason prefix.
const REFUSAL_COPY: Record<string, string> = {
  stale_current_job:
    "A newer job exists for this recording. The page was refreshed.",
  stale_state:
    "The job changed since this page loaded. The page was refreshed.",
  not_terminal:
    "Cancellation is requested but the execution has not been confirmed stopped, so retry is not available yet.",
  termination_unproven:
    "The execution has not been confirmed stopped, so retry is not available.",
  source_reupload_required:
    "The source bytes failed verification. Ask the collector for corrected source.",
  already_retried: "This attempt was already retried.",
  request_id_in_use:
    "This request conflicts with an earlier one. Reload the page.",
  recording_not_processable: "This recording can no longer be processed.",
};

/**
 * Staff job control (cancel / retry / reconcile). Finite time, finite body,
 * no redirects. The server refuses a stale job or state without mutating; a
 * lost response is safe to repeat with the SAME requestId because retry's
 * requestId is the new job's ID.
 */
export async function submitJobControl(command: {
  requestId: string;
  action: "cancel" | "retry" | "reconcile";
  jobId: string;
  expectedState: string;
}): Promise<JobControlOutcome> {
  const response = await fetch(`/api/v1/jobs/${command.jobId}/control`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: JSON_HEADERS,
    body: JSON.stringify(command),
    signal: AbortSignal.any([
      privateSignal(),
      AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    ]),
  }).catch(() => null);
  if (!response)
    return {
      ok: false,
      code: "unavailable",
      message: "No response. It is safe to try again.",
    };
  const body = (await readBoundedJson(response).catch(() => null)) as {
    data?: Record<string, unknown>;
    error?: { message?: unknown };
  } | null;
  const data = body?.data;
  if (response.ok && data && typeof data.state === "string") {
    const guidance = data.guidance as { instruction?: unknown } | undefined;
    return {
      ok: true,
      state: data.state,
      retryJobId: typeof data.retryJobId === "string" ? data.retryJobId : null,
      replayed: data.replayed === true,
      instruction:
        typeof guidance?.instruction === "string" ? guidance.instruction : "",
    };
  }
  if (response.status === 403)
    return {
      ok: false,
      code: "forbidden",
      message: "This account cannot perform that action.",
    };
  if (response.status === 409) {
    const raw = body?.error?.message;
    const reason =
      typeof raw === "string" ? (/^([a-z_]+):/.exec(raw)?.[1] ?? "") : "";
    return {
      ok: false,
      code: /^stale_/.test(reason) ? "stale" : "refused",
      message: REFUSAL_COPY[reason] ?? "The action was not accepted.",
    };
  }
  return {
    ok: false,
    code: "unavailable",
    message: "The job service is unavailable. Try again.",
  };
}
