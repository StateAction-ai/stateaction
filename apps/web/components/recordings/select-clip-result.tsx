"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/button";
import { postRecordingCommand } from "./commands";

export function SelectClipResult({
  clipId,
  expectedSelectionSeq,
  candidates,
}: {
  clipId: string;
  expectedSelectionSeq: number;
  candidates: { id: string; started: string }[];
}) {
  const router = useRouter();
  const [runId, chooseRun] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function select() {
    setBusy(true);
    setError(undefined);
    try {
      await postRecordingCommand(
        "/api/v2/review-clips/" + clipId + "/result-selection",
        { jobId: runId, reason: reason.trim(), expectedSelectionSeq },
      );
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not select this output.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="rounded-lg border border-line bg-paper p-3">
      <summary className="cursor-pointer text-sm font-semibold">
        Use output from another run
      </summary>
      <form
        className="mt-3 grid max-w-md gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void select();
        }}
      >
        <p className="text-sm text-muted">
          This changes the output that opens for this clip. Earlier outputs
          remain in its history.
        </p>
        <label className="grid gap-1 text-sm font-medium">
          Run
          <select
            required
            value={runId}
            onChange={(event) => chooseRun(event.target.value)}
            className="min-h-11 rounded-md border border-line bg-white px-2"
          >
            <option value="">Choose a run</option>
            {candidates.map(({ id, started }) => (
              <option key={id} value={id}>
                {id.slice(0, 8)} · {started}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-medium">
          Reason for switching
          <input
            required
            maxLength={512}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="min-h-11 rounded-md border border-line bg-white px-2"
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          disabled={busy || !runId || !reason.trim()}
          className="w-fit"
        >
          {busy ? "Saving…" : "Use this output"}
        </Button>
      </form>
    </details>
  );
}
