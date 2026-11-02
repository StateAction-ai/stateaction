"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { ConsoleShell } from "./shell/console-shell";
import type { ConsoleSession } from "../lib/console-session";
import { revokeSession } from "../lib/client-api";
import { SessionRefresh } from "./session-refresh";

export function ConsoleClient({
  session,
  children,
}: {
  session: ConsoleSession;
  children: React.ReactNode;
}) {
  React.useEffect(() => {
    // A page restored from the back/forward cache after sign-out must not
    // show private content: reload so the server re-checks the session.
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  return (
    <ConsoleShell session={session} revoke={revokeSession}>
      {children}
      <SessionRefresh />
    </ConsoleShell>
  );
}

export function useRefresh() {
  const router = useRouter();
  return React.useCallback(() => router.refresh(), [router]);
}
