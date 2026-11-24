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
/**
 * Sealed source file roles. "source_manifest" is the exact recording-source/v1
 * declaration bytes; their SHA-256 is the recording's sourceManifestSha256.
 */
export type SourceFileRole =
  | "source_mcap"
  | "recorder_metadata"
  | "calibration"
  | "source_manifest";
/** Roles a recording-source/v1 declaration may list: never itself. */
export type DeclaredSourceFileRole = Exclude<SourceFileRole, "source_manifest">;
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
// SA-71 additive versions (catalog.v6). Simulated capture is never hardware:
// every `simulation` marker is optional on hardware and required on simulation.
export type SimulationProvenanceSource =
  | { status: "known"; label: string }
  | { status: "unknown" };
export type SimulationProvenance = {
  schema: "stateaction.simulation_provenance.v1";
  qualification: "simulation_only";
  mappedTimelineSemantics: "simulation_transport_only";
  productionQualified: false;
  provenance: {
    camera: SimulationProvenanceSource;
    encoder: SimulationProvenanceSource;
    clock: SimulationProvenanceSource;
  };
};
/** Snake_case form embedded in the recording-source.v2 manifest. */
export type SimulationProvenanceArtifact = {
  schema: "stateaction.simulation_provenance.v1";
  qualification: "simulation_only";
  mapped_timeline_semantics: "simulation_transport_only";
  production_qualified: false;
  provenance: SimulationProvenance["provenance"];
};
export type HardwareRgbProfile = "h264_mcap_v1";
export type SimulationRgbProfile = "h264_mcap_simulation_v1";
export type RecordingCreateRequestV2 = Omit<
  RecordingCreateRequest,
  "rgbProfile"
> & { schema: "stateaction.recording_create.v2" } & (
    | { rgbProfile: HardwareRgbProfile }
    | { rgbProfile: SimulationRgbProfile; simulation: SimulationProvenance }
  );
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
export type RecordingV2 = Recording &
  (
    | { rgbProfile: HardwareRgbProfile }
    | { rgbProfile: SimulationRgbProfile; simulation: SimulationProvenance }
  );
export type RecordingRegistrationV2 = {
  recording: RecordingV2;
  collectionPermissionRef: string;
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

// SA-25 internal job-control contracts (catalog.v7, /internal/v1).
export type ControllerExecutor =
  | { kind: "local"; localExecutionRef: string }
  | { kind: "modal"; functionCallId: string };
export type ControllerEvidence =
  | {
      kind: "local_child_reaped" | "provider_call_terminal";
      executionRef: string;
      detail?: Record<string, string>;
    }
  | { kind: "pre_submission_rejected"; detail?: Record<string, string> };
export type ControllerAction =
  | { action: "record_workflow_run"; runRef: string }
  | { action: "claim_lease"; runRef: string; owner: string }
  | { action: "renew_lease"; owner: string }
  | { action: "record_worker_submission"; owner: string }
  | { action: "record_execution"; owner: string; executor: ControllerExecutor }
  | { action: "mark_submit_unknown"; owner: string }
  | { action: "record_execution_evidence"; evidence: ControllerEvidence };
export type ControllerResult =
  | { recorded: boolean }
  | { granted: true; expiresAt: Rfc3339Utc }
  | { granted: false; reason: "live_owner" | "different_run" | "not_active" }
  | { renewed: true; expiresAt: Rfc3339Utc }
  | { renewed: false }
  | {
      state: "recorded";
      bootstrapToken: string;
      startDeadline: Rfc3339Utc;
      executionDeadline: Rfc3339Utc;
      taskInput: Record<string, unknown>;
      executionBackend: "local" | "modal";
    }
  | { state: "already_recorded" }
  | { state: "submit_unknown" }
  | { recorded: true; slotReleased: boolean };
export type ReconcileResult = {
  admission:
    | {
        state: "admitted";
        jobId: Uuid;
        dispatchKey: string;
        executionDeadline: Rfc3339Utc;
      }
    | { state: "slot_busy"; holderJobId: Uuid }
    | { state: "idle" };
  pendingDispatches: { jobId: Uuid; dispatchKey: string }[];
};
export type HeartbeatAck = { accepted: true; executionDeadline: Rfc3339Utc };
export type InputRead = {
  fileId: Uuid;
  readUrl: string;
  expiresAt: Rfc3339Utc;
};
// SA-28 output sealing and result acceptance (catalog.v9, /internal/v1).
export type OutputCloseRequest = {
  schemaVersion: 1;
  jobId: Uuid;
  invocationNonce: string;
  outcome: "succeeded" | "failed";
};
export type OutputClosure = {
  schemaVersion: 1;
  jobId: Uuid;
  outcome: "succeeded" | "failed";
  fileCount: number;
  clipCount: number;
  totalBytes: string;
  manifestFileId: Uuid;
  inventorySha256: Sha256Hex;
  closedAt: Rfc3339Utc;
};
export type ResultAck = {
  schemaVersion: 1;
  jobId: Uuid;
  candidateStatus: "provisional" | "verified" | "accepted" | "rejected";
  jobState: string;
  reasonCode?: string;
};
// SA-35 dataset, catalog and read-broker contracts (catalog.v8, /api/v1).
export type DatasetCreateRequest = { datasetId: Uuid; name: string };
export type DatasetUpdateRequest = { name: string; expectedRevision: number };
export type DatasetMembersAddRequest = {
  clipIds: Uuid[];
  expectedRevision: number;
};
export type ClipReadRole = "thumbnail_jpeg" | "viewer_rrd";
export type ClipReadCreateRequest = { role: ClipReadRole };
export type DatasetView = {
  containsImported?: true;
  datasetId: Uuid;
  name: string;
  clipCount: number;
  durationNs: DecimalBytes;
  /** Staff only. */
  revision?: number;
  /** Staff only. */
  createdAt?: Rfc3339Utc;
};
export type DatasetPage = {
  datasets: DatasetView[];
  nextCursor: string | null;
};
/** Customer-safe marker; a simulated clip is never hardware evidence. */
export type ClipSimulationMarker = {
  simulated: true;
  qualification: "simulation_only";
  productionQualified: false;
};
export type DatasetClipView = {
  source?: "imported";
  clipId: Uuid;
  datasetId?: Uuid;
  title: string;
  taskLabel: string | null;
  durationNs: DecimalBytes;
  raster: { width: number; height: number };
  frameCount: number;
  simulation: ClipSimulationMarker | null;
  media: { thumbnail: boolean; viewer: boolean };
  /** Staff only. */
  recordingId?: Uuid;
  /** Staff only. */
  jobId?: Uuid;
  /** Staff only. */
  reviewRevision?: number;
};
export type DatasetClipPage = {
  clips: DatasetClipView[];
  nextCursor: string | null;
};
export type StaffClipView = DatasetClipView & {
  recordingId: Uuid;
  jobId: Uuid;
  reviewRevision: number;
  reviewStatus: "pending" | "approved" | "rejected";
  datasetCount: number;
};
export type StaffClipPage = {
  clips: StaffClipView[];
  nextCursor: string | null;
};
export type ClipRead = {
  url: string;
  role: ClipReadRole;
  contentType: "image/jpeg" | "application/octet-stream";
  sizeBytes: DecimalBytes;
  expiresAt: Rfc3339Utc;
  ttlSeconds: number;
};
// SA-36 staff clip review (catalog.v10, /api/v1). Staff only.
export type ClipReviewDecision = "approved" | "rejected";
export type ClipReviewCommand = {
  reviewId: Uuid;
  expectedReviewRevision: number;
  jobId: Uuid;
  resultManifestSha256: Sha256Hex;
  decision: ClipReviewDecision;
  taskLabel?: string;
  notes?: string;
  datasetSelection?: {
    datasetIds: Uuid[];
    expectedRevisions: Record<Uuid, number>;
  };
};
export type ClipReview = {
  reviewId: Uuid;
  clipId: Uuid;
  jobId: Uuid;
  resultManifestSha256: Sha256Hex;
  revision: number;
  decision: ClipReviewDecision;
  taskLabel: string | null;
  notes: string | null;
  datasetSelection: {
    datasetIds: Uuid[];
    expectedRevisions: Record<Uuid, number>;
  } | null;
  createdAt: Rfc3339Utc;
};
export type ClipQualityCheck = {
  id: string;
  status: "pass" | "warn" | "fail" | "measured" | "not_evaluated" | "unknown";
  ruleRevision?: number;
  measurements?: Record<string, string>;
};
export type ClipReviewState = {
  qualityChecks:
    | { status: "not_evaluated"; checks: [] }
    | { status: "evaluated"; checks: ClipQualityCheck[] };
  clipId: Uuid;
  recordingId: Uuid;
  jobId: Uuid;
  resultManifestSha256: Sha256Hex;
  current: boolean;
  capabilities: { canReview: boolean };
  review: {
    revision: number;
    decision: ClipReviewDecision | null;
    taskLabel: string | null;
    notes: string | null;
    reviewedAt: Rfc3339Utc | null;
  };
  history: {
    revision: number;
    decision: ClipReviewDecision;
    taskLabel: string | null;
    notes: string | null;
    reviewedAt: Rfc3339Utc;
  }[];
  memberships: {
    datasetId: Uuid;
    name: string;
    revision: number;
    addedAt: Rfc3339Utc;
  }[];
  membershipsTruncated: boolean;
  availableDatasets: {
    datasetId: Uuid;
    name: string;
    revision: number;
    member: boolean;
    shared: boolean;
  }[];
  availableDatasetsTruncated: boolean;
};
// SA-27 staff job control (catalog.v11, /api/v1). Staff only.
export type JobControlAction = "cancel" | "retry" | "reconcile";
export type JobControlState =
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
export type JobControlCommand = {
  requestId: Uuid;
  action: JobControlAction;
  jobId: Uuid;
  expectedState: JobControlState;
};
export type JobControlResult = {
  action: JobControlAction;
  jobId: Uuid;
  state: JobControlState;
  retryJobId: Uuid | null;
  replayed: boolean;
  guidance: {
    code:
      | "none"
      | "in_progress"
      | "cancel_pending_termination"
      | "unknown_spawn"
      | "needs_operator"
      | "retry_available"
      | "reupload_required"
      | "retry_blocked_termination_unproven"
      | "superseded";
    instruction: string;
  };
};
// SA-99 staff segment marks (catalog.v16, /api/v1). Staff only; append-only.
export type SegmentMarkVerdict = "good" | "issue";
export type SegmentIssueType = "boundary" | "caption" | "hand_pose";
export type SegmentMarkCommand = {
  markId: Uuid;
  jobId: Uuid;
  segmentsSha256: string;
  expectedRevision: number;
  verdict: SegmentMarkVerdict;
  issueType?: SegmentIssueType;
  note?: string;
};
export type SegmentMark = {
  markId: Uuid;
  jobId: Uuid;
  segmentsSha256: string;
  segmentId: Uuid;
  revision: number;
  verdict: SegmentMarkVerdict;
  issueType: SegmentIssueType | null;
  note: string | null;
  createdAt: string;
  replayed: boolean;
};
export type SegmentMarkRow = {
  segmentId: Uuid;
  revision: number;
  verdict: SegmentMarkVerdict;
  issueType: SegmentIssueType | null;
  note: string | null;
  createdAt: string;
};
export type SegmentMarks = {
  jobId: Uuid | null;
  segmentsSha256: string | null;
  segmentCount: number;
  checkedCount: number;
  issueCount: number;
  marks: SegmentMarkRow[];
};
export type DatasetChange = {
  revision: number;
  datasetId?: Uuid;
  added?: number;
  removed?: boolean;
};
type TaskBase = {
  schemaVersion: 1;
  jobId: Uuid;
  targetId: Uuid;
  profileRevision: string;
};
export type TaskInput =
  | (TaskBase & { kind: "process_recording"; sourceManifestSha256: Sha256Hex })
  | (TaskBase & { kind: "export_release"; selectionSha256: Sha256Hex });
export type TaskInputV2 =
  | (Omit<TaskBase, "schemaVersion"> & {
      schemaVersion: 2;
      kind: "process_recording";
      sourceManifestSha256: Sha256Hex;
    } & (
        | { rgbProfile: HardwareRgbProfile }
        | {
            rgbProfile: SimulationRgbProfile;
            simulation: SimulationProvenance;
          }
      ))
  | (Omit<TaskBase, "schemaVersion"> & {
      schemaVersion: 2;
      kind: "export_release";
      selectionSha256: Sha256Hex;
    });
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
  /** Export grants are a separate future contract version. */
  kind: "process_recording";
  /** startDeadline <= executionDeadline. */
  startDeadline: Rfc3339Utc;
  executionDeadline: Rfc3339Utc;
  digests: {
    sourceManifestSha256: Sha256Hex;
    codeRevision: string;
    /** SHA-256 of the locked worker image build spec; not a Modal image ID or OCI digest. */
    imageSpecSha256: Sha256Hex;
    modelSha256: Sha256Hex;
    configSha256: Sha256Hex;
  };
  limits: {
    maxOutputFiles: number;
    maxOutputBytes: DecimalBytes;
    maxControlDocumentBytes: number;
  };
  /** Every sealed file: exactly one source_manifest (sha256 = digests.sourceManifestSha256) and one source_mcap. */
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
/** SA-73 (catalog.v13): one sealed original with its server-verified identity. */
export type SourceEvidenceFileV1 = {
  fileId: Uuid;
  role: "source_mcap" | "recorder_metadata" | "calibration" | "source_manifest";
  required: boolean;
  sizeBytes: DecimalBytes;
  sha256: Sha256Hex;
};
/** Staff request: the exact sealed inventory reviewed. No owner or staff identity. */
export type SourceCopyConfirmRequestV1 = {
  expectedSealSha256: Sha256Hex;
  expectedSourceManifestSha256: Sha256Hex;
  expectedFileCount: number;
};
/** Original-owner request: the identities held by the phone. */
export type CleanupProofRequestV1 = {
  sealSha256: Sha256Hex;
  sourceManifestSha256: Sha256Hex;
  clientRecordingId: Uuid;
};
export type SourceCopyConfirmationV1 = {
  schemaVersion: 1;
  confirmationId: Uuid;
  recordingId: Uuid;
  clientRecordingId: Uuid;
  sealSha256: Sha256Hex;
  sourceManifestSha256: Sha256Hex;
  fileCount: number;
  totalBytes: DecimalBytes;
  files: SourceEvidenceFileV1[];
  confirmedByUserId: string;
  verifiedAt: Rfc3339Utc;
  confirmedAt: Rfc3339Utc;
};
/** Fresh, server-issued, expiring evidence. Grants no storage capability; not deletion intent. */
export type CleanupProofV1 = {
  schemaVersion: 1;
  proofId: Uuid;
  recordingId: Uuid;
  clientRecordingId: Uuid;
  ownerUserId: string;
  sealSha256: Sha256Hex;
  sourceManifestSha256: Sha256Hex;
  confirmationId: Uuid;
  confirmedAt: Rfc3339Utc;
  verification: "rehash";
  fileCount: number;
  totalBytes: DecimalBytes;
  files: SourceEvidenceFileV1[];
  issuedAt: Rfc3339Utc;
  expiresAt: Rfc3339Utc;
};
/** SA-42 (catalog.v12): the status plus the recorded execution identity. An identity only; never spawn authority. */
export type JobStatusV2 = JobStatus & {
  executionBackend: "local" | "modal" | null;
  executionRef: string | null;
  /** Immutable worker start deadline (10 min after the submission intent); null before intent. */
  startDeadline: Rfc3339Utc | null;
  /** Immutable absolute deadline (admitted_at + 6 h); null before admission. */
  executionDeadline: Rfc3339Utc | null;
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
  /** Every other sealed file; never this declaration itself. */
  files: {
    file_id: Uuid;
    role: DeclaredSourceFileRole;
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
export type RecordingSourceV2 = Omit<
  RecordingSourceV1,
  "schema" | "rgb_profile"
> & { schema: "stateaction.recording_source.v2" } & (
    | { rgb_profile: HardwareRgbProfile }
    | {
        rgb_profile: SimulationRgbProfile;
        simulation: SimulationProvenanceArtifact;
      }
  );
/** NPZ arrays, in schema order; see HAND_ARRAY_SHAPES. */
export type HandArrayName =
  | "image_landmarks_px"
  | "image_landmarks_mask"
  | "model_relative_joints"
  | "model_relative_mask"
  | "hand_detected"
  | "handedness_score"
  /** int8 [F,2]: 0 left, 1 right, -1 none where hand_detected is false. Slot never implies side. */
  | "handedness"
  | "frame_index";
export type HandArrayDescriptor = {
  name: HandArrayName;
  dtype: "float32" | "bool" | "int8" | "int64";
  shape: number[];
};
export type ProcessingResultV1 = {
  schema: "stateaction.processing_result.v1";
  job_id: Uuid;
  recording_id: Uuid;
  source_manifest_sha256: Sha256Hex;
  provenance: {
    code_revision: string;
    image_spec_sha256: Sha256Hex;
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

// Native capture bridge (camelCase, schemaVersion 1). Detailed capture profile
// and evidence schemas belong to the capture contracts (SA-50).
export type CaptureProfileRequest = {
  captureFormat: "stateaction.capture.v1";
  rgbProfile: "h264_mcap_v1";
  profileRevision: string;
};
export type AcceptedCaptureProfile = CaptureProfileRequest & {
  /** SHA-256 of the exact accepted capture Profile document. */
  captureConfigSha256: Sha256Hex;
};
type CommandBase = { schemaVersion: 1; commandId: Uuid };
export type CaptureCommand =
  | (CommandBase & {
      operation: "get_capabilities";
      profileRequest: CaptureProfileRequest;
    })
  | (CommandBase & { operation: "list_recoverable_captures" })
  | (CommandBase & {
      operation: "start_capture";
      clientRecordingId: Uuid;
      ownerUserId: AuthUserId;
      collectionPermissionRef: string;
      acceptedProfile: AcceptedCaptureProfile;
    })
  | (CommandBase & {
      operation: "stop_capture";
      clientRecordingId: Uuid;
      reason:
        | "user_requested"
        | "low_storage"
        | "low_battery"
        | "thermal_limit"
        | "camera_interrupted"
        | "app_terminating"
        | "account_change";
    })
  | (CommandBase & {
      operation: "get_capture_snapshot" | "recover_capture";
      clientRecordingId: Uuid;
    });
export type CaptureErrorCode =
  | "invalid_command"
  | "unsupported_device"
  | "unsupported_profile"
  | "permission_denied"
  | "capture_active"
  | "command_conflict"
  | "owner_mismatch"
  | "not_found"
  | "low_storage"
  | "low_battery"
  | "thermal_limit"
  | "camera_interrupted"
  | "encoder_failure"
  | "writer_failure"
  | "recovery_required"
  | "internal";
export type CaptureError = {
  schemaVersion: 1;
  code: CaptureErrorCode;
  retryable: boolean;
  /** User-safe display text only. */
  message: string;
  commandId: Uuid | null;
  clientRecordingId: Uuid | null;
};
export type CaptureSnapshot = {
  schemaVersion: 1;
  clientRecordingId: Uuid;
  ownerUserId: AuthUserId;
  state:
    | "preflight"
    | "recording"
    | "finalizing"
    | "finalized"
    | "recovery_required"
    | "quarantined";
  containerState: "closed" | "unclosed" | "invalid" | null;
  /** Close.outcome: completed->completed, aborted->interrupted, failed->failed, unknown->null. */
  captureOutcome: "completed" | "interrupted" | "failed" | null;
  /** Persisted, monotonically increasing journal sequence (int64 decimal). */
  eventSequence: Int64Decimal;
  counters: {
    videoFramesAcquired: Int64Decimal;
    videoFramesSubmitted: Int64Decimal;
    videoFramesWritten: Int64Decimal;
    videoFramesDropped: Int64Decimal;
    videoFramesUnresolved: Int64Decimal;
    motionEventsWritten: Int64Decimal;
    sourceBytesWritten: DecimalBytes;
  };
  lastError: CaptureError | null;
};
export type CaptureUnsupportedReason =
  | "unsupported_device"
  | "unsupported_profile"
  | "permission_denied"
  | "camera_unavailable"
  | "encoder_unavailable"
  | "sensor_unavailable"
  | "low_storage"
  | "low_battery"
  | "thermal_limit";
export type CaptureCapabilities =
  | {
      schemaVersion: 1;
      commandId: Uuid;
      outcome: "accepted";
      acceptedProfile: AcceptedCaptureProfile;
      unsupportedReasons: [];
    }
  | {
      schemaVersion: 1;
      commandId: Uuid;
      outcome: "unsupported";
      acceptedProfile: null;
      unsupportedReasons: CaptureUnsupportedReason[];
    };
export type CaptureRecoverable = {
  schemaVersion: 1;
  commandId: Uuid;
  captures: CaptureSnapshot[];
};

// ------------------------------------------------ SA-87 (catalog.v14) stage contracts
/** common.v2 outputFileRole: an exact superset of the v1 roles. */
export type OutputFileRoleV2 =
  | OutputFileRole
  | "segments_json"
  | "captions_json"
  | "hand_presence_json"
  | "recording_mp4"
  | "diagnostic_blob";
export type Stage = "segment" | "caption" | "hand_pose";
export type ModalRerunBinding = {
  functionId: string;
  definitionId: string;
  gpu: string;
  maxBilledSeconds: number;
  microUsdPerGpuSecond: number;
  microUsdPerCpuSecond: number;
  maxContainers: number;
  maxCpuMilli: number;
  maxMemoryMib: number;
  environment: string;
  appName: string;
  codeRevision: string;
  paramsSha256: Sha256Hex;
  definitionSha256: Sha256Hex;
};

export type StageRunState =
  | "pending"
  | "submitting"
  | "submit_unknown"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "not_run";
export type GpuType =
  | "none"
  | "T4"
  | "L4"
  | "A10G"
  | "L40S"
  | "A100-40GB"
  | "A100-80GB"
  | "RTX-PRO-6000"
  | "H100"
  | "H200"
  | "B200";
/** module_id@version, resolved in api/modules.json. */
export type ModuleRef = string;
/** Fractions are decimal strings so a map stays in the sa-cjson-v1 domain. */
export type ParamMap = Record<string, string | number | boolean | null>;
/** Two-fraction-digit decimal string, for example "3.00". */
export type UsdAmount = string;
export type FrameRef = {
  source_frame_id: Int64Decimal;
  timestamp_ns: TimestampNs;
};
/** Exclusive end; both fields null means end of stream. */
export type EndFrameRef =
  | FrameRef
  | { source_frame_id: null; timestamp_ns: null };
export type Producer = {
  stage: Stage;
  module_id: string;
  module_version: number;
  model_name: string;
  model_revision: string | null;
  weights_sha256: Sha256Hex | null;
  quant: { method: string; checkpoint_manifest_sha256: Sha256Hex } | null;
  prompt_sha256: Sha256Hex | null;
  params_sha256: Sha256Hex;
  decoding_params: ParamMap;
  engine: { name: string; version: string };
  gpu: { requested_type: GpuType; observed_type: string | null };
};
type RecordingDocument = {
  job_id: Uuid;
  recording_id: Uuid;
  source_manifest_sha256: Sha256Hex;
  producer: Producer;
};
export type SegmentsV1 = RecordingDocument & {
  schema: "stateaction.segments.v1";
  clock_domain: ClockDomain;
  windows: {
    total: number;
    ok: number;
    failed: {
      window_index: number;
      error_code: string;
      core_start: FrameRef;
      core_end: EndFrameRef;
    }[];
    failed_core_spans: { start: FrameRef; end: EndFrameRef }[];
  };
  rows: {
    /** uuid5, see segmentId(). */
    segment_id: Uuid;
    ordinal: number;
    start: FrameRef;
    end: EndFrameRef;
    status: "ok" | "failed_window";
    ext: Record<string, Record<string, string | number | boolean | null>>;
  }[];
};
export type CaptionDerived = {
  rule: "caption_rule@1";
  short_label: string;
  hand: "left" | "right" | "both" | "none";
  steps: string[];
};
export type CaptionRow =
  | {
      segment_id: Uuid;
      status: "complete";
      error_code: null;
      text: string;
      lang: string;
      derived: CaptionDerived;
    }
  | {
      segment_id: Uuid;
      status: "failed" | "not_captioned";
      error_code: string;
    };
export type CaptionsV1 = RecordingDocument & {
  schema: "stateaction.captions.v1";
  segments_sha256: Sha256Hex;
  rows: CaptionRow[];
};
export type HandPresenceSpan = {
  start: FrameRef;
  end: EndFrameRef;
  frames: number;
  state: "present" | "no_hand" | "failed";
};
export type HandPresenceV1 = RecordingDocument & {
  schema: "stateaction.hand_presence.v1";
  clock_domain: ClockDomain;
  frame_count: number;
  lanes: { left: HandPresenceSpan[]; right: HandPresenceSpan[] };
};
export type ImportedProducer = Omit<Producer, "engine" | "gpu"> & {
  engine: { name: string | null; version: string | null };
  gpu: { requested_type: GpuType | null; observed_type: string | null };
};
export type ImportedSegments = Omit<SegmentsV1, "schema" | "producer"> & {
  schema: "stateaction.segments.v2";
  producer: ImportedProducer;
};
export type ImportedCaptions = Omit<CaptionsV1, "schema" | "producer"> & {
  schema: "stateaction.captions.v2";
  producer: ImportedProducer;
};
export type ImportedHandPresence = Omit<
  HandPresenceV1,
  "schema" | "producer"
> & {
  schema: "stateaction.hand_presence.v2";
  producer: ImportedProducer;
};
export type RecordingAnnotations = {
  recording_id: Uuid;
  job_id: Uuid;
} & (
  | {
      schema: "stateaction.recording-annotations.v1";
      source?: never;
      segments: SegmentsV1 | null;
      captions: CaptionsV1 | null;
      hand_presence: HandPresenceV1 | null;
      dag_run: DagRunV1 | null;
    }
  | {
      schema: "stateaction.recording-annotations.v2";
      source: "imported";
      segments: ImportedSegments;
      captions: ImportedCaptions;
      hand_presence: ImportedHandPresence;
      dag_run: null;
    }
  | {
      schema: "stateaction.recording-annotations.v3";
      source?: never;
      segments: SegmentsV1 | null;
      captions: CaptionsV1 | null;
      hand_presence: HandPresenceV1 | null;
      dag_run: (Omit<DagRunV1, "schemaVersion"> & { schemaVersion: 2 }) | null;
      producer_jobs: Record<
        "segments" | "captions" | "hand_presence",
        Uuid | null
      >;
    }
);
export type StageResources = {
  gpu: GpuType;
  budgetSeconds: number;
  maxContainers: number;
  retries: 0;
};
type RecipeStage<S extends Stage> = {
  stage: S;
  enabled: S extends "hand_pose" ? true : boolean;
  module: ModuleRef;
  params: ParamMap;
  resources: StageResources;
};
export type RecipeV1 = {
  schemaVersion: 1;
  recipeId: string;
  maxJobCostUsd: UsdAmount;
  stages: [
    RecipeStage<"segment">,
    RecipeStage<"caption">,
    RecipeStage<"hand_pose">,
  ];
};
export type ModuleManifestEntry = {
  moduleId: string;
  version: number;
  stage: Stage;
  description: string;
  license: { id: string; commercialUse: boolean };
  gpu: { minimum: GpuType; supported: GpuType[] };
  localOnly: boolean;
  outputs: OutputFileRoleV2[];
  provenance: {
    modelName: string;
    modelRevision: string | null;
    engine: string;
    requires: (
      | "model_revision"
      | "weights_sha256"
      | "quant"
      | "prompt_sha256"
      | "observed_gpu"
    )[];
  };
};
export type ModuleManifestV1 = {
  schemaVersion: 1;
  modules: ModuleManifestEntry[];
};
export type TaskInputV3 =
  | (Omit<
      Extract<TaskInputV2, { kind: "process_recording" }>,
      "schemaVersion"
    > & {
      schemaVersion: 3;
      recipe: RecipeV1;
      /** sa-cjson-v1 digest of recipe. */
      recipeSha256: Sha256Hex;
    })
  | (Omit<Extract<TaskInputV2, { kind: "export_release" }>, "schemaVersion"> & {
      schemaVersion: 3;
    });
export type StageReceiptV1 = {
  schemaVersion: 1;
  jobId: Uuid;
  stage: Stage;
  module: ModuleRef;
  status: "succeeded" | "failed";
  errorCode: string | null;
  outputs: {
    fileId: Uuid;
    role: OutputFileRoleV2;
    sizeBytes: DecimalBytes;
    sha256: Sha256Hex;
  }[];
  counts: Record<string, number>;
  gpu: { requestedType: GpuType; observedType: string | null };
  startedAt: Rfc3339Utc;
  finishedAt: Rfc3339Utc;
};
export type StageProviderEvidence = Pick<
  ModalRerunBinding,
  | "appName"
  | "codeRevision"
  | "environment"
  | "functionId"
  | "definitionId"
  | "paramsSha256"
  | "definitionSha256"
> & { workerReceiptSha256: Sha256Hex };
export type StageReceiptV2 = Omit<StageReceiptV1, "schemaVersion"> & {
  schemaVersion: 2;
  providerBinding: StageProviderEvidence;
};
export type StageReceipt = StageReceiptV1 | StageReceiptV2;
export type ControllerActionV4 =
  | Exclude<ControllerActionV3, { action: "record_stage_run" }>
  | (Omit<
      Extract<ControllerActionV2, { action: "record_stage_run" }>,
      "receipt"
    > & { receipt?: StageReceipt });
export type ControllerActionV2 =
  | ControllerAction
  | { action: "issue_stage_claim"; owner: string; stage: Stage }
  | {
      action: "record_stage_run";
      owner: string;
      stage: Stage;
      state: StageRunState;
      module: ModuleRef;
      /** Executor call identity only; never spawn authority. */
      callId?: string;
      /** Present exactly for failed, cancelled and not_run. */
      errorCode?: string;
      /** Required for succeeded; allowed for failed. */
      receipt?: StageReceiptV1;
    };
export type ControllerActionV3 =
  | ControllerActionV2
  | {
      action: "start_parallel_recipe" | "seal_parallel_recipe";
      owner: string;
    };
export type HeartbeatV2 = Omit<Heartbeat, "schemaVersion" | "phase"> & {
  schemaVersion: 2;
  stage: Stage;
  phase: Heartbeat["phase"] | "remuxing" | "segmenting" | "captioning";
};
export type ResultNode<S extends Stage> = {
  stage: S;
  status: S extends "hand_pose"
    ? "succeeded" | "failed"
    : "succeeded" | "failed" | "not_run";
  module: ModuleRef;
  error_code: string | null;
  outputs: Uuid[];
  counts: Record<string, number>;
};
export type ProcessingResultV3 = Omit<
  ProcessingResultV1,
  "schema" | "outputs"
> & {
  schema: "stateaction.processing_result.v3";
  outputs: {
    file_id: Uuid;
    role: OutputFileRoleV2;
    relative_path: string;
    size_bytes: DecimalBytes;
    sha256: Sha256Hex;
  }[];
  attestation: {
    invocation_nonce: string;
    rgb_profile: HardwareRgbProfile | SimulationRgbProfile;
    source_file_id: Uuid;
    source_eof_verified: boolean;
  };
  simulation?: unknown;
  recipe_id: string;
  recipe_sha256: Sha256Hex;
  nodes: [
    ResultNode<"segment">,
    ResultNode<"caption">,
    ResultNode<"hand_pose">,
  ];
};
export type DagRunNode = {
  stage: Stage;
  enabled: boolean;
  module: ModuleRef;
  state: StageRunState;
  errorCode: string | null;
  callId: string | null;
  gpu: { requestedType: GpuType; observedType: string | null };
  startedAt: Rfc3339Utc | null;
  finishedAt: Rfc3339Utc | null;
  counts: Record<string, number>;
  estimatedCostUsd: UsdAmount | null;
  receiptSha256: Sha256Hex | null;
};
/** Server-rendered from recorded stage runs; never an uploaded output. */
export type DagRunV1 = {
  schemaVersion: 1;
  jobId: Uuid;
  recordingId: Uuid;
  jobState: JobState;
  recipeId: string;
  recipeSha256: Sha256Hex;
  maxJobCostUsd: UsdAmount;
  estimatedCostUsd: UsdAmount | null;
  stages: DagRunNode[];
  renderedAt: Rfc3339Utc;
};

/** GET /internal/v1/jobs/{jobId}/prior-stages: recorded stage runs with their attributed output files. Never spawn authority. */
export type PriorStagesV1 = {
  schemaVersion: 1;
  jobId: Uuid;
  stages: {
    stage: "segment" | "caption";
    state: StageRunState;
    errorCode: string | null;
    counts: Record<string, number>;
    outputs: {
      fileId: Uuid;
      role: OutputFileRoleV2;
      slot: string;
      sizeBytes: DecimalBytes;
      sha256: Sha256Hex;
    }[];
  }[];
};

/**
 * GET /api/v1/recordings/{recordingId}/annotations and its ?download=1 file (staff). Each part is the
 * published stage artifact embedded unchanged (dag_run keeps its camelCase rendering); a part is null
 * only when its stage produced nothing and dag_run says why.
 */
export type RecordingAnnotationsV1 = {
  schema: "stateaction.recording-annotations.v1";
  recording_id: Uuid;
  job_id: Uuid;
  segments: SegmentsV1 | null;
  captions: CaptionsV1 | null;
  hand_presence: HandPresenceV1 | null;
  dag_run: DagRunV1 | null;
};

/** Decode ordinals are half-open. IDs and timestamps name the included endpoints. */
export type SourceFrameRange = {
  start_ordinal: number;
  end_ordinal: number;
  first_source_frame_id: string;
  last_source_frame_id: string;
  start_ts_ns: string;
  end_ts_ns: string;
};

export type ClipPlanV1 = {
  schema: "stateaction.clip-plan.v1";
  recording_id: string;
  plan_version: number;
  source_manifest_sha256: Sha256Hex;
  frame_count: number;
  origin_ts_ns: string;
  clock_domain: string;
  mode: "passthrough" | "shadow" | "apply";
  state: "succeeded" | "failed";
  error_code: string | null;
  filter_version: string;
  params_sha256: Sha256Hex;
  producer: {
    module_id: string;
    revision: string;
    weights_sha256: Sha256Hex | null;
    gpu_type: string | null;
  };
  spans: (SourceFrameRange &
    (
      | { kind: "clip" }
      | {
          kind: "excluded";
          reason:
            | "walking"
            | "idle"
            | "no_hand"
            | "talking"
            | "judge_no_action";
          signals: ParamMap;
          thresholds: ParamMap;
          filter_version: string;
        }
    ))[];
};

export type RecipeV2 = Omit<RecipeV1, "schemaVersion"> & {
  schemaVersion: 2;
  clipFilter: {
    mode: "passthrough";
    module: "clip_filter@0";
    params: Record<string, never>;
  };
};

export type ReviewClip = {
  id: string;
  recordingId: string;
  planVersion: number;
  ordinal: number;
  /** Null when a legacy recording has no verified frame boundaries. */
  sourceRange: SourceFrameRange | null;
  liveJobId: string | null;
  selectedJobId: string | null;
};

export type ClipTaskInputV4 = Omit<
  Extract<TaskInputV3, { kind: "process_recording" }>,
  "schemaVersion"
> & {
  schemaVersion: 4;
  clip: {
    id: string;
    planVersion: number;
    planSha256: Sha256Hex;
    sourceRange: SourceFrameRange & { kind: "clip" };
  };
};

export type ClipPlanTaskInputV5 = Omit<
  ClipTaskInputV4,
  "schemaVersion" | "kind" | "recipe" | "recipeSha256" | "clip"
> & {
  schemaVersion: 5;
  kind: "clip_plan";
  planVersion: number;
  clipFilter: RecipeV2["clipFilter"];
};
