"use client";
import * as React from "react";
import { clearPrivateState } from "../../lib/private-state";

export type SignOutStatus = "idle" | "pending" | "failed";

interface SignOutValue {
  status: SignOutStatus;
  signOut: () => Promise<void>;
  dismiss: () => void;
}

const SignOutContext = React.createContext<SignOutValue | null>(null);

/**
 * Drives sign-out. `revoke` must throw/reject unless the SERVER confirmed the
 * session is revoked. Only then are private browser caches cleared and the page
 * replaced with /login (a full navigation drops all in-memory state, and the
 * login page is public so Back lands on guarded routes that re-check the session).
 */
export function SignOutProvider({
  revoke,
  redirect = (to) => window.location.replace(to),
  children,
}: {
  revoke: () => Promise<void>;
  redirect?: (to: string) => void;
  children: React.ReactNode;
}) {
  const [status, setStatus] = React.useState<SignOutStatus>("idle");
  const inFlight = React.useRef(false);
  const signOut = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStatus("pending");
    try {
      await revoke();
    } catch {
      inFlight.current = false;
      setStatus("failed");
      return;
    }
    clearPrivateState();
    redirect("/login");
  }, [revoke, redirect]);
  const dismiss = React.useCallback(() => setStatus("idle"), []);
  const value = React.useMemo(
    () => ({ status, signOut, dismiss }),
    [status, signOut, dismiss],
  );
  return (
    <SignOutContext.Provider value={value}>{children}</SignOutContext.Provider>
  );
}

export function useSignOut(): SignOutValue {
  const value = React.useContext(SignOutContext);
  if (!value) throw new Error("useSignOut requires SignOutProvider");
  return value;
}

export function SignOutStatusBanner() {
  const { status, signOut, dismiss } = useSignOut();
  return (
    <div aria-live="polite" role="status" className="contents">
      {status === "pending" ? (
        <p className="px-4 py-2 text-xs text-muted sm:px-6">Signing out…</p>
      ) : null}
      {status === "failed" ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 border-b border-[#edc8cc] bg-danger-soft px-4 py-3 text-xs text-danger sm:px-6"
        >
          <span>
            We could not confirm that your session ended. You are still signed
            in. Nothing was cleared.
          </span>
          <button
            type="button"
            onClick={() => void signOut()}
            className="min-h-9 rounded-md border border-[#edc8cc] bg-white px-3 font-semibold"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="min-h-9 rounded-md px-3 font-semibold underline"
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
