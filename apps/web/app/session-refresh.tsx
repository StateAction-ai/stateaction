"use client";
import { useEffect } from "react";

/** At most one background refresh per interval while the page stays open. */
const INTERVAL_MS = 10 * 60 * 1000;

/**
 * Server Components read the session without extending it, because they
 * cannot set cookies. This asks GET /api/v1/me (a route handler, which
 * forwards Better Auth's refreshed Set-Cookie) once per page load and when the
 * tab becomes visible again, so the session row and the cookie's Max-Age move
 * forward together. A signed-out answer sends the user to /login.
 */
export function SessionRefresh() {
  useEffect(() => {
    let last = 0;
    let stopped = false;
    async function refresh() {
      if (stopped || Date.now() - last < INTERVAL_MS) return;
      last = Date.now();
      try {
        const response = await fetch("/api/v1/me", {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (response.status === 401 && !stopped)
          window.location.replace("/login");
      } catch {
        // Offline or unavailable: the next visit or page load retries.
      }
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}
