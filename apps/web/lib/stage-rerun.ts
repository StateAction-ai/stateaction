import type { Stage } from "@stateaction/contracts";

export const RERUN_STAGE_LABEL: Record<Stage, string> = {
  segment: "Segmentation",
  caption: "Captioning",
  hand_pose: "Hand pose",
};

const REASONS: Record<string, string> = {
  requires_caption_rerun:
    "Caption depends on segmentation. Choose Re-run from here to run both.",
  read_only: "Run changes are disabled in the read-only preview.",
  parent_unavailable: "The parent run is unavailable.",
  clip_rerun_unavailable:
    "Stage reruns are available for legacy recording jobs.",
  rerun_unavailable:
    "Rerun eligibility could not be checked. Reload to try again.",
  import_source_unavailable:
    "This cached import has no sealed source authorized for processing.",
  recording_busy: "This recording already has an active run.",
  parent_not_terminal: "Wait for this run to finish.",
  parent_recipe_unavailable:
    "This run has no recipe or reusable import evidence.",
  recording_not_processable:
    "This recording needs an active processing grant for its sealed source.",
  stage_configuration_invalid:
    "Choose a module version and parameters supported by this stage.",
  cost_cap_exceeded: "This plan exceeds the job's spend cap.",
  termination_unproven:
    "The previous execution has not been confirmed stopped.",
  stage_disabled: "This stage was disabled in the parent recipe.",
  reuse_unavailable: "A required parent output or receipt is unavailable.",
  hand_result_unavailable: "This scope requires an accepted hand-pose result.",
  segments_unavailable: "Caption needs successful non-empty segments.",
  cost_cap_missing: "There is no available spend authorization for this run.",
  rerun_outside_admission_scope:
    "The active processing configuration does not admit this stage rerun.",
  deployment_binding_unavailable:
    "The planned module has no verified deployment.",
  plan_changed: "The plan changed. Preview it again before confirming.",
};

export function rerunReason(code: string): string {
  return REASONS[code] ?? code;
}
