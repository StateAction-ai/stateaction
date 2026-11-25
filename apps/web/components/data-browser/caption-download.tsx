"use client";

import { useState } from "react";
import { clientHeaders } from "../../app/client-header";
import { privateSignal } from "../../lib/private-state";
import { Button } from "../ui/button";
import { readBounded } from "./client";

export function CaptionDownload({ href }: { href: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function download() {
    const signal = AbortSignal.any([
      privateSignal(),
      AbortSignal.timeout(60_000),
    ]);
    setBusy(true);
    setError("");
    try {
      const response = await fetch(href, {
        cache: "no-store",
        redirect: "error",
        headers: clientHeaders,
        signal,
      });
      if (!response.ok) {
        setError(
          response.status === 422
            ? "Too many captions to download. Narrow the dataset filters."
            : "Captions could not be downloaded. Refresh and try again.",
        );
        return;
      }
      const bytes = await readBounded(response, 8 * 1024 * 1024);
      if (signal.aborted) return;
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "captions.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError("Captions could not be downloaded. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant="outline" disabled={busy} onClick={() => void download()}>
        {busy ? "Downloading…" : "Download captions"}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}
