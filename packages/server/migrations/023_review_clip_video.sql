SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION public.job_output_slot_role_ok(p_slot text, p_role text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN p_slot = 'result-manifest.json' THEN p_role = 'result_manifest'
    WHEN p_slot = 'review-clip.mp4' OR p_slot ~ '^clips/[0-9]{3}/rgb\.mp4$' THEN p_role = 'clip_mp4'
    WHEN p_slot ~ '^clips/[0-9]{3}/hand-arrays\.npz$' THEN p_role = 'hand_arrays_npz'
    WHEN p_slot ~ '^clips/[0-9]{3}/hand-observations\.json$' THEN p_role = 'hand_observations_json'
    WHEN p_slot ~ '^clips/[0-9]{3}/frame-map\.json$' THEN p_role = 'frame_map_json'
    WHEN p_slot ~ '^clips/[0-9]{3}/thumbnail\.jpg$' THEN p_role = 'thumbnail_jpeg'
    WHEN p_slot ~ '^clips/[0-9]{3}/viewer\.rrd$' THEN p_role = 'viewer_rrd'
    WHEN p_slot = 'segments.json' THEN p_role = 'segments_json'
    WHEN p_slot = 'captions.json' THEN p_role = 'captions_json'
    WHEN p_slot = 'hand-presence.json' THEN p_role = 'hand_presence_json'
    WHEN p_slot = 'recording.mp4' THEN p_role = 'recording_mp4'
    WHEN p_slot ~ '^diagnostics/(segment|caption|hand_pose)/[a-z0-9_.-]{1,64}$'
         AND p_slot !~ '/\.{1,2}$' THEN p_role = 'diagnostic_blob'
    ELSE false
  END
$$;

-- A CPU-only media backfill is separate from the already sealed job inventory.
CREATE TABLE public.review_clip_video_backfills (
  job_id uuid PRIMARY KEY,
  clip_id uuid NOT NULL,
  result_manifest_sha256 public.sha256_hex NOT NULL,
  clip_plan_sha256 public.sha256_hex NOT NULL,
  source_sha256 public.sha256_hex NOT NULL,
  sha256 public.sha256_hex NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 4294967296),
  object_key text GENERATED ALWAYS AS (
    'review-clip-video/' || job_id::text || '/' || sha256::text || '.mp4'
  ) STORED UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, clip_id) REFERENCES public.jobs (id, clip_id),
  FOREIGN KEY (job_id, result_manifest_sha256) REFERENCES public.jobs (id, result_manifest_sha256)
);

CREATE TRIGGER review_clip_video_backfills_immutable
  BEFORE UPDATE OR DELETE ON public.review_clip_video_backfills
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER review_clip_video_backfills_no_truncate
  BEFORE TRUNCATE ON public.review_clip_video_backfills
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

CREATE FUNCTION public.stateaction_grant_review_clip_video(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON public.review_clip_video_backfills FROM %I', app_role);
  EXECUTE format('GRANT SELECT ON public.review_clip_video_backfills TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_review_clip_video(name) FROM PUBLIC;
