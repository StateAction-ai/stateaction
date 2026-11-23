"use client";

import { useState } from "react";
import { Button } from "../ui/button";

/** Renders the server-rendered http.dag-run.v1 document, with Copy and Download. */
export function DagRunPanel({
  json,
  filename,
}: {
  json: string;
  filename: string;
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
        <h2 className="m-0 font-mono text-base font-bold">dag-run.json</h2>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={copy}>
            {copied === "copied"
              ? "Copied"
              : copied === "failed"
                ? "Copy failed"
                : "Copy"}
          </Button>
          <Button type="button" variant="outline" onClick={download}>
            Download
          </Button>
        </div>
      </div>
      <pre
        data-testid="dag-run-json"
        tabIndex={0}
        aria-label="dag-run.json"
        className="m-0 max-h-[640px] overflow-auto border-t border-line bg-field px-5 py-4 font-mono text-[11.5px] leading-relaxed"
      >
        {json}
      </pre>
      <p className="m-0 border-t border-line px-5 py-3 text-xs text-muted">
        Rendered by the server from the recorded stage runs (http.dag-run.v1).
        Cost figures are estimates, not billing.
      </p>
    </div>
  );
}
