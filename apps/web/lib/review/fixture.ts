// Synthetic review fixtures (no recording media, no model output). They have
// the shape of the merged segments.v1 / captions.v1 / hand-presence.v1 /
// dag-run.v1 contracts so the page works before the annotations API and the
// seeded dev stack exist. Provenance is labelled replay, never a real model
// run, and the observed GPU is null.

import type {
  CaptionsV1,
  DagRunV1,
  HandPresenceSpan,
  HandPresenceV1,
  Producer,
  SegmentsV1,
} from "@stateaction/contracts";
import { captionStepList, handOf, shortLabel } from "./short-label.ts";
import type {
  ClipSpan,
  ReviewBundle,
  ReviewLoader,
  ReviewRecordingSummary,
} from "./types.ts";

export type FixtureScenario =
  | "baseline"
  | "caption_failed"
  | "caption_stage_failed";

const ORIGIN_NS = 5_000_000_000n; // the first decoded frame is not at zero
const FPS = 30;
const DURATION_S = 96;
const SHA = (c: string) => c.repeat(64);

export const FIXTURE_RECORDINGS: (ReviewRecordingSummary & {
  scenario: FixtureScenario;
})[] = [
  {
    recordingId: "3f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a11",
    title: "Fixture A · 1 failed window",
    scenario: "baseline",
  },
  {
    recordingId: "3f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a12",
    title: "Fixture B · 2 captions failed",
    scenario: "caption_failed",
  },
  {
    recordingId: "3f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a13",
    title: "Fixture C · caption stage failed",
    scenario: "caption_stage_failed",
  },
];

// [start s, end s, caption]; a null caption marks the failed window.
const PLAN: [number, number, string | null][] = [
  [0, 9, "pick up knife with right hand"],
  [9, 18, "hold onion with left hand, cut onion with knife in right hand"],
  [
    18,
    27,
    "wipe shelf with cloth in right hand, shift book on shelf with left hand",
  ],
  [
    27,
    36,
    "hold cloth with right hand, rotate pitcher with both hands, tighten pitcher lid with right hand",
  ],
  [36, 42, null],
  [42, 51, "put down the cup on the table using the left hand"],
  [51, 63, "turn on the faucet with right hand"],
  [63, 72, "open the drawer, take out a spoon with both hands"],
  [72, 84, "stir soup in the pot with a wooden spoon in the right hand"],
  [84, 96, "fold towel"],
];

const frame = (s: number) => ({
  source_frame_id: String(Math.round(s * FPS)),
  timestamp_ns: String(ORIGIN_NS + BigInt(Math.round(s * 1e9))),
});
const endFrame = (s: number) =>
  s >= DURATION_S ? { source_frame_id: null, timestamp_ns: null } : frame(s);

function producer(
  stage: Producer["stage"],
  moduleId: string,
  model: string,
  engine: string,
  extra: Partial<Producer> = {},
): Producer {
  return {
    stage,
    module_id: moduleId,
    module_version: 1,
    model_name: model,
    model_revision: null,
    weights_sha256: SHA("a"),
    quant: null,
    prompt_sha256: SHA("b"),
    params_sha256: SHA("c"),
    decoding_params: {},
    engine: { name: engine, version: "1" },
    gpu: { requested_type: "none", observed_type: null },
    ...extra,
  };
}

function spans(
  runs: [number, number, HandPresenceSpan["state"]][],
): HandPresenceSpan[] {
  return runs.map(([a, b, state]) => ({
    start: frame(a) as HandPresenceSpan["start"],
    end: endFrame(b) as HandPresenceSpan["end"],
    frames: Math.round((b - a) * FPS),
    state,
  }));
}

export function fixtureBundle(
  recordingId: string,
  scenario: FixtureScenario,
  title: string,
): ReviewBundle {
  const jobId = "019a4b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b";
  const manifest = SHA("8");
  const failWindow =
    scenario === "baseline" || scenario === "caption_stage_failed";
  const kept = PLAN.filter(([, , c]) => failWindow || c !== null);
  const rows: SegmentsV1["rows"] = kept.map(([a, b, c], ordinal) => ({
    segment_id: `00000000-0000-5000-8000-${String(ordinal).padStart(12, "0")}`,
    ordinal,
    start: frame(a),
    end: endFrame(b),
    status: c === null ? ("failed_window" as const) : ("ok" as const),
    ext: {},
  }));
  const failedSpans = rows.filter((r) => r.status === "failed_window");
  const segments: SegmentsV1 = {
    schema: "stateaction.segments.v1",
    job_id: jobId,
    recording_id: recordingId,
    source_manifest_sha256: manifest,
    clock_domain: "android.elapsed_realtime",
    producer: producer(
      "segment",
      "replay_segmenter",
      "replay_flora_tempseg",
      "replay",
    ),
    windows: {
      total: 8 + failedSpans.length,
      ok: 8,
      failed: failedSpans.map((r, i) => ({
        window_index: 4 + i,
        error_code: "engine_timeout",
        core_start: r.start,
        core_end: r.end,
      })),
      failed_core_spans: failedSpans.map((r) => ({
        start: r.start,
        end: r.end,
      })),
    },
    rows,
  };

  const failedCaptionAt = scenario === "caption_failed" ? [2, 6] : [];
  const captions: CaptionsV1 | null =
    scenario === "caption_stage_failed"
      ? null
      : {
          schema: "stateaction.captions.v1",
          job_id: jobId,
          recording_id: recordingId,
          source_manifest_sha256: manifest,
          segments_sha256: SHA("d"),
          producer: producer(
            "caption",
            "replay_captioner",
            "replay_flora_captioner",
            "replay",
          ),
          rows: rows.map((r, i) => {
            const text = kept[i]![2];
            if (text === null)
              return {
                segment_id: r.segment_id,
                status: "not_captioned" as const,
                error_code: "segment_failed_window",
              };
            if (failedCaptionAt.includes(i))
              return {
                segment_id: r.segment_id,
                status: "failed" as const,
                error_code:
                  i === 2 ? "unsupported_target_frames" : "empty_caption",
              };
            return {
              segment_id: r.segment_id,
              status: "complete" as const,
              error_code: null,
              text,
              lang: "en",
              derived: {
                rule: "caption_rule@1" as const,
                short_label: shortLabel(text),
                hand: handOf(text),
                steps: captionStepList(text),
              },
            };
          }),
        };

  const hand_presence: HandPresenceV1 = {
    schema: "stateaction.hand_presence.v1",
    job_id: jobId,
    recording_id: recordingId,
    source_manifest_sha256: manifest,
    clock_domain: "android.elapsed_realtime",
    frame_count: DURATION_S * FPS,
    producer: producer(
      "hand_pose",
      "hand_pose_cpu_v1",
      "mediapipe_hand_landmarker",
      "mediapipe",
    ),
    lanes: {
      left: spans([
        [0, 9, "no_hand"],
        [9, 30, "present"],
        [30, 33, "failed"],
        [33, 60, "present"],
        [60, 66, "no_hand"],
        [66, 90, "present"],
        [90, DURATION_S, "no_hand"],
      ]),
      right: spans([
        [0, 27, "present"],
        [27, 31, "no_hand"],
        [31, 84, "present"],
        [84, DURATION_S, "no_hand"],
      ]),
    },
  };

  const node = (
    stage: "segment" | "caption" | "hand_pose",
    module: string,
    state: DagRunV1["stages"][number]["state"],
    errorCode: string | null,
  ): DagRunV1["stages"][number] => ({
    stage,
    enabled: true,
    module: module as DagRunV1["stages"][number]["module"],
    state,
    errorCode,
    callId: null,
    gpu: { requestedType: "none", observedType: null },
    startedAt: null,
    finishedAt: null,
    counts: {},
    estimatedCostUsd: null,
    receiptSha256: null,
  });
  const dag_run: DagRunV1 = {
    schemaVersion: 1,
    jobId,
    recordingId,
    jobState: "succeeded",
    recipeId: "fixture_recipe@1",
    recipeSha256: SHA("e"),
    maxJobCostUsd: "0.00",
    estimatedCostUsd: null,
    stages: [
      node("segment", "replay_segmenter@1", "succeeded", null),
      scenario === "caption_stage_failed"
        ? node(
            "caption",
            "replay_captioner@1",
            "failed",
            "caption_stage_failed",
          )
        : node("caption", "replay_captioner@1", "succeeded", null),
      node("hand_pose", "hand_pose_cpu_v1@1", "succeeded", null),
    ],
    renderedAt: "2026-11-22T00:00:00Z",
  };

  // Two 60 s clip windows: the Hand pose tab follows the playhead into one.
  const clips: ClipSpan[] = [
    {
      clipId: "c0000000-0000-4000-8000-000000000001",
      startNs: String(ORIGIN_NS),
      endNs: String(ORIGIN_NS + 60_000_000_000n),
    },
    {
      clipId: "c0000000-0000-4000-8000-000000000002",
      startNs: String(ORIGIN_NS + 66_000_000_000n),
      endNs: String(ORIGIN_NS + 96_000_000_000n),
    },
  ];

  return {
    recording: { recordingId, title, durationS: DURATION_S },
    annotations: {
      schema: "stateaction.recording-annotations.v1",
      recording_id: recordingId,
      job_id: jobId,
      segments,
      captions,
      hand_presence,
      dag_run,
    },
    clips,
    video: { kind: "none", reason: "Fixture data has no recording video." },
    origin: "fixture",
  };
}

export function fixtureLoader(): ReviewLoader {
  return {
    async listRecordings() {
      return FIXTURE_RECORDINGS.map(({ recordingId, title }) => ({
        recordingId,
        title,
      }));
    },
    async load(_userId, recordingId) {
      const f = FIXTURE_RECORDINGS.find((r) => r.recordingId === recordingId);
      return f ? fixtureBundle(f.recordingId, f.scenario, f.title) : null;
    },
  };
}
