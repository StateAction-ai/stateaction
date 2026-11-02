-- SA-28 worker output sealing and atomic result acceptance (migration 009).
-- Additive only: 001-008 are unchanged. Every function pins
-- search_path = pg_catalog, public, pg_temp and schema-qualifies relations.
--
-- Invariants enforced by the database UNCONDITIONALLY (not only by application code;
-- there is no policy flag, bypass table or test switch):
--   * A job's output inventory is CLOSED exactly once (job_output_closures,
--     append-only) after every output file is completed. A closed inventory
--     accepts no new output file, no receipt, and no transport change.
--   * Exactly one provisional result candidate per job, pinned to the closed
--     inventory, the claiming invocation nonce and the closed manifest file.
--   * A job reaches `succeeded` only from `result_pending` with a verified
--     candidate for the exact result manifest, every clip row present, the
--     candidate received before the fixed execution deadline, the recording
--     still pointing at this job, AND authoritative terminal execution evidence.
--     A callback alone never selects a result; the slot still needs evidence
--     plus this terminal state (SA-25 dispatch_try_release).
-- SQLSTATE classes reused from 003: SAC01 immutable, SAC03 plan, SAC04 lifecycle.

-- ------------------------------------------------------------------ policy
-- Intended output slots. result-manifest.json is the only control document;
-- every clip has exactly the six roles under clips/NNN/. Anything else cannot
-- be closed and therefore can never be accepted.
CREATE FUNCTION public.job_output_slot_role_ok(p_slot text, p_role text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN p_slot = 'result-manifest.json' THEN p_role = 'result_manifest'
    WHEN p_slot ~ '^clips/[0-9]{3}/rgb\.mp4$' THEN p_role = 'clip_mp4'
    WHEN p_slot ~ '^clips/[0-9]{3}/hand-arrays\.npz$' THEN p_role = 'hand_arrays_npz'
    WHEN p_slot ~ '^clips/[0-9]{3}/hand-observations\.json$' THEN p_role = 'hand_observations_json'
    WHEN p_slot ~ '^clips/[0-9]{3}/frame-map\.json$' THEN p_role = 'frame_map_json'
    WHEN p_slot ~ '^clips/[0-9]{3}/thumbnail\.jpg$' THEN p_role = 'thumbnail_jpeg'
    WHEN p_slot ~ '^clips/[0-9]{3}/viewer\.rrd$' THEN p_role = 'viewer_rrd'
    ELSE false
  END
$$;

-- Deterministic digest of a job's output inventory, computed in the database
-- so the stored value is the single source of truth.
CREATE FUNCTION public.job_output_inventory_digest(p_job uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT encode(sha256(convert_to(coalesce(string_agg(
    s.slot || ':' || f.id::text || ':' || f.role || ':' || f.size_bytes::text || ':' || f.sha256,
    E'\n' ORDER BY s.slot), ''), 'UTF8')), 'hex')
  FROM public.files f JOIN public.job_output_slots s ON s.file_id = f.id AND s.job_id = f.job_id
  WHERE f.job_id = p_job AND f.purpose = 'output'
$$;

-- ---------------------------------------------------------------- closures
CREATE TABLE public.job_output_closures (
  job_id uuid PRIMARY KEY REFERENCES public.jobs (id),
  invocation_nonce text NOT NULL CHECK (length(invocation_nonce) BETWEEN 16 AND 200),
  -- The worker's declared outcome. A failed run may leave partial clip files in
  -- the inventory (retained for diagnostics, never accepted); only a succeeded
  -- closure must have complete six-role clips.
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  file_count integer NOT NULL CHECK (file_count BETWEEN 1 AND 2000),
  clip_count integer NOT NULL CHECK (clip_count BETWEEN 0 AND 999),
  total_bytes bigint NOT NULL CHECK (total_bytes >= 1),
  manifest_file_id uuid NOT NULL UNIQUE REFERENCES public.files (id),
  inventory_sha256 public.sha256_hex NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, inventory_sha256)
);
CREATE TRIGGER job_output_closures_immutable BEFORE UPDATE OR DELETE ON public.job_output_closures
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();

CREATE FUNCTION public.job_output_closures_guard() RETURNS trigger
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
     OR j.invocation_nonce IS DISTINCT FROM NEW.invocation_nonce THEN
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
      AND (s.slot IS NULL OR NOT public.job_output_slot_role_ok(s.slot, f.role))
  ) THEN
    PERFORM public.catalog_raise('SAC03', 'output slot does not match the intended role');
  END IF;
  -- Role caps: six roles per clip, ordinals contiguous from 000.
  SELECT count(*), count(DISTINCT substr(s.slot, 7, 3)), max(substr(s.slot, 7, 3)::integer)
    INTO n_clip_files, n_ordinals, max_ordinal
  FROM public.files f JOIN public.job_output_slots s ON s.file_id = f.id
  WHERE f.job_id = NEW.job_id AND f.purpose = 'output' AND f.role <> 'result_manifest';
  SELECT count(*) INTO bad_ordinals FROM (
    SELECT substr(s.slot, 7, 3) AS ord
    FROM public.files f JOIN public.job_output_slots s ON s.file_id = f.id
    WHERE f.job_id = NEW.job_id AND f.purpose = 'output' AND f.role <> 'result_manifest'
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
CREATE TRIGGER job_output_closures_guard BEFORE INSERT ON public.job_output_closures
  FOR EACH ROW EXECUTE FUNCTION public.job_output_closures_guard();

-- Closed inventory: no new output file, slot or receipt; the only legal change
-- to a closed output file is completed -> verified (acceptance).
CREATE FUNCTION public.output_inventory_closed_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  job uuid;
BEGIN
  IF TG_TABLE_NAME = 'files' THEN
    IF NEW.purpose <> 'output' THEN RETURN NEW; END IF;
    job := NEW.job_id;
  ELSIF TG_TABLE_NAME = 'job_output_slots' THEN
    job := NEW.job_id;
  ELSE
    SELECT f.job_id INTO job FROM public.files f WHERE f.id = NEW.file_id AND f.purpose = 'output';
    IF job IS NULL THEN RETURN NEW; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.job_output_closures WHERE job_id = job) THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'files' AND TG_OP = 'UPDATE'
     AND (NEW.transport_epoch, NEW.object_key, NEW.provider_upload_id, NEW.part_count,
          NEW.observed_size_bytes, NEW.completed_at)
         IS NOT DISTINCT FROM
         (OLD.transport_epoch, OLD.object_key, OLD.provider_upload_id, OLD.part_count,
          OLD.observed_size_bytes, OLD.completed_at)
     AND (NEW.state = OLD.state OR (OLD.state = 'completed' AND NEW.state = 'verified')) THEN
    RETURN NEW;
  END IF;
  PERFORM public.catalog_raise('SAC04', 'closed output inventory accepts no further writes');
  RETURN NEW;
END $$;
CREATE TRIGGER output_inventory_closed_files BEFORE INSERT OR UPDATE ON public.files
  FOR EACH ROW EXECUTE FUNCTION public.output_inventory_closed_guard();
CREATE TRIGGER output_inventory_closed_slots BEFORE INSERT OR UPDATE ON public.job_output_slots
  FOR EACH ROW EXECUTE FUNCTION public.output_inventory_closed_guard();
CREATE TRIGGER output_inventory_closed_receipts BEFORE INSERT OR UPDATE ON public.file_part_receipts
  FOR EACH ROW EXECUTE FUNCTION public.output_inventory_closed_guard();

-- -------------------------------------------------- durable verification
-- Per-file progress of the server's streaming verification (hash of the exact
-- stored bytes against the declared SHA-256 and size). Idempotent and
-- resumable: if a request ends mid-way, reconciliation continues from here.
-- Rows are bound to the closed inventory they were verified under.
CREATE TABLE public.job_output_verifications (
  file_id uuid PRIMARY KEY REFERENCES public.files (id),
  job_id uuid NOT NULL REFERENCES public.jobs (id),
  inventory_sha256 public.sha256_hex NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 1),
  sha256 public.sha256_hex NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, inventory_sha256) REFERENCES public.job_output_closures (job_id, inventory_sha256),
  FOREIGN KEY (file_id, job_id, sha256) REFERENCES public.files (id, job_id, sha256)
);
CREATE TRIGGER job_output_verifications_immutable BEFORE UPDATE OR DELETE ON public.job_output_verifications
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE FUNCTION public.job_output_verifications_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.files f WHERE f.id = NEW.file_id AND f.job_id = NEW.job_id
                 AND f.purpose = 'output' AND f.state IN ('completed', 'verified')
                 AND f.size_bytes = NEW.size_bytes AND f.observed_size_bytes = NEW.size_bytes) THEN
    PERFORM public.catalog_raise('SAC04', 'only a completed output of the exact size can be verified');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_output_verifications_guard BEFORE INSERT ON public.job_output_verifications
  FOR EACH ROW EXECUTE FUNCTION public.job_output_verifications_guard();

-- --------------------------------------------------------------- candidates
CREATE TABLE public.job_result_candidates (
  job_id uuid PRIMARY KEY REFERENCES public.jobs (id),
  invocation_nonce text NOT NULL CHECK (length(invocation_nonce) BETWEEN 16 AND 200),
  manifest_file_id uuid NOT NULL,
  manifest_sha256 public.sha256_hex NOT NULL,
  inventory_sha256 public.sha256_hex NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  clip_count integer NOT NULL CHECK (clip_count BETWEEN 0 AND 999),
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object' AND octet_length(summary::text) <= 4096),
  status text NOT NULL DEFAULT 'provisional' CHECK (status IN ('provisional', 'verified', 'accepted', 'rejected')),
  -- Verified clip rows derived from the hash-checked manifest; set with status verified.
  clip_plan jsonb CHECK (clip_plan IS NULL OR (jsonb_typeof(clip_plan) = 'array' AND octet_length(clip_plan::text) <= 1048576)),
  -- The hash-verified bounded `checks` array of the manifest (names, statuses, counts,
  -- reasons): read model for staff review. Set once with the verified status, never a
  -- callback assertion; legacy fixtures store an empty array (= not evaluated).
  verified_checks jsonb CHECK (verified_checks IS NULL OR (jsonb_typeof(verified_checks) = 'array'
    AND jsonb_array_length(verified_checks) <= 64 AND octet_length(verified_checks::text) <= 65536)),
  reason_code text CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  reason_detail jsonb CHECK (reason_detail IS NULL OR (jsonb_typeof(reason_detail) = 'object' AND octet_length(reason_detail::text) <= 4096)),
  received_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  decided_at timestamptz,
  FOREIGN KEY (manifest_file_id, job_id, manifest_sha256) REFERENCES public.files (id, job_id, sha256),
  FOREIGN KEY (job_id, inventory_sha256) REFERENCES public.job_output_closures (job_id, inventory_sha256),
  CHECK ((outcome = 'succeeded') = (error_code IS NULL)),
  CHECK (outcome = 'succeeded' OR clip_count = 0),
  CHECK ((status = 'rejected') = (reason_code IS NOT NULL)),
  CHECK ((status IN ('verified', 'accepted')) = (verified_at IS NOT NULL) OR status = 'rejected'),
  CHECK ((status IN ('verified', 'accepted')) = (clip_plan IS NOT NULL) OR status = 'rejected')
);

CREATE FUNCTION public.job_result_candidates_guard() RETURNS trigger
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
    IF j.state <> 'result_pending' OR j.invocation_nonce IS DISTINCT FROM NEW.invocation_nonce
       OR c.job_id IS NULL OR c.invocation_nonce <> NEW.invocation_nonce
       OR c.manifest_file_id <> NEW.manifest_file_id OR c.inventory_sha256 <> NEW.inventory_sha256
       OR c.outcome <> NEW.outcome
       OR (NEW.outcome = 'succeeded' AND NEW.clip_count <> c.clip_count)
       OR (NEW.outcome = 'failed' AND NEW.clip_count <> 0)
       OR now() > j.execution_deadline THEN
      PERFORM public.catalog_raise('SAC04', 'a candidate needs the claiming nonce, the closed inventory and an unexpired deadline');
    END IF;
    IF NEW.status <> 'provisional' THEN
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
  IF OLD.status = 'verified' AND NEW.status = 'verified' AND NEW.clip_plan IS DISTINCT FROM OLD.clip_plan THEN
    PERFORM public.catalog_raise('SAC01', 'the verified clip plan is write-once');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_result_candidates_guard BEFORE INSERT OR UPDATE OR DELETE ON public.job_result_candidates
  FOR EACH ROW EXECUTE FUNCTION public.job_result_candidates_guard();

-- ----------------------------------------------------------- acceptance guard
-- succeeded needs every acceptance fact; the application cannot skip them.
CREATE FUNCTION public.jobs_acceptance_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c public.job_result_candidates;
  n_clips integer;
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
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_acceptance_guard BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_acceptance_guard();

-- A recording becomes reviewable only through its succeeded current job.
CREATE FUNCTION public.recordings_review_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.status = 'reviewable' AND OLD.status IS DISTINCT FROM 'reviewable'
     AND NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = NEW.current_job_id
                     AND j.recording_id = NEW.id AND j.state = 'succeeded') THEN
    PERFORM public.catalog_raise('SAC04', 'a recording is reviewable only after its current job succeeded');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recordings_review_guard BEFORE UPDATE ON public.recordings
  FOR EACH ROW EXECUTE FUNCTION public.recordings_review_guard();

-- ------------------------------------------------------------- privileges
CREATE FUNCTION public.stateaction_grant_output_acceptance(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.job_output_closures, public.job_result_candidates, public.job_output_verifications FROM %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT ON TABLE public.job_output_closures, public.job_result_candidates, public.job_output_verifications TO %I', app_role);
  EXECUTE format('GRANT UPDATE (status, clip_plan, verified_checks, reason_code, reason_detail, verified_at, decided_at) ON TABLE public.job_result_candidates TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_output_acceptance(name) FROM PUBLIC;
