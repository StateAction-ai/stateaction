-- SA-88 recipe stage runs, per-stage worker claims and annotation output roles
-- (migration 011). Additive: 001-010 are unchanged (their bytes are pinned by
-- the migration test). Every function pins search_path = pg_catalog, public,
-- pg_temp and schema-qualifies relations.
--
-- What this adds:
--   * jobs.recipe / recipe_sha256: the admitted jobs.recipe.v1 (task-input.v3),
--     written once at admission and equal to the persisted task input.
--   * job_stage_claims: one single-use claim per (job, stage) with its own
--     bootstrap hash, invocation nonce, executor call ID, running capability
--     hash and heartbeat.
--   * job_stage_runs: one controller-recorded run per (job, stage), forward-only,
--     with a write-once call ID and a bounded (64 KiB) stage receipt.
--   * job_stage_evidence: terminal proof for the exact call of one stage. A
--     stage with an issued claim ends, and the slot is released, only with it.
--   * Annotation outputs: segments.json, captions.json, hand-presence.json,
--     recording.mp4 and staff-only diagnostics/<stage>/<name> (diagnostic_blob,
--     at most 64 MiB each). Closure counts clip files under clips/ only.
--   * Accepted annotation counts on jobs (segments, captions, failed captions,
--     failed windows), equal to the verified candidate's counts.
--
-- Recipe jobs vs the existing single-claim path. A job without a recipe
-- (hand_pose_cpu_v1, task-input v1/v2) behaves exactly as before: none of the
-- replaced functions changes a branch it takes. For a recipe job:
--   * The FIRST issued stage claim also writes the job-level submission intent,
--     and the FIRST claimed stage moves the job to `running` with that stage's
--     nonce, call ID and capability hash (so SA-25/SA-27 invariants such as
--     "intent before any effect" and "running needs a claim" keep holding).
--   * The hand_pose stage is the seal: output closure, the result candidate and
--     the manifest attestation bind to the hand_pose stage nonce.
--   * Stages run in recipe order: a stage is claimed or run only after every
--     earlier enabled stage has a terminal run, so at most one stage call can
--     be live: a stage with an issued claim is never not_run and goes
--     terminal only with stage evidence for its known call. Job evidence must
--     name the latest issued stage's call and every issued stage must have
--     stage evidence before the slot frees.
--
-- Writes by the restricted web role go through the SECURITY DEFINER functions
-- below only (no INSERT/UPDATE grant on the two stage tables). Triggers hold
-- the invariants for every writer, including the owner credential.
--
-- Reversal: there are no down migrations in this repository. Everything here is
-- additive and reversible by a follow-up migration: drop the two tables, the
-- stage functions and the new jobs/candidate columns, restore the 003/007 CHECKs
-- and the 007/009 function bodies (byte-pinned in their own files).
-- SQLSTATE classes reused from 003: SAC01 immutable, SAC03 plan, SAC04
-- lifecycle, SAC05 not authorized.

-- ------------------------------------------------------------- vocabularies
CREATE FUNCTION public.job_stage_ord(p_stage text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE p_stage WHEN 'segment' THEN 1 WHEN 'caption' THEN 2 WHEN 'hand_pose' THEN 3 END
$$;

-- The recipe entry of one stage (jobs.recipe.v1 stages[] is discriminated by stage).
CREATE FUNCTION public.job_recipe_stage(p_recipe jsonb, p_stage text) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT e FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_recipe -> 'stages') = 'array'
                                          THEN p_recipe -> 'stages' ELSE '[]'::jsonb END) e
  WHERE e ->> 'stage' = p_stage LIMIT 1
$$;

CREATE FUNCTION public.job_stage_terminal(p_state text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_state IN ('succeeded', 'failed', 'cancelled', 'not_run')
$$;

-- ------------------------------------------------------------ output roles
-- 003 declared the role vocabulary twice (column CHECK and the purpose CHECK)
-- without constraint names; both are replaced by exact supersets. They are
-- found by definition so a naming difference cannot drop the wrong CHECK.
DO $$
DECLARE
  c record;
  n integer := 0;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.files'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%''viewer_rrd''%' LOOP
    EXECUTE format('ALTER TABLE public.files DROP CONSTRAINT %I', c.conname);
    n := n + 1;
  END LOOP;
  IF n <> 2 THEN
    RAISE EXCEPTION 'expected the two 003 file role CHECKs, found %', n;
  END IF;
END $$;
ALTER TABLE public.files
  ADD CONSTRAINT files_role_v2_check CHECK (role IN (
    'source_manifest', 'source_mcap', 'recorder_metadata', 'calibration',
    'result_manifest', 'clip_mp4', 'hand_arrays_npz', 'hand_observations_json',
    'frame_map_json', 'thumbnail_jpeg', 'viewer_rrd',
    'segments_json', 'captions_json', 'hand_presence_json', 'recording_mp4', 'diagnostic_blob'
  )),
  ADD CONSTRAINT files_purpose_role_v2_check CHECK (
    (purpose = 'source' AND job_id IS NULL AND client_upload_id IS NOT NULL
      AND request_digest IS NOT NULL
      AND role IN ('source_manifest', 'source_mcap', 'recorder_metadata', 'calibration'))
    OR
    (purpose = 'output' AND job_id IS NOT NULL AND client_upload_id IS NULL
      AND request_digest IS NULL
      AND role IN ('result_manifest', 'clip_mp4', 'hand_arrays_npz',
        'hand_observations_json', 'frame_map_json', 'thumbnail_jpeg', 'viewer_rrd',
        'segments_json', 'captions_json', 'hand_presence_json', 'recording_mp4', 'diagnostic_blob'))
  ),
  -- Staff-only stage evidence stays small; it is never a clip file, so the
  -- customer broker (clip thumbnail/viewer roles only) can never serve it.
  ADD CONSTRAINT files_diagnostic_blob_size_check CHECK (role <> 'diagnostic_blob' OR size_bytes <= 67108864);

-- Intended output slots (replaces 009). The six clip roles live under
-- clips/NNN/; the recording-level annotation documents and the review video
-- have one fixed slot each; diagnostics live under diagnostics/<stage>/.
CREATE OR REPLACE FUNCTION public.job_output_slot_role_ok(p_slot text, p_role text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN p_slot = 'result-manifest.json' THEN p_role = 'result_manifest'
    WHEN p_slot ~ '^clips/[0-9]{3}/rgb\.mp4$' THEN p_role = 'clip_mp4'
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

-- ----------------------------------------------------------- jobs columns
DO $$
DECLARE
  c record;
  n integer := 0;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.jobs'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%''hashing_source''%' LOOP
    EXECUTE format('ALTER TABLE public.jobs DROP CONSTRAINT %I', c.conname);
    n := n + 1;
  END LOOP;
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected the 007 heartbeat_phase CHECK, found %', n;
  END IF;
  -- A v3 task input carries the inline recipe; 4 KiB (007) no longer fits it.
  n := 0;
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'public.job_inputs'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%task_input%4096%' LOOP
    EXECUTE format('ALTER TABLE public.job_inputs DROP CONSTRAINT %I', c.conname);
    n := n + 1;
  END LOOP;
  IF n <> 1 THEN
    RAISE EXCEPTION 'expected the 007 task_input size CHECK, found %', n;
  END IF;
END $$;
ALTER TABLE public.job_inputs
  ADD CONSTRAINT job_inputs_task_input_v2_check CHECK (
    jsonb_typeof(task_input) = 'object' AND octet_length(task_input::text) <= 65536);

ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_heartbeat_phase_v2_check CHECK (heartbeat_phase IN (
    'hashing_source', 'decoding', 'inference', 'writing_outputs', 'uploading', 'sealing',
    'remuxing', 'segmenting', 'captioning')),
  ADD COLUMN recipe jsonb CHECK (recipe IS NULL OR (jsonb_typeof(recipe) = 'object'
    AND octet_length(recipe::text) <= 49152)),
  ADD COLUMN recipe_sha256 public.sha256_hex,
  -- Accepted annotation counts; null means the document was not accepted
  -- (stage disabled, failed or not run), never a fabricated zero.
  ADD COLUMN segment_count integer CHECK (segment_count BETWEEN 0 AND 1000000),
  ADD COLUMN failed_window_count integer CHECK (failed_window_count BETWEEN 0 AND 1000000),
  ADD COLUMN caption_count integer CHECK (caption_count BETWEEN 0 AND 1000000),
  ADD COLUMN caption_failed_count integer CHECK (caption_failed_count BETWEEN 0 AND 1000000),
  ADD CONSTRAINT jobs_recipe_pair CHECK ((recipe IS NULL) = (recipe_sha256 IS NULL)),
  ADD CONSTRAINT jobs_segment_counts_pair CHECK ((segment_count IS NULL) = (failed_window_count IS NULL)),
  ADD CONSTRAINT jobs_caption_counts_pair CHECK ((caption_count IS NULL) = (caption_failed_count IS NULL)
    AND (caption_count IS NULL OR segment_count IS NOT NULL)),
  ADD CONSTRAINT jobs_annotation_counts_accepted CHECK (segment_count IS NULL
    OR (recipe IS NOT NULL AND state = 'succeeded'));

-- Same predicate as JOB_CURRENT_SQL (packages/server/src/jobs/current.ts),
-- without the nonce, for the stage functions below.
CREATE FUNCTION public.job_current_ok(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.jobs j JOIN public.recordings r ON r.id = j.recording_id
    WHERE j.id = p_job AND j.state = 'running' AND j.claimed_at IS NOT NULL
      AND j.execution_deadline > now()
      AND r.current_job_id = j.id AND r.deleted_at IS NULL AND r.status = 'processing'
      AND EXISTS (SELECT 1 FROM public.dispatch_admission a WHERE a.slot = 1 AND a.job_id = j.id)
      AND public.catalog_has_role(r.owner_user_id, 'collector')
      AND EXISTS (
        SELECT 1 FROM public.recording_registrations g
        WHERE g.recording_id = r.id AND g.owner_user_id = r.owner_user_id
          AND public.ingest_permission_ok(g.ingest_permission_id, g.owner_user_id, true)))
$$;

-- ------------------------------------------------------------ stage tables
CREATE TABLE public.job_stage_runs (
  job_id uuid NOT NULL REFERENCES public.jobs (id),
  stage text NOT NULL CHECK (stage IN ('segment', 'caption', 'hand_pose')),
  -- common.v2 stageRunState. pending = intent, submitting = spawning,
  -- running = submitted (the executor returned a call ID).
  state text NOT NULL CHECK (state IN (
    'pending', 'submitting', 'submit_unknown', 'running', 'succeeded', 'failed', 'cancelled', 'not_run')),
  module text NOT NULL CHECK (module ~ '^[a-z][a-z0-9_]{0,63}@[1-9][0-9]{0,5}$'),
  -- Executor call identity: an identity only, never spawn authority. Write-once.
  call_id text CHECK (call_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  requested_gpu text NOT NULL CHECK (requested_gpu IN (
    'none', 'T4', 'L4', 'A10G', 'L40S', 'A100-40GB', 'A100-80GB', 'RTX-PRO-6000', 'H100', 'H200', 'B200')),
  observed_gpu text CHECK (observed_gpu ~ '^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,127}$'),
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- Why the submission outcome is unknown; kept after the run moves on.
  unknown_reason text CHECK (unknown_reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'
    AND octet_length(counts::text) <= 4096),
  -- jobs.stage-receipt.v1 and its sa-cjson-v1 digest (computed by the service).
  receipt jsonb CHECK (receipt IS NULL OR (jsonb_typeof(receipt) = 'object'
    AND octet_length(receipt::text) <= 65536)),
  receipt_sha256 public.sha256_hex,
  -- Estimate only (never billing data); null until a rate exists for the stage.
  cost_estimate_usd numeric(8, 2) CHECK (cost_estimate_usd >= 0),
  -- Worker-reported (receipt) and server-observed timings.
  started_at timestamptz,
  finished_at timestamptz,
  submitted_at timestamptz,
  running_at timestamptz,
  terminal_at timestamptz,
  recorded_by text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, stage),
  CHECK ((state IN ('failed', 'cancelled', 'not_run')) = (error_code IS NOT NULL)),
  CHECK (state <> 'submit_unknown' OR unknown_reason IS NOT NULL),
  CHECK ((receipt IS NULL) = (receipt_sha256 IS NULL)),
  CHECK (state <> 'succeeded' OR receipt IS NOT NULL),
  CHECK (receipt IS NULL OR state IN ('succeeded', 'failed')),
  CHECK (state NOT IN ('running', 'succeeded') OR call_id IS NOT NULL),
  CHECK (state <> 'not_run' OR (call_id IS NULL AND receipt IS NULL)),
  CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),
  CHECK (public.job_stage_terminal(state) = (terminal_at IS NOT NULL))
);

CREATE TABLE public.job_stage_claims (
  job_id uuid NOT NULL REFERENCES public.jobs (id),
  stage text NOT NULL CHECK (stage IN ('segment', 'caption', 'hand_pose')),
  issued_by text NOT NULL CHECK (length(issued_by) BETWEEN 1 AND 200),
  bootstrap_token_sha256 public.sha256_hex NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  start_deadline timestamptz NOT NULL,
  claimed_at timestamptz,
  invocation_nonce text UNIQUE CHECK (invocation_nonce ~ '^[A-Za-z0-9_-]{43}$'),
  call_id text CHECK (call_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  capability_token_sha256 public.sha256_hex UNIQUE,
  last_heartbeat_at timestamptz,
  heartbeat_phase text CHECK (heartbeat_phase IN (
    'hashing_source', 'decoding', 'inference', 'writing_outputs', 'uploading', 'sealing',
    'remuxing', 'segmenting', 'captioning')),
  processed_frames bigint CHECK (processed_frames >= 0),
  total_frames bigint CHECK (total_frames >= 0),
  PRIMARY KEY (job_id, stage),
  CHECK ((claimed_at IS NULL) = (invocation_nonce IS NULL)),
  CHECK ((claimed_at IS NULL) = (call_id IS NULL)),
  CHECK ((claimed_at IS NULL) = (capability_token_sha256 IS NULL)),
  CHECK (claimed_at IS NOT NULL OR (last_heartbeat_at IS NULL AND heartbeat_phase IS NULL)),
  -- heartbeat.v2 rule heartbeat_stage.
  CHECK (heartbeat_phase IS DISTINCT FROM 'segmenting' OR stage = 'segment'),
  CHECK (heartbeat_phase IS DISTINCT FROM 'captioning' OR stage = 'caption'),
  CHECK (processed_frames IS NULL OR total_frames IS NULL OR processed_frames <= total_frames)
);

-- Authoritative proof that the exact call of one stage is over (the per-stage
-- counterpart of 007 job_execution_evidence, which stays one row per job).
-- A stage run that has a call can go terminal only with this row, and the
-- admission slot is released only when every spawned stage has one.
CREATE TABLE public.job_stage_evidence (
  job_id uuid NOT NULL REFERENCES public.jobs (id),
  stage text NOT NULL CHECK (stage IN ('segment', 'caption', 'hand_pose')),
  kind text NOT NULL CHECK (kind IN ('local_child_reaped', 'provider_call_terminal')),
  execution_ref text NOT NULL CHECK (execution_ref ~ '^[A-Za-z0-9._:-]{1,128}$'),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096),
  recorded_by text NOT NULL CHECK (length(btrim(recorded_by)) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, stage)
);

-- The executor call of one stage: the claiming worker's, else the spawn's.
CREATE FUNCTION public.job_stage_call(p_job uuid, p_stage text) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(
    (SELECT c.call_id FROM public.job_stage_claims c WHERE c.job_id = p_job AND c.stage = p_stage),
    (SELECT r.call_id FROM public.job_stage_runs r WHERE r.job_id = p_job AND r.stage = p_stage))
$$;

CREATE FUNCTION public.job_stage_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.catalog_raise('SAC01', 'stage evidence is append-only');
  END IF;
  SELECT * INTO j FROM public.jobs WHERE id = NEW.job_id;
  IF j.recipe IS NULL OR public.job_stage_call(NEW.job_id, NEW.stage) IS DISTINCT FROM NEW.execution_ref THEN
    PERFORM public.catalog_raise('SAC04', 'stage evidence must name the exact call of that stage');
  END IF;
  IF (NEW.kind = 'local_child_reaped') IS DISTINCT FROM (j.execution_backend = 'local') THEN
    PERFORM public.catalog_raise('SAC04', 'evidence kind does not match the job execution backend');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_stage_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON public.job_stage_evidence
  FOR EACH ROW EXECUTE FUNCTION public.job_stage_evidence_guard();

-- Every stage before p_stage in recipe order is disabled or has a terminal run.
CREATE FUNCTION public.job_stage_prior_settled(p_job uuid, p_recipe jsonb, p_stage text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY['segment', 'caption', 'hand_pose']) s(stage)
    WHERE public.job_stage_ord(s.stage) < public.job_stage_ord(p_stage)
      AND coalesce((public.job_recipe_stage(p_recipe, s.stage) ->> 'enabled')::boolean, false)
      AND NOT EXISTS (SELECT 1 FROM public.job_stage_runs r
                      WHERE r.job_id = p_job AND r.stage = s.stage AND public.job_stage_terminal(r.state)))
$$;

-- The seal nonce: the claimed hand_pose stage of a recipe job, else the job claim.
CREATE FUNCTION public.job_seal_nonce(p_job uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN j.recipe IS NULL THEN j.invocation_nonce
    ELSE (SELECT c.invocation_nonce FROM public.job_stage_claims c
          WHERE c.job_id = j.id AND c.stage = 'hand_pose') END
  FROM public.jobs j WHERE j.id = p_job
$$;

-- Runs: forward-only state machine, write-once identity, call ID and receipt.
CREATE FUNCTION public.job_stage_runs_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  spec jsonb;
  claimed_call text;
  rank_old integer;
  rank_new integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.catalog_raise('SAC01', 'stage runs are never deleted');
  END IF;
  SELECT * INTO j FROM public.jobs WHERE id = NEW.job_id;
  IF j.recipe IS NULL THEN
    PERFORM public.catalog_raise('SAC04', 'stage runs exist only for recipe jobs');
  END IF;
  spec := public.job_recipe_stage(j.recipe, NEW.stage);
  IF spec IS NULL OR NEW.module IS DISTINCT FROM spec ->> 'module' THEN
    PERFORM public.catalog_raise('SAC04', 'stage module must be the recipe module');
  END IF;
  NEW.requested_gpu := spec -> 'resources' ->> 'gpu';
  IF NOT coalesce((spec ->> 'enabled')::boolean, false) AND NEW.state <> 'not_run' THEN
    PERFORM public.catalog_raise('SAC04', 'a disabled stage can only be not_run');
  END IF;
  IF NEW.state <> 'not_run' AND NOT public.job_stage_prior_settled(NEW.job_id, j.recipe, NEW.stage) THEN
    PERFORM public.catalog_raise('SAC04', 'stages run in recipe order');
  END IF;
  IF NEW.state IN ('submitting', 'submit_unknown', 'running', 'succeeded') AND NOT EXISTS (
       SELECT 1 FROM public.job_stage_claims c WHERE c.job_id = NEW.job_id AND c.stage = NEW.stage) THEN
    PERFORM public.catalog_raise('SAC04', 'a stage is submitted only after its claim was issued');
  END IF;
  SELECT c.call_id INTO claimed_call FROM public.job_stage_claims c
  WHERE c.job_id = NEW.job_id AND c.stage = NEW.stage;
  IF NEW.call_id IS NOT NULL AND claimed_call IS NOT NULL AND NEW.call_id <> claimed_call THEN
    PERFORM public.catalog_raise('SAC04', 'stage call ID does not match the claiming worker');
  END IF;
  -- An issued claim is the spawn intent (the bootstrap token may have reached
  -- an executor). From then on the stage is never not_run, and it ends only
  -- with proof that its exact, known call is over, so no stage call can still
  -- run while a later stage starts or after the slot is released. A lost or
  -- unknown call stays open for the operator path (as 007 submit_unknown).
  IF EXISTS (SELECT 1 FROM public.job_stage_claims c WHERE c.job_id = NEW.job_id AND c.stage = NEW.stage) THEN
    IF NEW.state = 'not_run' THEN
      PERFORM public.catalog_raise('SAC04', 'a stage with an issued claim is never not_run');
    END IF;
    IF NEW.state IN ('succeeded', 'failed', 'cancelled')
       AND (coalesce(claimed_call, NEW.call_id) IS NULL
            OR NOT EXISTS (SELECT 1 FROM public.job_stage_evidence e
                           WHERE e.job_id = NEW.job_id AND e.stage = NEW.stage
                             AND e.execution_ref = coalesce(claimed_call, NEW.call_id))) THEN
      PERFORM public.catalog_raise('SAC04', 'an issued stage ends only after terminal evidence for its known call');
    END IF;
  END IF;
  IF NEW.receipt IS NOT NULL THEN
    IF NEW.receipt ->> 'jobId' IS DISTINCT FROM NEW.job_id::text
       OR NEW.receipt ->> 'stage' IS DISTINCT FROM NEW.stage
       OR NEW.receipt ->> 'module' IS DISTINCT FROM NEW.module
       OR NEW.receipt ->> 'status' IS DISTINCT FROM NEW.state
       OR NEW.receipt -> 'gpu' ->> 'requestedType' IS DISTINCT FROM NEW.requested_gpu THEN
      PERFORM public.catalog_raise('SAC04', 'stage receipt does not describe this stage run');
    END IF;
    -- A receipt names only completed outputs of this job, exactly as stored.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.receipt -> 'outputs') o
      WHERE NOT EXISTS (
        SELECT 1 FROM public.files f
        WHERE f.id::text = o ->> 'fileId' AND f.job_id = NEW.job_id AND f.purpose = 'output'
          AND f.role = o ->> 'role' AND f.size_bytes::text = o ->> 'sizeBytes'
          AND f.sha256 = o ->> 'sha256' AND f.state IN ('completed', 'verified'))) THEN
      PERFORM public.catalog_raise('SAC04', 'stage receipt names an output that is not a completed file of this job');
    END IF;
    NEW.observed_gpu := NEW.receipt -> 'gpu' ->> 'observedType';
    NEW.counts := coalesce(NEW.receipt -> 'counts', '{}'::jsonb);
    NEW.started_at := (NEW.receipt ->> 'startedAt')::timestamptz;
    NEW.finished_at := (NEW.receipt ->> 'finishedAt')::timestamptz;
  END IF;
  rank_new := CASE NEW.state WHEN 'pending' THEN 0 WHEN 'submitting' THEN 1 WHEN 'submit_unknown' THEN 2
                             WHEN 'running' THEN 3 ELSE 4 END;
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSE
    IF (NEW.job_id, NEW.stage, NEW.module, NEW.created_at) IS DISTINCT FROM
       (OLD.job_id, OLD.stage, OLD.module, OLD.created_at) THEN
      PERFORM public.catalog_raise('SAC01', 'stage run identity is immutable');
    END IF;
    IF public.job_stage_terminal(OLD.state) AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
      PERFORM public.catalog_raise('SAC01', 'a terminal stage run is immutable');
    END IF;
    rank_old := CASE OLD.state WHEN 'pending' THEN 0 WHEN 'submitting' THEN 1 WHEN 'submit_unknown' THEN 2
                               WHEN 'running' THEN 3 ELSE 4 END;
    IF NOT (NEW.state = OLD.state OR (rank_new > rank_old
            AND (NEW.state <> 'not_run' OR OLD.state = 'pending'))) THEN
      PERFORM public.catalog_raise('SAC04', 'illegal stage run transition ' || OLD.state || ' -> ' || NEW.state);
    END IF;
    IF (OLD.call_id IS NOT NULL AND NEW.call_id IS DISTINCT FROM OLD.call_id)
       OR (OLD.unknown_reason IS NOT NULL AND NEW.unknown_reason IS DISTINCT FROM OLD.unknown_reason)
       OR (OLD.receipt IS NOT NULL AND (NEW.receipt, NEW.receipt_sha256) IS DISTINCT FROM (OLD.receipt, OLD.receipt_sha256)) THEN
      PERFORM public.catalog_raise('SAC01', 'stage call ID, unknown reason and receipt are write-once');
    END IF;
    NEW.submitted_at := OLD.submitted_at;
    NEW.running_at := OLD.running_at;
    NEW.terminal_at := OLD.terminal_at;
  END IF;
  -- Server-observed timings: the first time the run reaches each step.
  IF rank_new >= 1 AND NEW.state <> 'not_run' AND NEW.submitted_at IS NULL THEN NEW.submitted_at := now(); END IF;
  IF NEW.state = 'running' AND NEW.running_at IS NULL THEN NEW.running_at := now(); END IF;
  IF public.job_stage_terminal(NEW.state) AND NEW.terminal_at IS NULL THEN NEW.terminal_at := now(); END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER job_stage_runs_guard BEFORE INSERT OR UPDATE OR DELETE ON public.job_stage_runs
  FOR EACH ROW EXECUTE FUNCTION public.job_stage_runs_guard();

-- Claims: issued once per stage in recipe order, claimed once, identity write-once.
CREATE FUNCTION public.job_stage_claims_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  run_call text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.catalog_raise('SAC01', 'stage claims are never deleted');
  END IF;
  SELECT * INTO j FROM public.jobs WHERE id = NEW.job_id;
  IF TG_OP = 'INSERT' THEN
    IF j.recipe IS NULL THEN
      PERFORM public.catalog_raise('SAC04', 'stage claims exist only for recipe jobs');
    END IF;
    IF NOT coalesce((public.job_recipe_stage(j.recipe, NEW.stage) ->> 'enabled')::boolean, false) THEN
      PERFORM public.catalog_raise('SAC04', 'a disabled stage is never claimed');
    END IF;
    IF j.state NOT IN ('submitting', 'submit_unknown', 'running')
       OR NOT EXISTS (SELECT 1 FROM public.dispatch_admission a WHERE a.slot = 1 AND a.job_id = NEW.job_id) THEN
      PERFORM public.catalog_raise('SAC04', 'only the active job holding the admission slot issues stage claims');
    END IF;
    IF NOT public.job_stage_prior_settled(NEW.job_id, j.recipe, NEW.stage) THEN
      PERFORM public.catalog_raise('SAC04', 'stages run in recipe order');
    END IF;
    IF EXISTS (SELECT 1 FROM public.job_execution_evidence e WHERE e.job_id = NEW.job_id) THEN
      PERFORM public.catalog_raise('SAC04', 'no stage is issued after the job execution ended');
    END IF;
    IF EXISTS (SELECT 1 FROM public.job_stage_runs r WHERE r.job_id = NEW.job_id AND r.stage = NEW.stage
               AND public.job_stage_terminal(r.state)) THEN
      PERFORM public.catalog_raise('SAC04', 'a finished stage is never claimed again');
    END IF;
    IF NEW.claimed_at IS NOT NULL OR NEW.start_deadline > j.execution_deadline THEN
      PERFORM public.catalog_raise('SAC04', 'a stage claim starts unclaimed inside the execution deadline');
    END IF;
    NEW.issued_at := now();
    RETURN NEW;
  END IF;
  IF (NEW.job_id, NEW.stage, NEW.issued_by, NEW.bootstrap_token_sha256, NEW.issued_at, NEW.start_deadline)
     IS DISTINCT FROM
     (OLD.job_id, OLD.stage, OLD.issued_by, OLD.bootstrap_token_sha256, OLD.issued_at, OLD.start_deadline)
     OR (OLD.claimed_at IS NOT NULL AND (NEW.claimed_at, NEW.invocation_nonce, NEW.call_id, NEW.capability_token_sha256)
         IS DISTINCT FROM (OLD.claimed_at, OLD.invocation_nonce, OLD.call_id, OLD.capability_token_sha256)) THEN
    PERFORM public.catalog_raise('SAC01', 'stage claim identity, nonce, call ID and capability are write-once');
  END IF;
  IF OLD.claimed_at IS NULL AND NEW.claimed_at IS NOT NULL THEN
    -- job_stage_take_claim writes the stage claim first, then (for the first
    -- claimed stage) moves the job to running with the same identity.
    IF NEW.claimed_at > OLD.start_deadline OR j.state NOT IN ('submitting', 'submit_unknown', 'running') THEN
      PERFORM public.catalog_raise('SAC04', 'a stage is claimed only inside its start deadline by an active job');
    END IF;
    SELECT r.call_id INTO run_call FROM public.job_stage_runs r WHERE r.job_id = NEW.job_id AND r.stage = NEW.stage;
    IF run_call IS NOT NULL AND run_call <> NEW.call_id THEN
      PERFORM public.catalog_raise('SAC04', 'execution does not match the submitted stage call');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_stage_claims_guard BEFORE INSERT OR UPDATE OR DELETE ON public.job_stage_claims
  FOR EACH ROW EXECUTE FUNCTION public.job_stage_claims_guard();

-- Recipe identity on the job: written once at admission (queued -> submitting),
-- equal to the persisted task input; a v3 task input cannot be admitted
-- without it. Counts are written only by acceptance (jobs_acceptance_guard).
CREATE FUNCTION public.jobs_recipe_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  task jsonb;
BEGIN
  IF (NEW.recipe, NEW.recipe_sha256) IS DISTINCT FROM (OLD.recipe, OLD.recipe_sha256) THEN
    IF OLD.recipe IS NOT NULL OR NOT (OLD.state = 'queued' AND NEW.state = 'submitting') THEN
      PERFORM public.catalog_raise('SAC01', 'the job recipe is written once at admission');
    END IF;
  END IF;
  -- A recipe job's submission intent is its first stage claim, never the
  -- single-claim path (record_worker_submission).
  IF NEW.recipe IS NOT NULL AND OLD.submission_intent_at IS NULL AND NEW.submission_intent_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.job_stage_claims c WHERE c.job_id = NEW.id
                     AND c.bootstrap_token_sha256 = NEW.bootstrap_token_sha256) THEN
    PERFORM public.catalog_raise('SAC04', 'a recipe job is submitted through its stage claims');
  END IF;
  -- A recipe job is claimed only through a claimed stage with this exact
  -- nonce and capability, never through the single-claim path.
  IF NEW.recipe IS NOT NULL AND OLD.claimed_at IS NULL AND NEW.claimed_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.job_stage_claims c WHERE c.job_id = NEW.id
                     AND c.claimed_at IS NOT NULL AND c.invocation_nonce = NEW.invocation_nonce
                     AND c.capability_token_sha256 = NEW.capability_token_sha256) THEN
    PERFORM public.catalog_raise('SAC04', 'a recipe job is claimed through its stage claims');
  END IF;
  IF OLD.state = 'queued' AND NEW.state = 'submitting' THEN
    SELECT task_input INTO task FROM public.job_inputs WHERE job_id = NEW.id;
    IF (task ? 'recipe') <> (NEW.recipe IS NOT NULL)
       OR (NEW.recipe IS NOT NULL AND (task -> 'recipe' IS DISTINCT FROM NEW.recipe
                                       OR task ->> 'recipeSha256' IS DISTINCT FROM NEW.recipe_sha256)) THEN
      PERFORM public.catalog_raise('SAC04', 'the job recipe must equal the admitted task input recipe');
    END IF;
  END IF;
  IF (NEW.segment_count, NEW.failed_window_count, NEW.caption_count, NEW.caption_failed_count)
     IS DISTINCT FROM (OLD.segment_count, OLD.failed_window_count, OLD.caption_count, OLD.caption_failed_count)
     AND NOT (OLD.state = 'result_pending' AND NEW.state = 'succeeded'
              AND OLD.segment_count IS NULL AND OLD.caption_count IS NULL) THEN
    PERFORM public.catalog_raise('SAC01', 'annotation counts are written once by acceptance');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_recipe_guard BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_recipe_guard();

-- ------------------------------------------------ replaced 007/009 guards
-- Evidence (replaces 007): a recipe job's evidence names the call of the
-- latest issued stage, and every stage that has a call has terminal stage
-- evidence for exactly that call; a recipe job that issued any stage claim
-- was submitted.
CREATE OR REPLACE FUNCTION public.job_execution_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  latest_call text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.catalog_raise('SAC01', 'execution evidence is append-only');
  END IF;
  -- The release statement locks the job row FOR UPDATE before inserting.
  SELECT * INTO j FROM public.jobs WHERE id = NEW.job_id;
  IF NOT EXISTS (SELECT 1 FROM public.dispatch_admission WHERE slot = 1 AND job_id = NEW.job_id) THEN
    PERFORM public.catalog_raise('SAC04', 'evidence applies only to the job holding the admission slot');
  END IF;
  IF NEW.kind = 'pre_submission_rejected' THEN
    IF j.submission_intent_at IS NOT NULL OR j.execution_call_id IS NOT NULL
       OR j.invocation_nonce IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.job_stage_claims c WHERE c.job_id = NEW.job_id) THEN
      PERFORM public.catalog_raise('SAC04', 'a submitted job cannot be released as never submitted');
    END IF;
  ELSE
    IF j.recipe IS NULL THEN
      IF j.execution_call_id IS DISTINCT FROM NEW.execution_ref THEN
        PERFORM public.catalog_raise('SAC04', 'evidence must name the exact recorded execution');
      END IF;
    ELSE
      SELECT coalesce(c.call_id, r.call_id) INTO latest_call
      FROM public.job_stage_claims c
      LEFT JOIN public.job_stage_runs r ON r.job_id = c.job_id AND r.stage = c.stage
      WHERE c.job_id = NEW.job_id
      ORDER BY public.job_stage_ord(c.stage) DESC LIMIT 1;
      IF latest_call IS NULL OR latest_call IS DISTINCT FROM NEW.execution_ref THEN
        PERFORM public.catalog_raise('SAC04', 'evidence must name the call of the latest issued stage');
      END IF;
      -- Every issued stage claim (spawn intent) has proof for its exact call
      -- (job_stage_evidence), not only the latest: no stage call can outlive
      -- the admission slot. A claim whose call is unknown blocks release.
      IF EXISTS (SELECT 1 FROM public.job_stage_claims c
                 WHERE c.job_id = NEW.job_id
                   AND NOT EXISTS (SELECT 1 FROM public.job_stage_evidence e
                                   WHERE e.job_id = c.job_id AND e.stage = c.stage
                                     AND e.execution_ref = public.job_stage_call(c.job_id, c.stage))) THEN
        PERFORM public.catalog_raise('SAC04', 'every issued stage needs terminal evidence for its call');
      END IF;
    END IF;
    IF (NEW.kind = 'local_child_reaped') IS DISTINCT FROM (j.execution_backend = 'local') THEN
      PERFORM public.catalog_raise('SAC04', 'evidence kind does not match the job execution backend');
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Closure (replaces 009): binds to the seal nonce, counts clip files under
-- clips/ only (annotation outputs are not clip files), and keeps the
-- recording-level roles to recipe jobs.
CREATE OR REPLACE FUNCTION public.job_output_closures_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  limits public.job_inputs;
  n_files integer;
  n_bytes bigint;
  n_manifest integer;
  n_open integer;
  n_clip_files integer;
  n_ordinals integer;
  max_ordinal integer;
  bad_ordinals integer;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = NEW.job_id FOR UPDATE;
  SELECT * INTO limits FROM public.job_inputs WHERE job_id = NEW.job_id;
  IF NOT FOUND OR j.state <> 'running' OR j.claimed_at IS NULL
     OR public.job_seal_nonce(NEW.job_id) IS DISTINCT FROM NEW.invocation_nonce THEN
    PERFORM public.catalog_raise('SAC04', 'outputs close only for the running claimed invocation');
  END IF;
  SELECT count(*), coalesce(sum(f.size_bytes), 0),
         count(*) FILTER (WHERE f.role = 'result_manifest'),
         count(*) FILTER (WHERE f.state NOT IN ('completed', 'verified'))
    INTO n_files, n_bytes, n_manifest, n_open
  FROM public.files f WHERE f.job_id = NEW.job_id AND f.purpose = 'output';
  IF n_files = 0 OR n_open > 0 OR n_manifest <> 1 THEN
    PERFORM public.catalog_raise('SAC04', 'every output must be completed and exactly one result manifest present');
  END IF;
  IF n_files > limits.max_output_files OR n_bytes > limits.max_output_bytes THEN
    PERFORM public.catalog_raise('SAC03', 'output inventory exceeds the admitted caps');
  END IF;
  -- Every output file has a slot row and the slot matches the intended role.
  IF EXISTS (
    SELECT 1 FROM public.files f
    LEFT JOIN public.job_output_slots s ON s.file_id = f.id AND s.job_id = f.job_id
    WHERE f.job_id = NEW.job_id AND f.purpose = 'output'
      AND (s.slot IS NULL OR NOT public.job_output_slot_role_ok(s.slot, f.role)
           OR (j.recipe IS NULL AND f.role IN ('segments_json', 'captions_json', 'hand_presence_json',
                                               'recording_mp4', 'diagnostic_blob')))
  ) THEN
    PERFORM public.catalog_raise('SAC03', 'output slot does not match the intended role');
  END IF;
  -- Role caps: six roles per clip, ordinals contiguous from 000. Only clips/
  -- slots are clip files.
  SELECT count(*), count(DISTINCT substr(s.slot, 7, 3)), max(substr(s.slot, 7, 3)::integer)
    INTO n_clip_files, n_ordinals, max_ordinal
  FROM public.files f JOIN public.job_output_slots s ON s.file_id = f.id
  WHERE f.job_id = NEW.job_id AND f.purpose = 'output' AND s.slot LIKE 'clips/%';
  SELECT count(*) INTO bad_ordinals FROM (
    SELECT substr(s.slot, 7, 3) AS ord
    FROM public.files f JOIN public.job_output_slots s ON s.file_id = f.id
    WHERE f.job_id = NEW.job_id AND f.purpose = 'output' AND s.slot LIKE 'clips/%'
    GROUP BY 1 HAVING count(*) <> 6 OR count(DISTINCT f.role) <> 6
  ) b;
  IF n_ordinals > 999 OR (NEW.outcome = 'succeeded' AND (n_clip_files <> 6 * n_ordinals OR bad_ordinals > 0
     OR (n_ordinals > 0 AND max_ordinal <> n_ordinals - 1))) THEN
    PERFORM public.catalog_raise('SAC03', 'every clip needs exactly its six role files with contiguous ordinals');
  END IF;
  IF NEW.file_count <> n_files OR NEW.total_bytes <> n_bytes OR NEW.clip_count <> n_ordinals
     OR NOT EXISTS (SELECT 1 FROM public.files WHERE id = NEW.manifest_file_id AND job_id = NEW.job_id
                    AND role = 'result_manifest') THEN
    PERFORM public.catalog_raise('SAC03', 'closure does not describe the current output inventory');
  END IF;
  NEW.inventory_sha256 := public.job_output_inventory_digest(NEW.job_id);
  RETURN NEW;
END $$;

-- Candidates (replaces 009): bound to the seal nonce; verified annotation
-- counts are written once together with the verified status.
ALTER TABLE public.job_result_candidates
  ADD COLUMN verified_counts jsonb CHECK (verified_counts IS NULL OR (jsonb_typeof(verified_counts) = 'object'
    AND octet_length(verified_counts::text) <= 1024));

CREATE OR REPLACE FUNCTION public.job_result_candidates_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  c public.job_output_closures;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.catalog_raise('SAC01', 'result candidates are never deleted');
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO j FROM public.jobs WHERE id = NEW.job_id FOR UPDATE;
    SELECT * INTO c FROM public.job_output_closures WHERE job_id = NEW.job_id;
    -- Inserted by the same statement block that moved the job to result_pending.
    IF j.state <> 'result_pending' OR public.job_seal_nonce(NEW.job_id) IS DISTINCT FROM NEW.invocation_nonce
       OR c.job_id IS NULL OR c.invocation_nonce <> NEW.invocation_nonce
       OR c.manifest_file_id <> NEW.manifest_file_id OR c.inventory_sha256 <> NEW.inventory_sha256
       OR c.outcome <> NEW.outcome
       OR (NEW.outcome = 'succeeded' AND NEW.clip_count <> c.clip_count)
       OR (NEW.outcome = 'failed' AND NEW.clip_count <> 0)
       OR now() > j.execution_deadline THEN
      PERFORM public.catalog_raise('SAC04', 'a candidate needs the claiming nonce, the closed inventory and an unexpired deadline');
    END IF;
    IF NEW.status <> 'provisional' OR NEW.verified_counts IS NOT NULL THEN
      PERFORM public.catalog_raise('SAC04', 'candidates start provisional');
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.job_id, NEW.invocation_nonce, NEW.manifest_file_id, NEW.manifest_sha256, NEW.inventory_sha256,
      NEW.outcome, NEW.clip_count, NEW.error_code, NEW.summary, NEW.received_at)
     IS DISTINCT FROM
     (OLD.job_id, OLD.invocation_nonce, OLD.manifest_file_id, OLD.manifest_sha256, OLD.inventory_sha256,
      OLD.outcome, OLD.clip_count, OLD.error_code, OLD.summary, OLD.received_at) THEN
    PERFORM public.catalog_raise('SAC01', 'candidate identity is immutable');
  END IF;
  IF NOT ((OLD.status = 'provisional' AND NEW.status IN ('provisional', 'verified', 'rejected'))
       OR (OLD.status = 'verified' AND NEW.status IN ('verified', 'accepted', 'rejected'))
       OR NEW.status = OLD.status) THEN
    PERFORM public.catalog_raise('SAC04', 'illegal candidate transition ' || OLD.status || ' -> ' || NEW.status);
  END IF;
  IF OLD.status IN ('accepted', 'rejected') AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    PERFORM public.catalog_raise('SAC01', 'decided candidates are immutable');
  END IF;
  IF NEW.status = 'verified' AND OLD.status = 'provisional' AND EXISTS (
       SELECT 1 FROM public.files f WHERE f.job_id = NEW.job_id AND f.purpose = 'output'
         AND (NEW.outcome = 'succeeded' OR f.id = NEW.manifest_file_id)
         AND NOT EXISTS (SELECT 1 FROM public.job_output_verifications v
                         WHERE v.file_id = f.id AND v.inventory_sha256 = NEW.inventory_sha256)) THEN
    PERFORM public.catalog_raise('SAC04', 'a candidate is verified only after its required outputs were streamed and hashed');
  END IF;
  IF OLD.status = 'verified' AND NEW.verified_checks IS DISTINCT FROM OLD.verified_checks THEN
    PERFORM public.catalog_raise('SAC01', 'the verified checks are write-once');
  END IF;
  IF OLD.status = 'verified' AND NEW.clip_plan IS DISTINCT FROM OLD.clip_plan THEN
    PERFORM public.catalog_raise('SAC01', 'the verified clip plan is write-once');
  END IF;
  IF NEW.verified_counts IS DISTINCT FROM OLD.verified_counts
     AND NOT (OLD.status = 'provisional' AND NEW.status = 'verified' AND OLD.verified_counts IS NULL) THEN
    PERFORM public.catalog_raise('SAC01', 'the verified annotation counts are written once with the verified status');
  END IF;
  RETURN NEW;
END $$;

-- Acceptance (replaces 009): unchanged for jobs without a recipe. A recipe job
-- succeeds only with its hand-presence document (so 0 clips is accepted), its
-- verified annotation counts, and every stage of its recipe settled.
CREATE OR REPLACE FUNCTION public.jobs_acceptance_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c public.job_result_candidates;
  n_clips integer;
  counts jsonb;
BEGIN
  IF NEW.state = 'succeeded' AND OLD.state IS DISTINCT FROM 'succeeded' THEN
    SELECT * INTO c FROM public.job_result_candidates WHERE job_id = NEW.id;
    SELECT count(*) INTO n_clips FROM public.clips WHERE job_id = NEW.id;
    IF OLD.state <> 'result_pending' OR c.job_id IS NULL
       OR c.status <> 'verified' OR c.outcome <> 'succeeded'
       OR c.manifest_file_id IS DISTINCT FROM NEW.result_manifest_file_id
       OR c.manifest_sha256 IS DISTINCT FROM NEW.result_manifest_sha256
       OR c.clip_count <> n_clips
       OR c.received_at > NEW.execution_deadline
       OR NOT EXISTS (SELECT 1 FROM public.job_execution_evidence WHERE job_id = NEW.id)
       OR NOT EXISTS (SELECT 1 FROM public.recordings r WHERE r.id = NEW.recording_id
                      AND r.current_job_id = NEW.id AND r.deleted_at IS NULL AND r.status = 'processing')
       OR NOT EXISTS (SELECT 1 FROM public.job_output_closures WHERE job_id = NEW.id
                      AND inventory_sha256 = c.inventory_sha256)
       OR EXISTS (SELECT 1 FROM public.files f WHERE f.job_id = NEW.id AND f.purpose = 'output'
                  AND NOT EXISTS (SELECT 1 FROM public.job_output_verifications v
                                  WHERE v.file_id = f.id AND v.inventory_sha256 = c.inventory_sha256
                                    AND v.size_bytes = f.size_bytes AND v.sha256 = f.sha256)) THEN
      PERFORM public.catalog_raise('SAC04',
        'succeeded needs a verified candidate, its clips, the current pointer and terminal execution evidence');
    END IF;
    IF NEW.recipe IS NOT NULL THEN
      counts := c.verified_counts;
      IF counts IS NULL
         OR NOT EXISTS (SELECT 1 FROM public.files f WHERE f.job_id = NEW.id AND f.purpose = 'output'
                        AND f.role = 'hand_presence_json')
         OR (NEW.segment_count, NEW.failed_window_count, NEW.caption_count, NEW.caption_failed_count)
            IS DISTINCT FROM ((counts ->> 'segmentCount')::integer, (counts ->> 'failedWindowCount')::integer,
                              (counts ->> 'captionCount')::integer, (counts ->> 'captionFailedCount')::integer)
         OR NOT public.job_stage_prior_settled(NEW.id, NEW.recipe, 'hand_pose') THEN
        PERFORM public.catalog_raise('SAC04',
          'a recipe job succeeds with its hand presence, verified annotation counts and settled stages');
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ------------------------------------------------- definer write functions
-- Controller (lease owner): issue the single-use claim of one stage. Returns
-- 'issued' or 'already_issued' (the controller must not spawn again).
CREATE FUNCTION public.job_stage_issue_claim(
  p_job uuid, p_owner text, p_stage text, p_bootstrap_sha256 text, p_start_seconds integer
) RETURNS TABLE (outcome text, start_deadline timestamptz, execution_deadline timestamptz,
                 execution_backend text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  v_start timestamptz;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job;
  IF NOT FOUND THEN
    PERFORM public.catalog_raise('SAC05', 'Job not found');
  END IF;
  -- Lock order: recording, then job.
  PERFORM 1 FROM public.recordings WHERE id = j.recording_id FOR UPDATE;
  SELECT * INTO j FROM public.jobs WHERE id = p_job FOR UPDATE;
  IF j.recipe IS NULL THEN
    PERFORM public.catalog_raise('SAC04', 'job has no recipe; use record_worker_submission');
  END IF;
  IF j.controller_lease_owner IS DISTINCT FROM p_owner OR j.controller_lease_expires_at <= now() THEN
    PERFORM public.catalog_raise('SAC04', 'Job is not leased by this controller');
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_stage_claims c WHERE c.job_id = p_job AND c.stage = p_stage) THEN
    RETURN QUERY SELECT 'already_issued'::text, NULL::timestamptz, j.execution_deadline, j.execution_backend;
    RETURN;
  END IF;
  IF j.execution_deadline <= now() THEN
    PERFORM public.catalog_raise('SAC05', 'Job deadline has passed');
  END IF;
  v_start := LEAST(now() + make_interval(secs => p_start_seconds), j.execution_deadline);
  INSERT INTO public.job_stage_claims (job_id, stage, issued_by, bootstrap_token_sha256, start_deadline)
  VALUES (p_job, p_stage, p_owner, p_bootstrap_sha256, v_start);
  -- The first stage claim is the job's submission intent (SA-25: intent before
  -- any external effect), so recovery never treats the job as unsubmitted.
  IF j.submission_intent_at IS NULL THEN
    IF j.state <> 'submitting' THEN
      PERFORM public.catalog_raise('SAC04', 'Job is not awaiting submission');
    END IF;
    UPDATE public.jobs SET submission_intent_at = now(), submission_intent_owner = p_owner,
      bootstrap_token_sha256 = p_bootstrap_sha256, start_deadline = v_start
    WHERE id = p_job;
  END IF;
  RETURN QUERY SELECT 'issued'::text, v_start, j.execution_deadline, j.execution_backend;
END $$;
REVOKE ALL ON FUNCTION public.job_stage_issue_claim(uuid, text, text, text, integer) FROM PUBLIC;

-- Worker (stage bootstrap capability): win the one claim of that stage. The
-- first claimed stage also moves the job to running. Everything is rechecked
-- live; a replayed token or a second claim fails before any input is read.
CREATE FUNCTION public.job_stage_take_claim(
  p_job uuid, p_bootstrap_sha256 text, p_nonce text, p_backend text, p_call_id text,
  p_capability_sha256 text
) RETURNS TABLE (stage text, start_deadline timestamptz, execution_deadline timestamptz,
                 recording_id uuid, source_manifest_sha256 text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  c public.job_stage_claims;
  ok boolean;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job;
  IF NOT FOUND THEN
    PERFORM public.catalog_raise('SAC05', 'Not permitted');
  END IF;
  PERFORM 1 FROM public.recordings WHERE id = j.recording_id FOR UPDATE;
  SELECT * INTO j FROM public.jobs WHERE id = p_job FOR UPDATE;
  SELECT * INTO c FROM public.job_stage_claims s
  WHERE s.job_id = p_job AND s.bootstrap_token_sha256 = p_bootstrap_sha256 FOR UPDATE;
  IF NOT FOUND OR c.claimed_at IS NOT NULL
     OR NOT (j.state = 'running' OR (j.state IN ('submitting', 'submit_unknown') AND j.claimed_at IS NULL))
     OR EXISTS (SELECT 1 FROM public.job_stage_runs r WHERE r.job_id = p_job AND r.stage = c.stage
                AND public.job_stage_terminal(r.state)) THEN
    PERFORM public.catalog_raise('SAC04', 'Stage cannot be claimed');
  END IF;
  IF c.start_deadline <= now() OR j.execution_deadline <= now() THEN
    PERFORM public.catalog_raise('SAC05', 'Claim deadline has passed');
  END IF;
  IF j.execution_backend IS DISTINCT FROM p_backend THEN
    PERFORM public.catalog_raise('SAC04', 'Executor backend does not match the job');
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_stage_runs r WHERE r.job_id = p_job AND r.stage = c.stage
             AND r.call_id IS NOT NULL AND r.call_id <> p_call_id) THEN
    PERFORM public.catalog_raise('SAC04', 'Execution does not match the submitted execution');
  END IF;
  SELECT r.current_job_id = p_job AND r.deleted_at IS NULL AND r.status IN ('uploaded', 'processing')
         AND EXISTS (SELECT 1 FROM public.dispatch_admission a WHERE a.slot = 1 AND a.job_id = p_job)
         AND public.catalog_has_role(r.owner_user_id, 'collector')
         AND EXISTS (SELECT 1 FROM public.recording_registrations g
           WHERE g.recording_id = r.id AND g.owner_user_id = r.owner_user_id
             AND public.ingest_permission_ok(g.ingest_permission_id, g.owner_user_id, true))
    INTO ok FROM public.recordings r WHERE r.id = j.recording_id;
  IF NOT coalesce(ok, false) THEN
    PERFORM public.catalog_raise('SAC05', 'Job is not current');
  END IF;
  -- Stage claim first: the job-level claim of a recipe job must match it.
  UPDATE public.job_stage_claims s SET claimed_at = now(), invocation_nonce = p_nonce, call_id = p_call_id,
    capability_token_sha256 = p_capability_sha256, last_heartbeat_at = now()
  WHERE s.job_id = p_job AND s.stage = c.stage;
  IF j.state <> 'running' THEN
    UPDATE public.jobs SET state = 'running', claimed_at = now(), invocation_nonce = p_nonce,
      execution_call_id = COALESCE(execution_call_id, p_call_id),
      capability_token_sha256 = p_capability_sha256, last_heartbeat_at = now()
    WHERE id = p_job;
    UPDATE public.recordings SET status = 'processing' WHERE id = j.recording_id;
  END IF;
  RETURN QUERY SELECT c.stage, c.start_deadline, j.execution_deadline, j.recording_id,
    j.source_manifest_sha256::text;
END $$;
REVOKE ALL ON FUNCTION public.job_stage_take_claim(uuid, text, text, text, text, text) FROM PUBLIC;

-- Worker heartbeat for one claimed, unfinished stage of the current job.
-- Progress only: never extends a deadline. Mirrors the phase onto the job.
CREATE FUNCTION public.job_stage_heartbeat(
  p_job uuid, p_stage text, p_nonce text, p_phase text, p_processed bigint, p_total bigint
) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  deadline timestamptz;
BEGIN
  IF NOT public.job_current_ok(p_job) THEN
    RETURN NULL;
  END IF;
  UPDATE public.job_stage_claims c SET last_heartbeat_at = now(), heartbeat_phase = p_phase,
    processed_frames = p_processed, total_frames = p_total
  WHERE c.job_id = p_job AND c.stage = p_stage AND c.invocation_nonce = p_nonce AND c.claimed_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.job_stage_runs r WHERE r.job_id = c.job_id AND r.stage = c.stage
                    AND public.job_stage_terminal(r.state));
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  UPDATE public.jobs SET last_heartbeat_at = now(), heartbeat_phase = p_phase,
    processed_frames = p_processed, total_frames = p_total
  WHERE id = p_job RETURNING jobs.execution_deadline INTO deadline;
  RETURN deadline;
END $$;
REVOKE ALL ON FUNCTION public.job_stage_heartbeat(uuid, text, text, text, bigint, bigint) FROM PUBLIC;

-- Controller (lease owner): record one stage run state. Returns true when the
-- row changed, false for an identical replay. On a job that has already ended
-- (its lease can no longer be renewed) the recorded lease owner may still
-- settle an open stage, but only to a terminal state.
CREATE FUNCTION public.job_stage_record_run(
  p_job uuid, p_owner text, p_stage text, p_state text, p_module text, p_call_id text,
  p_error_code text, p_receipt jsonb, p_receipt_sha256 text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  r public.job_stage_runs;
  ended boolean;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.catalog_raise('SAC05', 'Job not found');
  END IF;
  ended := j.state IN ('succeeded', 'failed', 'cancelled');
  IF j.controller_lease_owner IS DISTINCT FROM p_owner
     OR (NOT ended AND j.controller_lease_expires_at <= now())
     OR j.state = 'queued' THEN
    PERFORM public.catalog_raise('SAC04', 'Job is not leased by this controller');
  END IF;
  IF ended AND NOT public.job_stage_terminal(p_state) THEN
    PERFORM public.catalog_raise('SAC04', 'an ended job only settles open stages');
  END IF;
  SELECT * INTO r FROM public.job_stage_runs s WHERE s.job_id = p_job AND s.stage = p_stage FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.job_stage_runs (job_id, stage, state, module, call_id, requested_gpu, error_code,
      unknown_reason, receipt, receipt_sha256, recorded_by)
    VALUES (p_job, p_stage, p_state, p_module, p_call_id, 'none', p_error_code,
      CASE WHEN p_state = 'submit_unknown' THEN 'submit_outcome_unknown' END,
      p_receipt, p_receipt_sha256, p_owner);
    RETURN true;
  END IF;
  -- A different call than the recorded one is a second spawn: never masked.
  IF r.call_id IS NOT NULL AND p_call_id IS NOT NULL AND p_call_id <> r.call_id THEN
    PERFORM public.catalog_raise('SAC04', 'a different call is already recorded for this stage');
  END IF;
  IF r.state = p_state AND r.module = p_module
     AND (p_call_id IS NULL OR r.call_id IS NOT DISTINCT FROM p_call_id)
     AND r.error_code IS NOT DISTINCT FROM p_error_code
     AND (p_receipt_sha256 IS NULL OR r.receipt_sha256 IS NOT DISTINCT FROM p_receipt_sha256) THEN
    RETURN false;
  END IF;
  UPDATE public.job_stage_runs s SET state = p_state, module = p_module,
    call_id = COALESCE(s.call_id, p_call_id), error_code = p_error_code,
    unknown_reason = COALESCE(s.unknown_reason, CASE WHEN p_state = 'submit_unknown' THEN 'submit_outcome_unknown' END),
    receipt = COALESCE(p_receipt, s.receipt), receipt_sha256 = COALESCE(p_receipt_sha256, s.receipt_sha256),
    recorded_by = p_owner
  WHERE s.job_id = p_job AND s.stage = p_stage;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.job_stage_record_run(uuid, text, text, text, text, text, text, jsonb, text) FROM PUBLIC;

-- Controller: authoritative terminal proof for the exact call of one stage.
-- Returns the stage, or raises when the reference names no stage call. A
-- replay of the same proof is a no-op; a different proof is refused.
CREATE FUNCTION public.job_stage_record_evidence(
  p_job uuid, p_kind text, p_ref text, p_detail jsonb, p_by text
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_stage text;
  e public.job_stage_evidence;
BEGIN
  PERFORM 1 FROM public.jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.catalog_raise('SAC05', 'Job not found');
  END IF;
  SELECT c.stage INTO v_stage FROM public.job_stage_claims c
  WHERE c.job_id = p_job AND public.job_stage_call(c.job_id, c.stage) = p_ref;
  IF v_stage IS NULL THEN
    PERFORM public.catalog_raise('SAC04', 'evidence must name the call of an issued stage');
  END IF;
  SELECT * INTO e FROM public.job_stage_evidence x WHERE x.job_id = p_job AND x.stage = v_stage;
  IF FOUND THEN
    IF e.kind <> p_kind OR e.execution_ref <> p_ref THEN
      PERFORM public.catalog_raise('SAC01', 'stage evidence is append-only');
    END IF;
    RETURN v_stage;
  END IF;
  INSERT INTO public.job_stage_evidence (job_id, stage, kind, execution_ref, detail, recorded_by)
  VALUES (p_job, v_stage, p_kind, p_ref, coalesce(p_detail, '{}'::jsonb), p_by);
  RETURN v_stage;
END $$;
REVOKE ALL ON FUNCTION public.job_stage_record_evidence(uuid, text, text, jsonb, text) FROM PUBLIC;

-- ------------------------------------------------------------- privileges
-- Chained after the 003-010 helpers. The web role reads the stage tables and
-- writes them only through the definer functions above.
CREATE FUNCTION public.stateaction_grant_stage_runs(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.job_stage_runs, public.job_stage_claims, public.job_stage_evidence FROM %I', app_role);
  EXECUTE format('GRANT SELECT ON TABLE public.job_stage_runs, public.job_stage_claims, public.job_stage_evidence TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.job_stage_record_evidence(uuid, text, text, jsonb, text) TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.job_stage_issue_claim(uuid, text, text, text, integer) TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.job_stage_take_claim(uuid, text, text, text, text, text) TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.job_stage_heartbeat(uuid, text, text, text, bigint, bigint) TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.job_stage_record_run(uuid, text, text, text, text, text, text, jsonb, text) TO %I', app_role);
  -- Recipe identity at admission; accepted counts at acceptance (triggers fence both).
  EXECUTE format('GRANT UPDATE (recipe, recipe_sha256, segment_count, failed_window_count, caption_count, caption_failed_count) ON TABLE public.jobs TO %I', app_role);
  EXECUTE format('GRANT UPDATE (verified_counts) ON TABLE public.job_result_candidates TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_stage_runs(name) FROM PUBLIC;
