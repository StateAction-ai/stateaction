/**
 * Public TypeScript shapes for the v1 contracts. JSON Schema files in api/ are
 * normative; these types mirror them. Byte sizes, nanosecond timestamps, PTS and
 * native counters are decimal strings (convert with BigInt), never numbers.
 */
export type Uuid = string;
/** Opaque identity-provider user ID; never parse or assume UUID shape. */
export type AuthUserId = string;
export type Sha256Hex = string;
/** Exact decimal string: file bytes (1..100 GiB) or byte counts/offsets. */
export type DecimalBytes = string;
/** Exact non-negative int64 decimal string in one named clock domain. */
export type TimestampNs = string;
export type Int64Decimal = string;
export type Rfc3339Utc = string;
export type ClockDomain = string;
export type SourceFileRole =
  | "source_mcap"
  | "recorder_metadata"
  | "calibration";
export type OutputFileRole =
  | "result_manifest"
  | "clip_mp4"
  | "hand_arrays_npz"
  | "hand_observations_json"
  | "frame_map_json"
  | "thumbnail_jpeg"
  | "viewer_rrd";
export type JobKind = "process_recording" | "export_release";
export type JobState =
  | "queued"
  | "submitting"
  | "submit_unknown"
  | "running"
  | "result_pending"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "needs_attention";
export type FileState =
  | "reserved"
  | "uploading"
  | "completing"
  | "completed"
  | "verified"
  | "cancelled"
  | "failed"
  | "expired";
export type Raster = { width: number; height: number };
export type TimeBase = { num: number; den: number };

// HTTP (camelCase). Version is the /api/v1 path.
export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "idempotency_conflict"
  | "payload_too_large"
  | "invalid_request"
  | "unsupported_version"
  | "rate_limited"
  | "provider_unavailable"
  | "internal";
export type SuccessEnvelope<T> = { data: T; requestId: Uuid };
export type ErrorEnvelope = {
  error: { code: ErrorCode; message: string; retryable: boolean };
  requestId: Uuid;
};
export type RecordingCreateRequest = {
  clientRecordingId: Uuid;
  captureFormat: "stateaction.capture.v1";
  rgbProfile: "h264_mcap_v1";
  startedAt: Rfc3339Utc;
  device: { model: string; osVersion: string; appVersion: string };
};
export type InventoryFile = {
  fileId: Uuid;
  role: SourceFileRole;
  sizeBytes: DecimalBytes;
  sha256: Sha256Hex;
  required: boolean;
};
export type RecordingSealRequest = { files: InventoryFile[] };
export type Recording = {
  recordingId: Uuid;
  clientRecordingId: Uuid;
  ownerUserId: AuthUserId;
  status:
    | "registered"
    | "uploading"
    | "sealed"
    | "uploaded"
    | "processing"
    | "reviewable"
    | "failed"
    | "cancelled";
  createdAt: Rfc3339Utc;
  files: (InventoryFile & { state: FileState })[];
  missingRequiredRoles: SourceFileRole[];
};
export type UploadCreateRequest = {
  recordingId: Uuid;
  clientUploadId: Uuid;
  role: SourceFileRole;
  sizeBytes: DecimalBytes;
  sha256: Sha256Hex;
};
export type UploadPlan = {
  fileId: Uuid;
  recordingId: Uuid;
  role: SourceFileRole;
  sizeBytes: DecimalBytes;
  sha256: Sha256Hex;
  transportEpoch: number;
  partSizeBytes: "67108864";
  partCount: number;
  state: FileState;
  transportExpiresAt: Rfc3339Utc;
};
export type PartsSignRequest = {
  expectedTransportEpoch: number;
  partNumbers: number[];
};
export type SignedPart = {
  partNumber: number;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  offsetBytes: DecimalBytes;
  lengthBytes: DecimalBytes;
  expiresAt: Rfc3339Utc;
};
export type PartsSignedResponse = {
  transportEpoch: number;
  parts: SignedPart[];
};
export type PartsReceiptsRequest = {
  expectedTransportEpoch: number;
  receipts: { partNumber: number; etag: string; sizeBytes: DecimalBytes }[];
};
export type UploadTransitionRequest = { expectedTransportEpoch: number };

// Jobs (camelCase, schemaVersion 1).
export type ControllerInput = { jobId: Uuid };
type TaskBase = {
  schemaVersion: 1;
  jobId: Uuid;
  targetId: Uuid;
  profileRevision: string;
};
export type TaskInput =
  | (TaskBase & { kind: "process_recording"; sourceManifestSha256: Sha256Hex })
  | (TaskBase & { kind: "export_release"; selectionSha256: Sha256Hex });
export type WorkerClaimRequest = {
  schemaVersion: 1;
  jobId: Uuid;
  invocationNonce: string;
  executor:
    | { kind: "local"; localExecutionRef: string }
    | { kind: "modal"; functionCallId: string };
};
export type ClaimGrant = {
  schemaVersion: 1;
  jobId: Uuid;
  invocationNonce: string;
  kind: JobKind;
  startDeadline: Rfc3339Utc;
  executionDeadline: Rfc3339Utc;
  digests: {
    sourceManifestSha256: Sha256Hex;
    codeRevision: string;
    imageDigest: Sha256Hex;
    modelSha256: Sha256Hex;
    configSha256: Sha256Hex;
  };
  limits: {
    maxOutputFiles: number;
    maxOutputBytes: DecimalBytes;
    maxControlDocumentBytes: number;
  };
  inputs: {
    fileId: Uuid;
    role: SourceFileRole;
    sizeBytes: DecimalBytes;
    sha256: Sha256Hex;
    readUrl: string;
    expiresAt: Rfc3339Utc;
  }[];
  /** Secret bearer capability: never log or persist. */
  capability: { token: string; expiresAt: Rfc3339Utc };
};
export type Heartbeat = {
  schemaVersion: 1;
  jobId: Uuid;
  invocationNonce: string;
  phase:
    | "hashing_source"
    | "decoding"
    | "inference"
    | "writing_outputs"
    | "uploading"
    | "sealing";
  processedFrames?: Int64Decimal;
  totalFrames?: Int64Decimal | null;
};
export type CheckStatus =
  | "pass"
  | "warn"
  | "fail"
  | "measured"
  | "not_evaluated";
export type ResultCandidate = {
  schemaVersion: 1;
  jobId: Uuid;
  invocationNonce: string;
  manifestFileId: Uuid;
  manifestSha256: Sha256Hex;
  summary: {
    outcome: "succeeded" | "failed";
    clipCount: number;
    checks: Record<
      "pass" | "warn" | "fail" | "measured" | "notEvaluated",
      number
    >;
    errorCode: string | null;
  };
};
export type JobStatus = {
  jobId: Uuid;
  kind: JobKind;
  targetId: Uuid;
  state: JobState;
  previousJobId: Uuid | null;
  createdAt: Rfc3339Utc;
  updatedAt: Rfc3339Utc;
};

// Durable artifacts (snake_case, "schema" discriminator).
export type RecordingSourceV1 = {
  schema: "stateaction.recording_source.v1";
  recording_id: Uuid;
  client_recording_id: Uuid;
  owner_user_id: AuthUserId;
  capture_format: "stateaction.capture.v1";
  rgb_profile: "h264_mcap_v1";
  capture_config_sha256: Sha256Hex;
  close_status: "closed_clean" | "closed_after_recovery";
  files: {
    file_id: Uuid;
    role: SourceFileRole;
    required: boolean;
    size_bytes: DecimalBytes;
    sha256: Sha256Hex;
  }[];
  clock_domains: ClockDomain[];
  channels: {
    topic: string;
    message_encoding: "protobuf" | "cdr" | "json";
    schema_name: string;
    clock_domain: ClockDomain;
    message_count: Int64Decimal;
  }[];
  counts: {
    video_frames: Int64Decimal;
    dropped_video_frames: Int64Decimal;
    motion_events: Int64Decimal;
  };
  collection_permission_ref: string;
  source_verification: "pending";
};
export type HandArrayDescriptor = {
  name: string;
  dtype: "float32" | "bool" | "int64";
  shape: number[];
};
export type ProcessingResultV1 = {
  schema: "stateaction.processing_result.v1";
  job_id: Uuid;
  recording_id: Uuid;
  source_manifest_sha256: Sha256Hex;
  provenance: {
    code_revision: string;
    image_digest: Sha256Hex;
    config_sha256: Sha256Hex;
    profile_revision: string;
    model: {
      name: "mediapipe_hand_landmarker";
      asset_sha256: Sha256Hex;
      license: "Apache-2.0";
    };
    rerun_sdk_version: "0.41.0";
  };
  verified_sources: {
    file_id: Uuid;
    size_bytes: DecimalBytes;
    sha256: Sha256Hex;
  }[];
  outputs: {
    file_id: Uuid;
    role: OutputFileRole;
    relative_path: string;
    size_bytes: DecimalBytes;
    sha256: Sha256Hex;
  }[];
  clips: {
    clip_id: Uuid;
    clip_ordinal: number;
    title: string;
    source_start_ns: TimestampNs;
    source_end_ns: TimestampNs;
    duration_ns: Int64Decimal;
    clock_domain: ClockDomain;
    raster: Raster;
    frame_count: number;
    files: Record<
      | "rgb_mp4"
      | "hand_arrays_npz"
      | "hand_observations_json"
      | "frame_map_json"
      | "thumbnail_jpeg"
      | "viewer_rrd",
      Uuid
    >;
    hand_arrays: {
      format: "npz";
      joint_order_ref: "stateaction.hand_observations.v1#joint_order";
      arrays: HandArrayDescriptor[];
    };
    frame_map_schema: "stateaction.frame_map.v1";
    hand_observations_schema: "stateaction.hand_observations.v1";
  }[];
  checks: {
    code: string;
    status: CheckStatus;
    message: string;
    rule_revision: string;
    measurements?: Record<string, Int64Decimal>;
  }[];
  metric_accuracy_validated: false;
  limitations: string[];
};
export type FrameMapV1 = {
  schema: "stateaction.frame_map.v1";
  job_id: Uuid;
  clip_id: Uuid;
  frame_count: number;
  time_base: TimeBase;
  rows: {
    frame_index: number;
    source_frame_id: Int64Decimal;
    clock_domain: ClockDomain;
    timestamp_ns: TimestampNs;
    source_pts: Int64Decimal;
    clip_pts: Int64Decimal;
    raster: Raster;
    transform: {
      rotation_degrees: 0 | 90 | 180 | 270;
      mirrored: boolean;
      crop: { x: number; y: number; width: number; height: number };
    };
    timing_verified: boolean;
  }[];
};
type Point2 = [number, number] | null;
type Point3 = [number, number, number] | null;
/** Raw model-estimated local 3D; not a measured camera/world position. */
export type ModelRelativePoints = {
  space: "model_relative";
  units: "model_estimated_meters";
  origin: "hand_geometric_center";
  metric_accuracy_validated: false;
  joints: Point3[];
  mask: boolean[];
};
/** Reserved for a separately qualified profile; metadata is not proof of accuracy. */
export type CameraMetricPoints = {
  space: "camera_metric";
  units: "meters";
  frame: string;
  metric_accuracy_validated: true;
  validation: {
    profile_revision: string;
    evidence_file_id: Uuid;
    evidence_sha256: Sha256Hex;
  };
  joints: Point3[];
  mask: boolean[];
};
export type HandObservationsV1 = {
  schema: "stateaction.hand_observations.v1";
  job_id: Uuid;
  clip_id: Uuid;
  frame_count: number;
  joint_order: string[];
  image_space: {
    raster: Raster;
    units: "px";
    origin: "top_left_pixel_corner";
  };
  frames: {
    frame_index: number;
    hands: {
      hand_index: 0 | 1;
      handedness: "left" | "right";
      handedness_score: number;
      visibility: "unknown";
      image_landmarks_px: Point2[];
      image_mask: boolean[];
      points_3d: ModelRelativePoints | CameraMetricPoints;
    }[];
  }[];
};
