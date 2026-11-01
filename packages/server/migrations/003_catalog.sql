-- SA-13 catalog: nine MVP domain tables. No releases table in the MVP; the
-- Dataset-version follow-up adds it additively. Invariants that must hold for
-- every credential (immutable identity, append-only reviews, approved-only
-- membership) are enforced by constraints/triggers; privileges for the
-- restricted application role are applied by stateaction_grant_app_role().
--
-- Lock order for review/membership writes (documented in
-- docs/components/catalog.md): 1. clip locks via catalog_lock_clip(), sorted
-- by clip UUID; 2. dataset rows FOR UPDATE, sorted by dataset UUID. Triggers
-- take the same clip lock so a membership insert and a rejection serialize.
-- All catalog writes use READ COMMITTED.
CREATE DOMAIN sha256_hex AS text CHECK (VALUE ~ '^[0-9a-f]{64}$');

CREATE FUNCTION catalog_raise(code text, message text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = code, MESSAGE = message;
END $$;
-- SQLSTATE classes used by the catalog (mapped by src/catalog/errors.ts):
--   SAC01 immutable/append-only violation   SAC02 clip not approved
--   SAC03 revision/sequence conflict        SAC04 invalid lifecycle state
--   SAC05 not authorized for this operation
-- Every function pins search_path = pg_catalog, public, pg_temp and
-- schema-qualifies relations, so session TEMP objects can never shadow them.

-- Transaction-scoped clip lock usable without UPDATE privilege on clips.
CREATE FUNCTION catalog_lock_clip(clip uuid) RETURNS void
LANGUAGE sql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT pg_advisory_xact_lock(7430013, hashtext(clip::text));
$$;

-- 1. access: operator-managed pilot roles.
CREATE TABLE access (
  user_id text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('collector', 'staff', 'customer')),
  enabled boolean NOT NULL DEFAULT true,
  granted_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);
CREATE INDEX access_role_enabled_idx ON access (role, user_id) WHERE enabled;

CREATE FUNCTION catalog_has_role(member text, wanted text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.access WHERE user_id = member AND role = wanted AND enabled
  );
$$;

-- 2. recordings: immutable owner/client capture identity.
CREATE TABLE recordings (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  client_recording_id uuid NOT NULL,
  capture_format text NOT NULL CHECK (capture_format = 'stateaction.capture.v1'),
  rgb_profile text NOT NULL CHECK (rgb_profile = 'h264_mcap_v1'),
  started_at timestamptz NOT NULL,
  device jsonb NOT NULL CHECK (
    jsonb_typeof(device) = 'object' AND octet_length(device::text) <= 4096
  ),
  status text NOT NULL DEFAULT 'registered' CHECK (status IN (
    'registered', 'uploading', 'sealed', 'uploaded', 'processing',
    'reviewable', 'failed', 'cancelled'
  )),
  -- The sealed recording-source/v1 document: a logical source file with role
  -- source_manifest owned by this recording, pinned by its exact SHA-256.
  source_manifest_file_id uuid,
  source_manifest_sha256 sha256_hex,
  current_job_id uuid,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, client_recording_id),
  UNIQUE (id, source_manifest_sha256),
  CHECK ((source_manifest_file_id IS NULL) = (source_manifest_sha256 IS NULL)),
  CHECK (
    status IN ('registered', 'uploading', 'cancelled', 'failed')
    OR source_manifest_file_id IS NOT NULL
  )
);
CREATE INDEX recordings_owner_created_idx ON recordings (owner_user_id, created_at DESC, id DESC);
CREATE INDEX recordings_created_idx ON recordings (created_at DESC, id DESC);

-- 3. jobs: one row per intentional processing attempt.
CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind = 'process_recording'),
  recording_id uuid NOT NULL REFERENCES recordings (id),
  previous_job_id uuid UNIQUE,
  source_manifest_sha256 sha256_hex NOT NULL,
  profile_revision text NOT NULL CHECK (length(profile_revision) BETWEEN 1 AND 128),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'submitting', 'submit_unknown', 'running', 'result_pending',
    'succeeded', 'failed', 'cancel_requested', 'cancelled', 'needs_attention'
  )),
  controller_lease_owner text CHECK (length(controller_lease_owner) <= 200),
  controller_lease_expires_at timestamptz,
  workflow_run_ref text UNIQUE CHECK (length(workflow_run_ref) <= 200),
  submission_intent_at timestamptz,
  execution_call_id text UNIQUE CHECK (length(execution_call_id) <= 200),
  invocation_nonce text UNIQUE CHECK (length(invocation_nonce) BETWEEN 16 AND 200),
  capability_token_sha256 sha256_hex,
  start_deadline timestamptz,
  execution_deadline timestamptz,
  result_manifest_file_id uuid,
  result_manifest_sha256 sha256_hex,
  error_code text CHECK (length(error_code) <= 100),
  error_message text CHECK (length(error_message) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (id, recording_id),
  UNIQUE (id, result_manifest_sha256),
  -- Job input digest is the recording's sealed source manifest digest.
  FOREIGN KEY (recording_id, source_manifest_sha256)
    REFERENCES recordings (id, source_manifest_sha256),
  -- A retry stays within the same recording.
  FOREIGN KEY (previous_job_id, recording_id) REFERENCES jobs (id, recording_id),
  CHECK (previous_job_id IS DISTINCT FROM id),
  CHECK ((result_manifest_file_id IS NULL) = (result_manifest_sha256 IS NULL)),
  CHECK (state <> 'succeeded' OR result_manifest_file_id IS NOT NULL),
  CHECK ((state IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
);
-- At most one live attempt per recording.
CREATE UNIQUE INDEX jobs_one_active_per_recording_idx ON jobs (recording_id)
  WHERE state NOT IN ('succeeded', 'failed', 'cancelled');
CREATE INDEX jobs_recording_created_idx ON jobs (recording_id, created_at DESC);
CREATE INDEX jobs_open_state_idx ON jobs (state, updated_at)
  WHERE state NOT IN ('succeeded', 'failed', 'cancelled');

ALTER TABLE recordings ADD FOREIGN KEY (current_job_id, id)
  REFERENCES jobs (id, recording_id);

-- 4. files: logical source and output files with a never-reused object key.
CREATE TABLE files (
  id uuid PRIMARY KEY,
  recording_id uuid NOT NULL REFERENCES recordings (id),
  job_id uuid,
  purpose text NOT NULL CHECK (purpose IN ('source', 'output')),
  role text NOT NULL CHECK (role IN (
    'source_manifest', 'source_mcap', 'recorder_metadata', 'calibration',
    'result_manifest', 'clip_mp4', 'hand_arrays_npz', 'hand_observations_json',
    'frame_map_json', 'thumbnail_jpeg', 'viewer_rrd'
  )),
  required boolean NOT NULL DEFAULT true,
  client_upload_id uuid,
  request_digest sha256_hex,
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 107374182400),
  sha256 sha256_hex NOT NULL,
  observed_size_bytes bigint CHECK (observed_size_bytes >= 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN (
    'reserved', 'uploading', 'completing', 'completed', 'verified',
    'cancelled', 'failed', 'expired'
  )),
  transport_epoch integer NOT NULL DEFAULT 1 CHECK (transport_epoch >= 1),
  object_key text NOT NULL UNIQUE CHECK (length(object_key) <= 512),
  provider_upload_id text UNIQUE CHECK (length(provider_upload_id) <= 1024),
  part_size_bytes bigint NOT NULL CHECK (part_size_bytes > 0),
  part_count integer NOT NULL CHECK (part_count BETWEEN 1 AND 10000),
  transport_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recording_id, client_upload_id),
  UNIQUE (id, recording_id, sha256),
  UNIQUE (id, job_id),
  UNIQUE (id, job_id, sha256),
  FOREIGN KEY (job_id, recording_id) REFERENCES jobs (id, recording_id),
  CHECK (
    (purpose = 'source' AND job_id IS NULL AND client_upload_id IS NOT NULL
      AND request_digest IS NOT NULL
      AND role IN ('source_manifest', 'source_mcap', 'recorder_metadata', 'calibration'))
    OR
    (purpose = 'output' AND job_id IS NOT NULL AND client_upload_id IS NULL
      AND request_digest IS NULL
      AND role IN ('result_manifest', 'clip_mp4', 'hand_arrays_npz',
        'hand_observations_json', 'frame_map_json', 'thumbnail_jpeg', 'viewer_rrd'))
  ),
  CHECK (role <> 'source_manifest' OR size_bytes <= 1048576),
  CHECK (role NOT IN ('source_manifest', 'source_mcap') OR required),
  -- Key embeds file ID and transport epoch, so a key is never reused.
  CHECK (
    (purpose = 'source' AND object_key LIKE
      'recordings/' || recording_id || '/sources/' || id || '/e' || transport_epoch || '/_%')
    OR
    (purpose = 'output' AND object_key LIKE
      'jobs/' || job_id || '/outputs/' || id || '/e' || transport_epoch || '/_%')
  ),
  CHECK (
    state NOT IN ('completed', 'verified')
    OR (observed_size_bytes = size_bytes AND completed_at IS NOT NULL)
  )
);
-- v1 recordings have exactly one live source manifest and one live MCAP,
-- both required; metadata/calibration may be multiple as declared.
CREATE UNIQUE INDEX files_one_source_manifest_idx ON files (recording_id)
  WHERE role = 'source_manifest' AND state NOT IN ('cancelled', 'failed', 'expired');
CREATE UNIQUE INDEX files_one_source_mcap_idx ON files (recording_id)
  WHERE role = 'source_mcap' AND state NOT IN ('cancelled', 'failed', 'expired');
CREATE INDEX files_recording_role_idx ON files (recording_id, role);
CREATE INDEX files_job_idx ON files (job_id) WHERE job_id IS NOT NULL;

ALTER TABLE recordings ADD FOREIGN KEY (source_manifest_file_id, id, source_manifest_sha256)
  REFERENCES files (id, recording_id, sha256);
ALTER TABLE jobs ADD FOREIGN KEY (result_manifest_file_id, id, result_manifest_sha256)
  REFERENCES files (id, job_id, sha256);

-- 5. clips: immutable processing outputs.
CREATE TABLE clips (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  source_start_ns bigint NOT NULL CHECK (source_start_ns >= 0),
  source_end_ns bigint NOT NULL,
  duration_ns bigint NOT NULL CHECK (duration_ns > 0),
  clock_domain text NOT NULL CHECK (length(clock_domain) BETWEEN 1 AND 100),
  raster_width integer NOT NULL CHECK (raster_width > 0),
  raster_height integer NOT NULL CHECK (raster_height > 0),
  frame_count integer NOT NULL CHECK (frame_count > 0),
  rgb_mp4_file_id uuid NOT NULL UNIQUE,
  hand_arrays_file_id uuid NOT NULL UNIQUE,
  hand_observations_file_id uuid NOT NULL UNIQUE,
  frame_map_file_id uuid NOT NULL UNIQUE,
  thumbnail_file_id uuid NOT NULL UNIQUE,
  viewer_rrd_file_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, ordinal),
  UNIQUE (id, job_id),
  CHECK (source_end_ns > source_start_ns),
  FOREIGN KEY (job_id, recording_id) REFERENCES jobs (id, recording_id),
  FOREIGN KEY (rgb_mp4_file_id, job_id) REFERENCES files (id, job_id),
  FOREIGN KEY (hand_arrays_file_id, job_id) REFERENCES files (id, job_id),
  FOREIGN KEY (hand_observations_file_id, job_id) REFERENCES files (id, job_id),
  FOREIGN KEY (frame_map_file_id, job_id) REFERENCES files (id, job_id),
  FOREIGN KEY (thumbnail_file_id, job_id) REFERENCES files (id, job_id),
  FOREIGN KEY (viewer_rrd_file_id, job_id) REFERENCES files (id, job_id)
);
CREATE INDEX clips_recording_created_idx ON clips (recording_id, created_at DESC, id DESC);
CREATE INDEX clips_created_idx ON clips (created_at DESC, id DESC);

-- 6. reviews: append-only revisions pinned to the exact successful result.
CREATE TABLE reviews (
  id uuid PRIMARY KEY,
  clip_id uuid NOT NULL,
  job_id uuid NOT NULL,
  result_manifest_sha256 sha256_hex NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  reviewer_user_id text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  task_label text CHECK (length(task_label) <= 200),
  notes text CHECK (length(notes) <= 4000),
  -- Submitted datasetSelection {datasetIds, expectedRevisions}, bounded.
  dataset_selection jsonb CHECK (
    dataset_selection IS NULL OR (
      jsonb_typeof(dataset_selection) = 'object'
      AND octet_length(dataset_selection::text) <= 16384
    )
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clip_id, revision),
  UNIQUE (job_id, clip_id, revision),
  FOREIGN KEY (clip_id, job_id) REFERENCES clips (id, job_id),
  FOREIGN KEY (job_id, result_manifest_sha256) REFERENCES jobs (id, result_manifest_sha256),
  CHECK (decision <> 'approved' OR length(btrim(task_label)) >= 1),
  CHECK (decision = 'approved' OR dataset_selection IS NULL)
);
-- Latest review: backward scan of the (clip_id, revision) unique index.
CREATE INDEX reviews_reviewer_created_idx ON reviews (reviewer_user_id, created_at DESC);

-- 7. datasets: mutable working groupings with optimistic revisions.
CREATE TABLE datasets (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  updated_by text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX datasets_created_idx ON datasets (created_at DESC, id DESC);

-- 8. dataset_clips: many-to-many membership, approved clips only.
CREATE TABLE dataset_clips (
  dataset_id uuid NOT NULL REFERENCES datasets (id),
  clip_id uuid NOT NULL REFERENCES clips (id),
  added_by text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, clip_id)
);
CREATE INDEX dataset_clips_clip_idx ON dataset_clips (clip_id);
CREATE INDEX dataset_clips_page_idx ON dataset_clips (dataset_id, added_at DESC, clip_id DESC);

-- 9. dataset_access: customer view grants.
CREATE TABLE dataset_access (
  dataset_id uuid NOT NULL REFERENCES datasets (id),
  user_id text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT true,
  granted_by text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  permission_evidence_ref text NOT NULL CHECK (length(permission_evidence_ref) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, user_id)
);
CREATE INDEX dataset_access_user_idx ON dataset_access (user_id, dataset_id) WHERE enabled;

-- ---------------------------------------------------------------- triggers
CREATE FUNCTION catalog_forbid_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.catalog_raise('SAC01', TG_TABLE_NAME || ' rows are immutable (' || TG_OP || ')');
  RETURN NULL;
END $$;

CREATE FUNCTION catalog_file_is_closed(file uuid, wanted_role text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.files
    WHERE id = file AND role = wanted_role AND state IN ('completed', 'verified')
  );
$$;

CREATE FUNCTION recordings_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT public.catalog_has_role(NEW.owner_user_id, 'collector') THEN
    PERFORM public.catalog_raise('SAC05', 'recording owner must hold an enabled collector role');
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.owner_user_id, NEW.client_recording_id, NEW.capture_format,
        NEW.rgb_profile, NEW.started_at, NEW.device, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.owner_user_id, OLD.client_recording_id, OLD.capture_format,
        OLD.rgb_profile, OLD.started_at, OLD.device, OLD.created_at) THEN
      PERFORM public.catalog_raise('SAC01', 'recording identity is immutable');
    END IF;
    IF OLD.source_manifest_file_id IS NOT NULL AND
       (NEW.source_manifest_file_id, NEW.source_manifest_sha256)
       IS DISTINCT FROM (OLD.source_manifest_file_id, OLD.source_manifest_sha256) THEN
      PERFORM public.catalog_raise('SAC01', 'sealed source manifest is immutable');
    END IF;
    NEW.updated_at := now();
  END IF;
  IF NEW.source_manifest_file_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.source_manifest_file_id IS NULL)
     AND NOT public.catalog_file_is_closed(NEW.source_manifest_file_id, 'source_manifest') THEN
    PERFORM public.catalog_raise('SAC04', 'source manifest must be a completed source_manifest file');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recordings_guard BEFORE INSERT OR UPDATE ON recordings
  FOR EACH ROW EXECUTE FUNCTION recordings_guard();

CREATE FUNCTION files_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  parent_state text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'reserved' OR NEW.transport_epoch <> 1 THEN
      PERFORM public.catalog_raise('SAC04', 'files start reserved at transport epoch 1');
    END IF;
    IF NEW.purpose = 'source' THEN
      SELECT status INTO parent_state FROM public.recordings WHERE id = NEW.recording_id;
      IF parent_state NOT IN ('registered', 'uploading') THEN
        PERFORM public.catalog_raise('SAC04', 'recording no longer accepts source files');
      END IF;
    ELSE
      SELECT state INTO parent_state FROM public.jobs WHERE id = NEW.job_id;
      IF parent_state NOT IN ('running', 'result_pending') THEN
        PERFORM public.catalog_raise('SAC04', 'job no longer accepts output files');
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.recording_id, NEW.job_id, NEW.purpose, NEW.role, NEW.required,
      NEW.client_upload_id, NEW.request_digest, NEW.size_bytes, NEW.sha256,
      NEW.part_size_bytes, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.recording_id, OLD.job_id, OLD.purpose, OLD.role, OLD.required,
      OLD.client_upload_id, OLD.request_digest, OLD.size_bytes, OLD.sha256,
      OLD.part_size_bytes, OLD.created_at) THEN
    PERFORM public.catalog_raise('SAC01', 'logical file identity is immutable');
  END IF;
  IF OLD.state IN ('completed', 'verified') THEN
    IF (NEW.object_key, NEW.provider_upload_id, NEW.transport_epoch, NEW.part_count,
        NEW.observed_size_bytes, NEW.completed_at)
       IS DISTINCT FROM
       (OLD.object_key, OLD.provider_upload_id, OLD.transport_epoch, OLD.part_count,
        OLD.observed_size_bytes, OLD.completed_at)
       OR NOT (NEW.state = OLD.state OR (OLD.state = 'completed' AND NEW.state = 'verified')) THEN
      PERFORM public.catalog_raise('SAC01', 'completed file transport is closed');
    END IF;
  ELSIF OLD.state IN ('cancelled', 'failed', 'expired') THEN
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      PERFORM public.catalog_raise('SAC01', 'terminal file rows are immutable');
    END IF;
  ELSIF NEW.transport_epoch <> OLD.transport_epoch THEN
    -- Restart only after the old provider upload is retired by the API.
    IF NEW.transport_epoch <> OLD.transport_epoch + 1
       OR NEW.object_key = OLD.object_key
       OR NEW.provider_upload_id IS NOT DISTINCT FROM OLD.provider_upload_id THEN
      PERFORM public.catalog_raise('SAC03', 'transport restart needs the next epoch and a new key/upload');
    END IF;
  ELSIF NEW.object_key <> OLD.object_key THEN
    PERFORM public.catalog_raise('SAC03', 'object key changes only with a new transport epoch');
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER files_guard BEFORE INSERT OR UPDATE ON files
  FOR EACH ROW EXECUTE FUNCTION files_guard();

CREATE FUNCTION jobs_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'queued' OR NEW.result_manifest_file_id IS NOT NULL THEN
      PERFORM public.catalog_raise('SAC04', 'jobs start queued without a result');
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.kind, NEW.recording_id, NEW.previous_job_id,
      NEW.source_manifest_sha256, NEW.profile_revision, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.kind, OLD.recording_id, OLD.previous_job_id,
      OLD.source_manifest_sha256, OLD.profile_revision, OLD.created_at) THEN
    PERFORM public.catalog_raise('SAC01', 'job identity and input are immutable');
  END IF;
  IF OLD.state IN ('succeeded', 'failed', 'cancelled') THEN
    PERFORM public.catalog_raise('SAC01', 'finished jobs are immutable');
  END IF;
  IF (OLD.result_manifest_file_id IS NOT NULL AND
      (NEW.result_manifest_file_id, NEW.result_manifest_sha256)
      IS DISTINCT FROM (OLD.result_manifest_file_id, OLD.result_manifest_sha256))
     OR (OLD.invocation_nonce IS NOT NULL AND NEW.invocation_nonce IS DISTINCT FROM OLD.invocation_nonce)
     OR (OLD.execution_call_id IS NOT NULL AND NEW.execution_call_id IS DISTINCT FROM OLD.execution_call_id)
     OR (OLD.workflow_run_ref IS NOT NULL AND NEW.workflow_run_ref IS DISTINCT FROM OLD.workflow_run_ref) THEN
    PERFORM public.catalog_raise('SAC01', 'recorded job references are immutable');
  END IF;
  IF NEW.result_manifest_file_id IS NOT NULL
     AND OLD.result_manifest_file_id IS NULL
     AND NOT public.catalog_file_is_closed(NEW.result_manifest_file_id, 'result_manifest') THEN
    PERFORM public.catalog_raise('SAC04', 'result manifest must be a completed result_manifest file');
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_guard BEFORE INSERT OR UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_guard();

CREATE FUNCTION clips_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (SELECT state FROM public.jobs WHERE id = NEW.job_id) <> 'result_pending' THEN
    PERFORM public.catalog_raise('SAC04', 'clips are inserted only while accepting a pending result');
  END IF;
  IF NOT (public.catalog_file_is_closed(NEW.rgb_mp4_file_id, 'clip_mp4')
      AND public.catalog_file_is_closed(NEW.hand_arrays_file_id, 'hand_arrays_npz')
      AND public.catalog_file_is_closed(NEW.hand_observations_file_id, 'hand_observations_json')
      AND public.catalog_file_is_closed(NEW.frame_map_file_id, 'frame_map_json')
      AND public.catalog_file_is_closed(NEW.thumbnail_file_id, 'thumbnail_jpeg')
      AND public.catalog_file_is_closed(NEW.viewer_rrd_file_id, 'viewer_rrd')) THEN
    PERFORM public.catalog_raise('SAC04', 'clip files must be completed same-job outputs of the matching role');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clips_insert_guard BEFORE INSERT ON clips
  FOR EACH ROW EXECUTE FUNCTION clips_insert_guard();
CREATE TRIGGER clips_immutable BEFORE UPDATE OR DELETE ON clips
  FOR EACH ROW EXECUTE FUNCTION catalog_forbid_change();

CREATE FUNCTION catalog_latest_decision(clip uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT decision FROM public.reviews WHERE clip_id = clip ORDER BY revision DESC LIMIT 1;
$$;

CREATE FUNCTION reviews_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  latest integer;
BEGIN
  PERFORM public.catalog_lock_clip(NEW.clip_id);
  IF (SELECT state FROM public.jobs WHERE id = NEW.job_id) <> 'succeeded' THEN
    PERFORM public.catalog_raise('SAC04', 'reviews target an exact successful job result');
  END IF;
  IF NOT public.catalog_has_role(NEW.reviewer_user_id, 'staff') THEN
    PERFORM public.catalog_raise('SAC05', 'reviewer must hold an enabled staff role');
  END IF;
  SELECT max(revision) INTO latest FROM public.reviews WHERE clip_id = NEW.clip_id;
  IF NEW.revision <> coalesce(latest, 0) + 1 THEN
    PERFORM public.catalog_raise('SAC03', 'review revision must append to the latest revision');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reviews_insert_guard BEFORE INSERT ON reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_insert_guard();
CREATE TRIGGER reviews_append_only BEFORE UPDATE OR DELETE ON reviews
  FOR EACH ROW EXECUTE FUNCTION catalog_forbid_change();

-- A non-approved decision must leave no working memberships behind; the
-- review transaction removes them before appending (same clip lock).
CREATE FUNCTION reviews_membership_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.decision <> 'approved'
     AND EXISTS (SELECT 1 FROM public.dataset_clips WHERE clip_id = NEW.clip_id) THEN
    PERFORM public.catalog_raise('SAC02', 'remove dataset memberships before a non-approved review');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER reviews_membership_check AFTER INSERT ON reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_membership_check();

CREATE FUNCTION dataset_clips_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.catalog_has_role(NEW.added_by, 'staff') THEN
    PERFORM public.catalog_raise('SAC05', 'only enabled staff may change dataset membership');
  END IF;
  PERFORM public.catalog_lock_clip(NEW.clip_id);
  IF public.catalog_latest_decision(NEW.clip_id) IS DISTINCT FROM 'approved' THEN
    PERFORM public.catalog_raise('SAC02', 'only clips whose latest review is approved may join a dataset');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dataset_clips_insert_guard BEFORE INSERT ON dataset_clips
  FOR EACH ROW EXECUTE FUNCTION dataset_clips_insert_guard();
CREATE TRIGGER dataset_clips_no_update BEFORE UPDATE ON dataset_clips
  FOR EACH ROW EXECUTE FUNCTION catalog_forbid_change();

CREATE FUNCTION datasets_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.catalog_has_role(NEW.updated_by, 'staff') THEN
    PERFORM public.catalog_raise('SAC05', 'only enabled staff may change datasets');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revision <> 1 OR NEW.created_by <> NEW.updated_by THEN
      PERFORM public.catalog_raise('SAC04', 'datasets start at revision 1');
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.created_by, OLD.created_at) THEN
    PERFORM public.catalog_raise('SAC01', 'dataset identity is immutable');
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    PERFORM public.catalog_raise('SAC03', 'each dataset change advances its revision by one');
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER datasets_guard BEFORE INSERT OR UPDATE ON datasets
  FOR EACH ROW EXECUTE FUNCTION datasets_guard();
CREATE TRIGGER datasets_no_delete BEFORE DELETE ON datasets
  FOR EACH ROW EXECUTE FUNCTION catalog_forbid_change();

-- Narrow staff grant path: the web role may call this routine but has no
-- direct DML on dataset_access. Runs with the migration owner's rights.
CREATE FUNCTION catalog_set_dataset_access(
  p_dataset_id uuid, p_user_id text, p_enabled boolean,
  p_actor_user_id text, p_evidence_ref text
) RETURNS public.dataset_access
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  result public.dataset_access;
BEGIN
  IF NOT public.catalog_has_role(p_actor_user_id, 'staff') THEN
    PERFORM public.catalog_raise('SAC05', 'only enabled staff may change dataset access');
  END IF;
  IF p_enabled AND NOT public.catalog_has_role(p_user_id, 'customer') THEN
    PERFORM public.catalog_raise('SAC05', 'dataset access is granted to enabled customers');
  END IF;
  INSERT INTO public.dataset_access AS d (dataset_id, user_id, enabled, granted_by, permission_evidence_ref)
  VALUES (p_dataset_id, p_user_id, p_enabled, p_actor_user_id, p_evidence_ref)
  ON CONFLICT (dataset_id, user_id) DO UPDATE
    SET enabled = EXCLUDED.enabled, granted_by = EXCLUDED.granted_by,
        permission_evidence_ref = EXCLUDED.permission_evidence_ref, updated_at = now()
  RETURNING d.* INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION catalog_set_dataset_access(uuid, text, boolean, text, text) FROM PUBLIC;

-- ------------------------------------------------------------- privileges
-- Least privilege for the restricted web role. The migrator calls this after
-- every migration run (idempotent); it replaces, never widens, earlier grants.
CREATE FUNCTION stateaction_grant_app_role(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  t text;
BEGIN
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', app_role);
  -- No TEMP objects for the web role: they could shadow catalog relations.
  IF (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) = current_user THEN
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM %I', current_database(), app_role);
  ELSE
    RAISE EXCEPTION 'migration owner must own the database to revoke TEMPORARY';
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_role);
  FOREACH t IN ARRAY ARRAY[
    'platform_schema_migrations', 'user', 'session', 'account', 'verification',
    'access', 'recordings', 'files', 'jobs', 'clips', 'reviews', 'datasets',
    'dataset_clips', 'dataset_access'
  ] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, app_role);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO %I', t, app_role);
  END LOOP;
  -- Better Auth manages its own rows.
  FOREACH t IN ARRAY ARRAY['user', 'session', 'account', 'verification'] LOOP
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON TABLE public.%I TO %I', t, app_role);
  END LOOP;
  EXECUTE format('GRANT INSERT ON TABLE public.recordings, public.files, public.jobs, public.clips, public.reviews, public.datasets, public.dataset_clips TO %I', app_role);
  EXECUTE format('GRANT DELETE ON TABLE public.dataset_clips TO %I', app_role);
  EXECUTE format('GRANT UPDATE (status, source_manifest_file_id, source_manifest_sha256, current_job_id, deleted_at, updated_at) ON TABLE public.recordings TO %I', app_role);
  EXECUTE format('GRANT UPDATE (state, observed_size_bytes, transport_epoch, object_key, provider_upload_id, part_count, transport_expires_at, completed_at, updated_at) ON TABLE public.files TO %I', app_role);
  EXECUTE format('GRANT UPDATE (state, controller_lease_owner, controller_lease_expires_at, workflow_run_ref, submission_intent_at, execution_call_id, invocation_nonce, capability_token_sha256, start_deadline, execution_deadline, result_manifest_file_id, result_manifest_sha256, error_code, error_message, updated_at, finished_at) ON TABLE public.jobs TO %I', app_role);
  EXECUTE format('GRANT UPDATE (name, revision, updated_by, updated_at) ON TABLE public.datasets TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.catalog_set_dataset_access(uuid, text, boolean, text, text) TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION stateaction_grant_app_role(name) FROM PUBLIC;
