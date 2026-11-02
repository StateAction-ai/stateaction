"use client";
import { useState } from "react";
import { clientHeaders } from "./client-header";
export function SignOutButton() {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  async function signOut() {
    setState("busy");
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: clientHeaders,
        body: "{}",
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("sign-out failed");
      window.location.replace("/login");
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="actions">
      <button type="button" onClick={signOut} disabled={state === "busy"}>
        {state === "busy" ? "Signing out…" : "Sign out"}
      </button>
      {state === "failed" ? (
        <p role="alert" className="error">
          Sign-out did not complete. Your session is still active; try again.
        </p>
      ) : null}
    </div>
  );
}
