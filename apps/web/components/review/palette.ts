import type { Hand } from "../../lib/review/types";

/** Segment colours by derived hand (from the approved mock). `sat` is the selected block. */
export const HAND_COLORS: Record<
  Hand,
  { ink: string; bg: string; sat: string }
> = {
  left: { ink: "#2f7fd0", bg: "#d6e9fb", sat: "#55b6ff" },
  right: { ink: "#c23d82", bg: "#fbdcec", sat: "#f472b6" },
  both: { ink: "#7a4fd6", bg: "#e6dcfb", sat: "#a78bfa" },
  none: { ink: "#5f6b65", bg: "#e6eae4", sat: "#9aa39e" },
};

export const HAND_ORDER: Hand[] = ["left", "right", "both", "none"];
