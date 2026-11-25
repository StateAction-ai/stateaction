import { createHash, randomUUID } from "node:crypto";
import type { InventoryFile } from "@stateaction/contracts";
import { reserveSourceFile, sourceObjectKey } from "../src/catalog/catalog.js";
import type { Queryable } from "../src/catalog/catalog.js";

export const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");

export const mobileSourceChannels = () =>
  [
    {
      topic: "/camera/rgb/video",
      schema_name: "foxglove.CompressedVideo",
      message_encoding: "protobuf",
    },
    {
      topic: "/tracking/pose",
      schema_name: "geometry_msgs/msg/PoseStamped",
      message_encoding: "cdr",
    },
    ...Object.entries({
      capture_profile: "Profile",
      clocks: "Clocks",
      inventory: "Inventory",
      frame_events: "FrameEvent",
      sensor_events: "SensorEvent",
      "imu/accel": "MotionEvent",
      "imu/gyro": "MotionEvent",
      close: "Close",
    }).map(([topic, type]) => ({
      topic: `/stateaction/${topic}`,
      schema_name: `stateaction.capture.${type}.v1`,
      message_encoding: "json",
    })),
  ].map((channel) => ({
    ...channel,
    clock_domain: "unix",
    message_count: "1",
  }));

export const createBody = (clientRecordingId = randomUUID()) => ({
  clientRecordingId,
  captureFormat: "stateaction.capture.v1",
  rgbProfile: "h264_mcap_v1",
  startedAt: "2026-11-01T12:00:00Z",
  device: { model: "Pixel 9", osVersion: "16", appVersion: "0.1.0" },
});

export type SourceFile = {
  fileId: string;
  role: InventoryFile["role"];
  sizeBytes: string;
  sha256: string;
  key: string;
};
export type SourceScenario = {
  files: SourceFile[];
  manifest: Uint8Array;
  manifestKey: string;
  seal: { files: InventoryFile[] };
};

/**
 * Reserves the logical source files of an already registered recording
 * through the SA-13 catalog (the SA-20 multipart transport is not exercised)
 * and returns an exact recording-source/v1 manifest whose pinned sha256 is
 * of the returned bytes. The caller stores the manifest bytes.
 */
export async function reserveSourceScenario(
  app: Queryable,
  input: {
    recordingId: string;
    clientRecordingId: string;
    owner: string;
    permissionRef: string;
    mutate?: (doc: Record<string, unknown>) => void;
  },
): Promise<SourceScenario> {
  const { recordingId, clientRecordingId, owner } = input;
  const files: SourceFile[] = [];
  for (const role of ["source_mcap", "recorder_metadata"] as const) {
    const fileId = randomUUID();
    const body = Buffer.from(`${role}:${fileId}`);
    files.push({
      fileId,
      role,
      sizeBytes: String(body.byteLength),
      sha256: sha(body),
      key: sourceObjectKey(recordingId, fileId, 1, role),
    });
  }
  const doc: Record<string, unknown> = {
    schema: "stateaction.recording_source.v2",
    recording_id: recordingId,
    client_recording_id: clientRecordingId,
    owner_user_id: owner,
    capture_format: "stateaction.capture.v1",
    rgb_profile: "h264_mcap_v1",
    capture_config_sha256: sha("capture-config"),
    close_status: "closed_clean",
    files: files.map((f) => ({
      file_id: f.fileId,
      role: f.role,
      required: true,
      size_bytes: f.sizeBytes,
      sha256: f.sha256,
    })),
    clock_domains: ["android.elapsed_realtime", "android.sensor_event", "unix"],
    channels: mobileSourceChannels(),
    counts: {
      video_frames: "30",
      dropped_video_frames: "0",
      motion_events: "200",
    },
    collection_permission_ref: input.permissionRef,
    source_verification: "pending",
  };
  input.mutate?.(doc);
  const manifest = Buffer.from(JSON.stringify(doc));
  const manifestId = randomUUID();
  const manifestKey = sourceObjectKey(
    recordingId,
    manifestId,
    1,
    "source_manifest",
  );
  files.push({
    fileId: manifestId,
    role: "source_manifest",
    sizeBytes: String(manifest.byteLength),
    sha256: sha(manifest),
    key: manifestKey,
  });
  for (const f of files)
    await reserveSourceFile(app, {
      fileId: f.fileId,
      recordingId,
      ownerUserId: owner,
      clientUploadId: randomUUID(),
      role: f.role,
      sizeBytes: f.sizeBytes,
      sha256: f.sha256,
      required: true,
      partSizeBytes: "67108864",
      partCount: 1,
    });
  return {
    files,
    manifest,
    manifestKey,
    seal: {
      files: files.map((f) => ({
        fileId: f.fileId,
        role: f.role,
        sizeBytes: f.sizeBytes,
        sha256: f.sha256,
        required: true,
      })),
    },
  };
}
