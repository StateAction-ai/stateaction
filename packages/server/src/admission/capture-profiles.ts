import { HARDWARE_RGB_PROFILE } from "@stateaction/contracts";
import {
  CPU_CANARY_RECIPE_REF,
  DEFAULT_RECIPE_REF,
} from "../jobs/recipe-release.js";

export type CaptureChannel = {
  topic: string;
  schema_name: string;
  message_encoding: string;
  clock_domain: string;
};

// Sealed declarations emitted by H264CaptureWriter.sourceManifestEvidence.
export const STATEACTION_MOBILE_CHANNELS = [
  ["/camera/rgb/video", "foxglove.CompressedVideo", "protobuf"],
  ["/tracking/pose", "geometry_msgs/msg/PoseStamped", "cdr"],
  ["/stateaction/capture_profile", "stateaction.capture.Profile.v1", "json"],
  ["/stateaction/clocks", "stateaction.capture.Clocks.v1", "json"],
  ["/stateaction/inventory", "stateaction.capture.Inventory.v1", "json"],
  ["/stateaction/frame_events", "stateaction.capture.FrameEvent.v1", "json"],
  ["/stateaction/sensor_events", "stateaction.capture.SensorEvent.v1", "json"],
  ["/stateaction/imu/accel", "stateaction.capture.MotionEvent.v1", "json"],
  ["/stateaction/imu/gyro", "stateaction.capture.MotionEvent.v1", "json"],
  ["/stateaction/close", "stateaction.capture.Close.v1", "json"],
] as const;

export const CAPTURE_SOURCES = [
  {
    id: "stateaction_mobile@1",
    label: "StateAction mobile app",
    captureFormat: "stateaction.capture.v1",
    rgbProfile: HARDWARE_RGB_PROFILE,
    defaultRecipeId: DEFAULT_RECIPE_REF,
    allowedRecipeIds: [DEFAULT_RECIPE_REF, CPU_CANARY_RECIPE_REF],
  },
] as const;

export function matchCaptureSource(declaration: {
  captureFormat: string;
  rgbProfile: string;
  channels: readonly CaptureChannel[];
}) {
  const { channels } = declaration;
  return CAPTURE_SOURCES.find(
    (source) =>
      declaration.captureFormat === source.captureFormat &&
      declaration.rgbProfile === source.rgbProfile &&
      channels.length === STATEACTION_MOBILE_CHANNELS.length &&
      STATEACTION_MOBILE_CHANNELS.every(([topic, schema, encoding]) =>
        channels.some(
          (channel) =>
            channel.topic === topic &&
            channel.schema_name === schema &&
            channel.message_encoding === encoding &&
            channel.clock_domain === "unix",
        ),
      ),
  );
}
