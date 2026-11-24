"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/button";

export function SelectResult({
  recordingId,
  jobId,
  sequence,
  inPipeline = false,
}: {
  recordingId: string;
  jobId: string;
  sequence: number;
  inPipeline?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function select() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/recordings/${recordingId}/result-selection`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-stateaction-client": "web",
          },
          body: JSON.stringify({
            jobId,
            expectedSelectionSeq: sequence,
            reason: "Selected from run history",
          }),
        },
      );
      if (!response.ok) {
        setError(
          response.status === 409
            ? "The selected result changed. Reload and try again."
            : "Could not select this result.",
        );
        return;
      }
      if (!inPipeline) router.replace(`/review/${recordingId}`);
      router.refresh();
    } catch {
      setError(
        "Could not read the selection response. Reload to see the selected result.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <span>
      <Button
        type="button"
        variant="outline"
        className="px-2 py-1 text-xs"
        disabled={busy}
        onClick={() => void select()}
      >
        Select this result
      </Button>
      {error ? (
        <span className="ml-2 text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
