import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  HelpCircle,
  Loader2,
  MinusCircle,
  OctagonX,
} from "lucide-react";
import {
  STAGE_STATE_LABEL,
  type Stage,
  type StageState,
} from "@stateaction/server/pipeline";
import { cn } from "../../lib/utils";

const ICON: Record<StageState, typeof CheckCircle2> = {
  done: CheckCircle2,
  active: Loader2,
  failed: AlertCircle,
  cancelled: OctagonX,
  unknown: HelpCircle,
  not_started: CircleDashed,
  blocked: MinusCircle,
};
const TONE: Record<StageState, string> = {
  done: "text-good",
  active: "text-brand",
  failed: "text-danger",
  cancelled: "text-muted",
  unknown: "text-[#8a5a00]",
  not_started: "text-muted",
  blocked: "text-muted",
};

/** Conceptual progress stages; text and icon carry the state, not colour. */
export function StageList({ stages }: { stages: Stage[] }) {
  return (
    <ol className="m-0 grid list-none grid-cols-1 gap-2.5 p-0 sm:grid-cols-2 lg:grid-cols-5">
      {stages.map((stage) => {
        const Icon = ICON[stage.state];
        return (
          <li
            key={stage.key}
            className="rounded-lg border border-line bg-field px-3 py-2.5"
          >
            <div className="flex items-center gap-2 text-[13px] font-semibold">
              <Icon
                aria-hidden="true"
                className={cn("h-4 w-4 shrink-0", TONE[stage.state])}
              />
              {stage.label}
            </div>
            <p className="m-0 mt-1 text-[11px] text-muted">
              {STAGE_STATE_LABEL[stage.state]}
              {stage.detail ? ` · ${stage.detail}` : ""}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
