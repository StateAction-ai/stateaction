import assert from "node:assert/strict";
import { test } from "node:test";
import type { FrameMapV1, HandObservationsV1 } from "@stateaction/contracts";
import { handFramesFromArtifacts } from "../src/annotations/hand-frames.js";

const raster = { width: 640, height: 480 };
const origin = {
  job_id: "job",
  clip_id: "clip-0",
  frame_count: 1,
  schema: "stateaction.frame_map.v1",
  time_base: { num: 1, den: 1_000_000 },
  rows: [
    {
      frame_index: 0,
      source_frame_id: "0",
      source_pts: "2100000",
      clip_pts: "0",
      timestamp_ns: "6870000000",
      clock_domain: "mp4.container_pts",
      raster,
      timing_verified: true,
      transform: {
        crop: { x: 0, y: 0, ...raster },
        rotation_degrees: 0,
        mirrored: false,
      },
    },
  ],
} satisfies FrameMapV1;
const map: FrameMapV1 = {
  ...origin,
  clip_id: "clip-1",
  frame_count: 2,
  rows: [
    {
      ...origin.rows[0]!,
      source_frame_id: "75",
      source_pts: "3500000",
      timestamp_ns: "8555555555",
    },
    {
      ...origin.rows[0]!,
      frame_index: 1,
      source_frame_id: "76",
      source_pts: "3533333",
      timestamp_ns: "8558888888",
      clip_pts: "33333",
    },
  ],
};
const observations: HandObservationsV1 = {
  schema: "stateaction.hand_observations.v1",
  job_id: map.job_id,
  clip_id: map.clip_id,
  frame_count: map.frame_count,
  joint_order: Array.from({ length: 21 }, (_, i) => String(i)),
  image_space: { raster, origin: "top_left_pixel_corner", units: "px" },
  frames: [
    {
      frame_index: 0,
      hands: [
        {
          hand_index: 0,
          handedness: "right",
          handedness_score: 0.9,
          visibility: "unknown",
          image_landmarks_px: Array.from({ length: 21 }, (_, i) => [i, 17]),
          image_mask: Array.from({ length: 21 }, (_, i) => i !== 8),
          points_3d: {
            space: "model_relative",
            units: "model_estimated_meters",
            origin: "hand_geometric_center",
            metric_accuracy_validated: false,
            joints: Array(21).fill(null),
            mask: Array(21).fill(false),
          },
        },
      ],
    },
    { frame_index: 1, hands: [] },
  ],
};

test("joins the observations to exact source identity and rebases from the first clip, not the current one", () => {
  const output = handFramesFromArtifacts(map, observations, origin);
  assert.equal(output.frames[0]!.ptsUs, 1_400_000);
  assert.equal(output.frames[0]!.timestampNs, "8555555555");
  assert.equal(output.frames[0]!.sourceFrameId, "75");
  assert.equal(output.frames[0]!.hands[0]!.points.length, 21);
  assert.equal(output.frames[0]!.hands[0]!.points[8], null);
  assert.deepEqual(output.frames[0]!.hands[0]!.points[10], [10, 17]);
  assert.deepEqual(output.frames[1]!.hands, []);
});

test("rejects mismatched clips, reordered observations and unknown transform", () => {
  assert.throws(
    () =>
      handFramesFromArtifacts(
        map,
        { ...observations, clip_id: "other" },
        origin,
      ),
    /do not match/,
  );
  assert.throws(
    () =>
      handFramesFromArtifacts(
        map,
        { ...observations, frames: observations.frames.toReversed() },
        origin,
      ),
    /do not match/,
  );
  const changed = structuredClone(map);
  changed.rows[0]!.transform.mirrored = true;
  assert.throws(
    () => handFramesFromArtifacts(changed, observations, origin),
    /do not match/,
  );
});
