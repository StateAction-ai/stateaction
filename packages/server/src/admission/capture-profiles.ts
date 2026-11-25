import {
  HARDWARE_RGB_PROFILE,
  parseContract,
  type RecipeV1,
} from "@stateaction/contracts";
import { PUBLIC_VIDEO_RECIPE } from "./public-video-canary.js";

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
    defaultRecipeId: PUBLIC_VIDEO_RECIPE.recipeId,
    allowedRecipeIds: [PUBLIC_VIDEO_RECIPE.recipeId],
  },
] as const;

export function captureRecipeDefinition(
  recipeId: string,
): RecipeV1 | undefined {
  if (recipeId === PUBLIC_VIDEO_RECIPE.recipeId)
    return parseContract<RecipeV1>("jobs.recipe.v1", PUBLIC_VIDEO_RECIPE);
}

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
