import { createHash } from "node:crypto";
import {
  contractMaxBytes,
  validateBytes,
  type FrameMapV1,
  type HandObservationsV1,
} from "@stateaction/contracts";
import { ObjectReadUnavailableError } from "../admission/object-reader.js";
import { ObjectTooLargeError } from "../admission/recordings.js";
import { TransportError } from "../transport/errors.js";
import type { AnnotationDeps } from "./annotations.js";

export type ClipHandFrames = {
  raster: { width: number; height: number };
  frames: {
    ptsUs: number;
    sourceFrameId: string;
    timestampNs: string;
    hands: { side: "left" | "right"; points: ([number, number] | null)[] }[];
  }[];
};

function invalidFrames(): never {
  throw new TransportError(
    "conflict",
    "Hand frames do not match the recording",
  );
}

export function handFramesFromArtifacts(
  map: FrameMapV1,
  observations: HandObservationsV1,
  origin: FrameMapV1,
): ClipHandFrames {
  if (
    map.job_id !== observations.job_id ||
    map.job_id !== origin.job_id ||
    map.clip_id !== observations.clip_id ||
    map.frame_count !== observations.frame_count ||
    map.rows.length !== observations.frames.length ||
    map.rows.length === 0 ||
    map.time_base.num !== 1 ||
    map.time_base.den !== 1_000_000 ||
    origin.time_base.num !== 1 ||
    origin.time_base.den !== 1_000_000 ||
    !origin.rows[0]
  )
    invalidFrames();

  const first = BigInt(origin.rows[0].source_pts);
  const raster = observations.image_space.raster;
  let lastPts = -1;
  const frames = map.rows.map((row, index) => {
    const frame = observations.frames[index];
    const ptsUs = Number(BigInt(row.source_pts) - first);
    const { crop, mirrored, rotation_degrees } = row.transform;
    if (
      !frame ||
      row.frame_index !== index ||
      frame.frame_index !== index ||
      !Number.isSafeInteger(ptsUs) ||
      ptsUs <= lastPts ||
      row.raster.width !== raster.width ||
      row.raster.height !== raster.height ||
      mirrored ||
      rotation_degrees !== 0 ||
      crop.x !== 0 ||
      crop.y !== 0 ||
      crop.width !== raster.width ||
      crop.height !== raster.height
    )
      invalidFrames();
    lastPts = ptsUs;
    return {
      ptsUs,
      sourceFrameId: row.source_frame_id,
      timestampNs: row.timestamp_ns,
      hands: frame.hands.map((h) => ({
        side: h.handedness,
        points: h.image_landmarks_px.map((point, joint) =>
          h.image_mask[joint] ? point : null,
        ),
      })),
    };
  });
  return { raster, frames };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type FileRow = {
  part: "map" | "hands" | "origin";
  clip_id: string;
  producer_clip_id: string | null;
  producer_job_id: string;
  object_key: string;
  size_bytes: string;
  sha256: string;
};

async function readArtifact(deps: AnnotationDeps, file: FileRow) {
  const contract =
    file.part === "hands"
      ? "artifacts.hand-observations.v1"
      : "artifacts.frame-map.v1";
  const max = contractMaxBytes(contract);
  if (!file.producer_clip_id || BigInt(file.size_bytes) > BigInt(max))
    invalidFrames();
  let bytes: Uint8Array;
  try {
    bytes = await deps.reader.read(file.object_key, max);
  } catch (error) {
    if (error instanceof ObjectTooLargeError) invalidFrames();
    if (error instanceof ObjectReadUnavailableError)
      throw new TransportError(
        "provider_unavailable",
        "Hand frames could not be read",
      );
    throw error;
  }
  if (
    String(bytes.byteLength) !== file.size_bytes ||
    createHash("sha256").update(bytes).digest("hex") !== file.sha256
  )
    invalidFrames();
  const result = validateBytes(contract, bytes);
  if (!result.valid) invalidFrames();
  const value = result.value as FrameMapV1 | HandObservationsV1;
  if (
    value.clip_id !== file.producer_clip_id ||
    value.job_id !== file.producer_job_id
  )
    invalidFrames();
  return value;
}

export async function loadClipHandFrames(
  deps: AnnotationDeps,
  userId: string,
  recordingId: string,
  jobId: string,
  clipId: string,
  viewHistorical = false,
): Promise<ClipHandFrames> {
  const notFound = () =>
    new TransportError("not_found", "Hand frames not found");
  if (!UUID.test(jobId) || !UUID.test(clipId)) throw notFound();
  const { rows } = await deps.pool.query<FileRow>(
    `SELECT part.name AS part, part.clip_id, f.object_key, f.size_bytes::text, f.sha256,
            coalesce(copy.original_job_id, f.job_id) AS producer_job_id,
            CASE WHEN copy.file_id IS NULL THEN part.clip_id ELSE producer.id END AS producer_clip_id
     FROM clips c
     JOIN recordings rec ON rec.id = c.recording_id
       AND rec.deleted_at IS NULL
     JOIN jobs j ON j.id = c.job_id AND j.recording_id = rec.id AND j.state = 'succeeded'
     JOIN LATERAL (
       SELECT id, frame_map_file_id FROM clips
       WHERE job_id = c.job_id ORDER BY ordinal LIMIT 1
     ) first_clip ON true
     CROSS JOIN LATERAL (VALUES
       ('map', c.id, c.frame_map_file_id, 'frame_map_json'),
       ('hands', c.id, c.hand_observations_file_id, 'hand_observations_json'),
       ('origin', first_clip.id, first_clip.frame_map_file_id, 'frame_map_json')
     ) part(name, clip_id, file_id, role)
     JOIN files f ON f.id = part.file_id AND f.job_id = c.job_id
       AND f.purpose = 'output' AND f.role::text = part.role
       AND f.state IN ('completed', 'verified')
     LEFT JOIN job_rerun_copies copy ON copy.file_id = f.id AND copy.job_id = f.job_id
       AND copy.sha256 = f.sha256 AND copy.stage = 'hand_pose'
       AND copy.role = part.role AND copy.target_ready
     LEFT JOIN clips producer ON producer.job_id = copy.original_job_id AND producer.recording_id = rec.id
       AND copy.original_file_id = CASE part.role
         WHEN 'frame_map_json' THEN producer.frame_map_file_id
         WHEN 'hand_observations_json' THEN producer.hand_observations_file_id
       END
     WHERE rec.id = $2 AND c.job_id = $3 AND c.id = $4
       AND ($5::boolean OR c.job_id = coalesce(recording_selected_job(rec.id), rec.current_job_id))
       AND catalog_has_role($1, 'staff')`,
    [userId, recordingId, jobId, clipId, viewHistorical],
  );
  const mapFile = rows.find((row) => row.part === "map");
  const handFile = rows.find((row) => row.part === "hands");
  const originFile = rows.find((row) => row.part === "origin");
  if (!mapFile || !handFile || !originFile) throw notFound();

  const map = readArtifact(deps, mapFile) as Promise<FrameMapV1>;
  const [frameMap, hands, origin] = await Promise.all([
    map,
    readArtifact(deps, handFile) as Promise<HandObservationsV1>,
    originFile.clip_id === clipId
      ? map
      : (readArtifact(deps, originFile) as Promise<FrameMapV1>),
  ]);
  return handFramesFromArtifacts(frameMap, hands, origin);
}
