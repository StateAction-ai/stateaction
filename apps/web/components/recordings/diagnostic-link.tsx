"use client";

import { useState } from "react";

/**
 * A stage diagnostic file. The signed URL is requested only on click (staff
 * POST, valid for about a minute) and opened in a new tab; it is never part of
 * the rendered HTML and is not kept after opening.
 */
export function DiagnosticLink({ name, href }: { name: string; href: string }) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  async function open() {
    setState("busy");
    try {
      const response = await fetch(href, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-stateaction-client": "web",
        },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await response.json()) as { data?: { url?: unknown } };
      if (!response.ok || typeof body.data?.url !== "string")
        throw new Error("not issued");
      window.open(body.data.url, "_blank", "noopener,noreferrer");
      setState("idle");
    } catch {
      setState("failed");
    }
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => void open()}
        disabled={state === "busy"}
        className="inline-flex min-h-6 min-w-6 cursor-pointer items-center border-0 bg-transparent p-0 font-mono text-xs text-brand underline"
        data-testid="diagnostic-link"
      >
        {name}
      </button>
      {state === "failed" ? (
        <span role="alert" className="text-danger">
          link unavailable
        </span>
      ) : null}
    </span>
  );
}
