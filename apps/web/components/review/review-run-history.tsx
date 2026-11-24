import Link from "next/link";
import type { pipelineReads } from "@stateaction/server/pipeline";
import { SelectResult } from "../pipeline/select-result";

type History = Awaited<ReturnType<ReturnType<typeof pipelineReads>["history"]>>;

export function ReviewRunHistory({
  recordingId,
  history,
  selectionEnabled,
}: {
  recordingId: string;
  history: History;
  selectionEnabled: boolean;
}) {
  if (history.runs.length < 2) return null;
  return (
    <details className="mb-4 rounded-lg border border-line px-4 py-2 text-sm">
      <summary className="font-semibold">Run history</summary>
      <ul className="m-0 mt-2 grid list-none gap-2 p-0">
        {history.runs.map((item) => (
          <li key={item.jobId} className="flex flex-wrap items-center gap-2">
            <Link
              className="text-brand underline"
              href={
                item.state === "succeeded"
                  ? `/review/${recordingId}?run=${item.jobId}`
                  : `/pipeline/${recordingId}?run=${item.jobId}`
              }
            >
              Run {item.jobId.slice(0, 8)}
            </Link>
            <span>{item.state.replaceAll("_", " ")}</span>
            {item.selected ? (
              <strong>Selected</strong>
            ) : item.state === "succeeded" && selectionEnabled ? (
              <SelectResult
                recordingId={recordingId}
                jobId={item.jobId}
                sequence={history.selectionSeq}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
