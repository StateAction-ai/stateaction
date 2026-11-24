import type { ClipListItem } from "@stateaction/contracts";

export function isCurrentImport({
  liveJobId,
  selectedResult,
}: Pick<ClipListItem, "liveJobId" | "selectedResult">): boolean {
  return (
    selectedResult?.source === "imported" &&
    (liveJobId === null || liveJobId === selectedResult.jobId)
  );
}
