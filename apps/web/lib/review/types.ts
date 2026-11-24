import type { RecordingAnnotations } from "@stateaction/contracts";
export type { RecordingAnnotations } from "@stateaction/contracts";
import type { Hand } from "./short-label.ts";

export type { Hand };

/** A clip of the recording (`clips.source_start_ns` / `source_end_ns`). */
export interface ClipSpan {
  clipId: string;
  startNs: string;
  endNs: string;
}

/** How the page plays the review video. */
export type VideoSource =
  /** `recording_mp4` through the broker; the client asks `readPath` for a URL. */
  | { kind: "broker"; readPath: string }
  /** No media (fixture data or a recording without recording_mp4). */
  | { kind: "none"; reason: string };

export interface ReviewRecordingSummary {
  recordingId: string;
  title: string;
  collector?: string;
  sourceSize?: string | null;
  source?: "imported";
}

export interface ReviewBundle {
  recording: ReviewRecordingSummary & { durationS: number };
  annotations: RecordingAnnotations;
  clips: ClipSpan[];
  video: VideoSource;
  /** "fixture" labels the data as synthetic everywhere it is shown. */
  origin: "fixture" | "api";
}

/** The one seam between the page and its data. */
export interface ReviewLoader {
  listRecordings(userId: string): Promise<ReviewRecordingSummary[]>;
  /** null when the recording does not exist or has no accepted job. */
  load(userId: string, recordingId: string): Promise<ReviewBundle | null>;
}

export class ReviewDataUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewDataUnavailable";
  }
}

export type CardCaption =
  | {
      state: "complete";
      text: string;
      steps: string[];
      label: string;
      hand: Hand;
    }
  /** A failed or missing caption, or a failed window: never blank. */
  | { state: "failed"; code: string; message: string };

export interface Card {
  index: number;
  segmentId: string;
  startS: number;
  endS: number;
  startFrameId: string;
  /** null: the span runs to the end of the stream. */
  endFrameId: string | null;
  kind: "segment" | "failed_window";
  caption: CardCaption;
  /** Share of the span (0..100) in which a hand was detected; null without presence data. */
  /**
   * Share of the span's covered time with a hand detected (0..100). null: no
   * hand-pose coverage of the span (unknown, never 0). partial: part of the
   * span was failed or uncovered and is excluded from the percentage.
   */
  handsLR: { left: number | null; right: number | null; partial: boolean };
  /** True when the caption's derived fields were recomputed locally (row had none). */
  derivedLocally: boolean;
}

export interface LaneSpan {
  startS: number;
  endS: number;
  state: "present" | "failed";
}

export interface FailureSpan {
  kind: "window" | "caption";
  startS: number;
  endS: number;
  code: string;
  cardIndex: number | null;
}

export interface ProvenanceBadge {
  stage: "segment" | "caption" | "hand_pose";
  /** Chip text: module@version and revision, engine and quant, observed GPU. */
  text: string;
  /** Full multi-line detail for the title attribute. */
  detail: string;
  /** replay or stub provenance is labelled as such; absent: the stage produced no document. */
  tone: "model" | "replay" | "stub" | "absent";
}

export interface ReviewModel {
  durationS: number;
  originNs: string;
  cards: Card[];
  lanes: { left: LaneSpan[]; right: LaneSpan[] };
  /** absent: no hand-presence document; the lanes are unknown, not "no hand". */
  presence: "available" | "absent";
  /** Why presence is absent (dag-run state and code), when known. */
  presenceNote: string | null;
  /** caption_rule version recorded on the caption rows, null when none carry one. */
  derivedRule: string | null;
  failures: FailureSpan[];
  handCounts: Record<Hand, number>;
  clips: { clipId: string; startS: number; endS: number }[];
  provenance: ProvenanceBadge[];
  summary: { segments: number; failedWindows: number; failedCaptions: number };
}
