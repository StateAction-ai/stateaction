import {
  REVIEW_VIDEO_MAX_BYTES,
  REVIEW_VIDEO_SLOT,
} from "./review-video-policy.js";

/** A recording-scoped job bound to migration 017's whole-recording clip. */
export const LEGACY_WHOLE_RECORDING_BINDING = `
  vp.plan_job_id IS NULL AND vc.start_ordinal IS NULL AND vc.end_ordinal IS NULL
  AND vc.id = vc.recording_id AND vc.ordinal = 0
  AND vj.clip_id = vc.id AND vj.recording_id = vc.recording_id`;

/** Find the playable artifact for an already authorized selected review result. */
export function verifiedReviewVideoSql(result: string): string {
  return `
    SELECT video.object_key, video.size_bytes
    FROM review_clips vc
    JOIN clip_plans vp ON vp.recording_id = vc.recording_id AND vp.version = vc.plan_version
    JOIN jobs vj ON vj.id = ${result}.job_id
    JOIN LATERAL (
      SELECT f.object_key, f.size_bytes, 1 AS priority
      FROM job_output_slots s
      JOIN files f ON f.id = s.file_id AND f.job_id = vj.id
        AND f.purpose = 'output' AND f.role = 'clip_mp4' AND f.state = 'verified'
      WHERE s.job_id = vj.id AND s.slot = '${REVIEW_VIDEO_SLOT}'
        AND vj.kind = 'clip_pipeline' AND vc.start_ordinal IS NOT NULL
        AND f.size_bytes BETWEEN 1 AND ${REVIEW_VIDEO_MAX_BYTES}
      UNION ALL
      SELECT b.object_key, b.size_bytes, 2
      FROM review_clip_video_backfills b
      WHERE b.job_id = vj.id AND b.clip_id = vc.id
        AND b.result_manifest_sha256 = ${result}.manifest AND b.clip_plan_sha256 = vp.manifest_sha256
        AND vj.kind = 'clip_pipeline' AND vc.start_ordinal IS NOT NULL
      UNION ALL
      SELECT f.object_key, f.size_bytes, 3
      FROM job_output_slots s
      JOIN files f ON f.id = s.file_id AND f.job_id = s.job_id
        AND f.purpose = 'output' AND f.role = 'recording_mp4' AND f.state = 'verified'
      WHERE s.slot = 'recording.mp4' AND (
        (s.job_id = vj.id AND ${LEGACY_WHOLE_RECORDING_BINDING} AND (
          vj.kind = 'process_recording'
          OR (vj.kind = 'cached_import' AND ${result}.imported_from_cache
            AND EXISTS (SELECT 1 FROM cached_processing_imports i WHERE i.job_id = vj.id))))
        OR (s.job_id = vp.plan_job_id AND vc.start_ordinal = 0 AND vc.end_ordinal = vp.frame_count
          AND f.id = vp.original_mp4_file_id AND f.sha256 = vp.original_mp4_sha256
          AND EXISTS (SELECT 1 FROM jobs plan_job WHERE plan_job.id = vp.plan_job_id
            AND plan_job.state = 'succeeded' AND plan_job.result_manifest_sha256 = vp.manifest_sha256))
      )
      ORDER BY priority LIMIT 1
    ) video ON true
    WHERE vc.id = ${result}.clip_id`;
}
