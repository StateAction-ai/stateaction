import { Spinner } from "../ui/spinner";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  OctagonX,
  UploadCloud,
  XCircle,
} from "lucide-react";
import {
  PIPELINE_STATUS_LABEL,
  type PipelineStatus,
} from "@stateaction/server/pipeline-model";
import { cn } from "../../lib/utils";

const STYLE: Record<PipelineStatus, string> = {
  completed: "bg-[#e9f6ef] text-good",
  processing: "bg-brand-soft text-brand-ink",
  uploading: "bg-brand-soft text-brand-ink",
  failed: "bg-danger-soft text-danger",
  needs_attention: "bg-[#fff4de] text-[#8a5a00]",
  queued: "bg-[#eef0ec] text-[#4d5a54]",
  cancelled: "bg-[#eef0ec] text-[#4d5a54]",
};
const ICON = {
  completed: CheckCircle2,
  processing: Spinner,
  uploading: UploadCloud,
  failed: XCircle,
  needs_attention: AlertTriangle,
  queued: CircleDashed,
  cancelled: OctagonX,
} as const;

/** Status is always text plus an icon, never colour alone. */
export function StatusBadge({
  status,
  className,
}: {
  status: PipelineStatus;
  className?: string;
}) {
  const Icon = ICON[status];
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold",
        STYLE[status],
        className,
      )}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      {PIPELINE_STATUS_LABEL[status]}
    </span>
  );
}
