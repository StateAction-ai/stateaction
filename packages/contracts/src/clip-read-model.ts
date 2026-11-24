import type {
  AuthUserId,
  ClipPlanV1,
  DagRunNode,
  DagRunV1,
  DecimalBytes,
  JobState,
  RecordingAnnotations,
  ReviewClip,
  Rfc3339Utc,
  SegmentMarks,
  Sha256Hex,
  TimestampNs,
  UsdAmount,
  Uuid,
} from "./types.js";

export type ClipPipelineState =
  | "queued"
  | "processing"
  | "succeeded"
  | "partially_failed"
  | "failed";

export type ClipQueueStatus = "not_ready" | "pending" | "approved" | "rejected";

export type ClipListQuery = {
  recordingId?: Uuid;
  collectorId?: AuthUserId;
  pipelineState?: ClipPipelineState;
  reviewStatus?: ClipQueueStatus;
  cursor?: string;
  limit?: number;
};

export type ClipSelectedResultRef = {
  jobId: Uuid;
  resultManifestSha256: Sha256Hex;
  selectionRevision: number | null;
  source: "processed" | "imported";
};

export type ClipPipelineSummary = {
  state: ClipPipelineState;
  jobState: JobState | null;
  errorCode: string | null;
  estimatedCostUsd: UsdAmount | null;
  stages: DagRunNode[];
  /** Null fields mean the accepted stage did not produce a count. */
  failureCounts?: {
    failedWindows: number | null;
    failedCaptions: number | null;
  };
};

export type ClipListItem = ReviewClip & {
  recordingTitle: string;
  collectorId: AuthUserId;
  collectorName?: string;
  createdAt: Rfc3339Utc;
  sourceOffsetNs: string | null;
  durationNs: string | null;
  pipeline: ClipPipelineSummary;
  reviewStatus: ClipQueueStatus;
  selectedResult: ClipSelectedResultRef | null;
  marks: Pick<
    SegmentMarks,
    "segmentCount" | "checkedCount" | "issueCount"
  > | null;
};

export type ClipListPage = {
  clips: ClipListItem[];
  nextCursor: string | null;
};

export type ClipViewerChunk = {
  chunkId: Uuid;
  startNs: TimestampNs;
  endNs: TimestampNs;
};

export type ClipSelectedResult = ClipSelectedResultRef & {
  annotations: RecordingAnnotations | null;
  segmentMarks: SegmentMarks | null;
  viewerChunkIds: Uuid[];
  /** Checked spans in viewer-chunk ordinal order. Projection adapters may omit this field. */
  viewerChunks?: ClipViewerChunk[];
};

export type ClipDetail = ClipListItem & {
  currentDag: DagRunV1 | null;
  selectedDag: DagRunV1 | null;
  canReadOriginal: boolean;
};

export type ClipRecordingDetail = {
  id: Uuid;
  title: string;
  state: ClipPipelineState;
  plan: ClipPlanV1 | null;
  canReadOriginal: boolean;
  clips: ClipListItem[];
};

/** A review clip plays the matching time range of this original video. */
export type ClipSourceRead = {
  url: string;
  role: "recording_mp4";
  contentType: "video/mp4";
  sizeBytes: DecimalBytes;
  expiresAt: Rfc3339Utc;
  ttlSeconds: number;
};

/** Server-side read port. viewerUserId comes from the authenticated principal. */
export interface ClipReadModel {
  listClips(
    viewerUserId: AuthUserId,
    query: ClipListQuery,
  ): Promise<ClipListPage>;
  getClip(viewerUserId: AuthUserId, clipId: Uuid): Promise<ClipDetail | null>;
  getSelectedResult(
    viewerUserId: AuthUserId,
    clipId: Uuid,
    selected: ClipSelectedResultRef,
  ): Promise<ClipSelectedResult | null>;
  getRecording(
    viewerUserId: AuthUserId,
    recordingId: Uuid,
  ): Promise<ClipRecordingDetail | null>;
  readSource(
    viewerUserId: AuthUserId,
    recordingId: Uuid,
  ): Promise<ClipSourceRead | null>;
}
