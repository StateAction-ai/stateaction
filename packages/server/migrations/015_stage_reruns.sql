ALTER TABLE public.jobs
  ADD COLUMN derived_from_job_id uuid,
  ADD CONSTRAINT jobs_rerun_parent_same_recording
    FOREIGN KEY (derived_from_job_id, recording_id) REFERENCES public.jobs (id, recording_id),
  ADD CONSTRAINT jobs_rerun_parent_distinct CHECK (id IS DISTINCT FROM derived_from_job_id),
  ADD CONSTRAINT jobs_rerun_retry_exclusive CHECK (previous_job_id IS NULL OR derived_from_job_id IS NULL);

CREATE OR REPLACE FUNCTION public.jobs_ingest_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  reg public.recording_registrations;
  adm public.recording_admissions;
BEGIN
  -- Other kinds are rejected by the jobs CHECK constraint itself.
  IF NEW.kind IS DISTINCT FROM 'process_recording' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO reg FROM public.recording_registrations WHERE recording_id = NEW.recording_id;
  IF reg.recording_id IS NULL
     OR NOT public.ingest_permission_ok(reg.ingest_permission_id, reg.owner_user_id, true) THEN
    PERFORM public.catalog_raise('SAC05', 'processing needs a registered recording with active capture and processing permission evidence');
  END IF;
  SELECT * INTO adm FROM public.recording_admissions WHERE recording_id = NEW.recording_id;
  IF adm.recording_id IS NULL OR adm.outcome <> 'admitted'
     OR adm.source_manifest_sha256 IS DISTINCT FROM NEW.source_manifest_sha256
     OR (NEW.previous_job_id IS NULL AND NEW.derived_from_job_id IS NULL AND adm.job_id IS DISTINCT FROM NEW.id) THEN
    PERFORM public.catalog_raise('SAC04', 'processing needs validated admission evidence for this job');
  END IF;
  IF NEW.derived_from_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.jobs p
    WHERE p.id = NEW.derived_from_job_id AND p.recording_id = NEW.recording_id
      AND p.source_manifest_sha256 = NEW.source_manifest_sha256
      AND (p.recipe IS NOT NULL OR EXISTS (
        SELECT 1 FROM public.cached_processing_imports i
        WHERE i.job_id = p.id AND p.kind = 'cached_import'
          AND i.manifest_sha256 = p.result_manifest_sha256
          AND i.inventory_sha256 = public.job_output_inventory_digest(p.id)
      )) AND p.state IN ('succeeded', 'failed', 'cancelled')
      AND (p.admitted_at IS NULL OR EXISTS (
        SELECT 1 FROM public.job_execution_evidence e WHERE e.job_id = p.id
      ))
      AND NOT EXISTS (SELECT 1 FROM public.dispatch_admission a WHERE a.job_id = p.id)
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'rerun needs a settled recipe parent with the same sealed source');
  END IF;
  RETURN NEW;
END $$;
CREATE INDEX jobs_rerun_parent_idx ON public.jobs (derived_from_job_id)
  WHERE derived_from_job_id IS NOT NULL;

CREATE FUNCTION public.job_rerun_parent_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.derived_from_job_id IS DISTINCT FROM OLD.derived_from_job_id THEN
    PERFORM public.catalog_raise('SAC01', 'rerun parent is immutable');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_rerun_parent_guard BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.job_rerun_parent_guard();

CREATE TABLE public.job_rerun_plans (
  job_id uuid PRIMARY KEY REFERENCES public.jobs (id),
  actor_id text NOT NULL REFERENCES public."user" (id),
  request_sha256 public.sha256_hex NOT NULL,
  plan_sha256 public.sha256_hex NOT NULL,
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object' AND octet_length(plan::text) <= 2097152),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.job_stage_reuse (
  job_id uuid NOT NULL REFERENCES public.job_rerun_plans (job_id),
  stage text NOT NULL CHECK (stage IN ('segment', 'caption', 'hand_pose')),
  source_job_id uuid NOT NULL REFERENCES public.jobs (id),
  execution_job_id uuid,
  import_job_id uuid REFERENCES public.cached_processing_imports (job_id),
  imported_counts jsonb CHECK (jsonb_typeof(imported_counts) = 'object'),
  state text NOT NULL CHECK (state IN ('succeeded', 'failed', 'cancelled', 'not_run')),
  fingerprint_sha256 public.sha256_hex,
  receipt_sha256 public.sha256_hex,
  error_code text,
  PRIMARY KEY (job_id, stage),
  FOREIGN KEY (execution_job_id, stage) REFERENCES public.job_stage_runs (job_id, stage),
  CHECK (job_id <> source_job_id AND job_id IS DISTINCT FROM execution_job_id),
  CHECK ((import_job_id IS NULL AND imported_counts IS NULL) OR
    (job_id <> import_job_id AND state = 'succeeded' AND execution_job_id IS NULL
      AND receipt_sha256 IS NULL AND imported_counts IS NOT NULL)),
  CHECK (state <> 'succeeded' OR (fingerprint_sha256 IS NOT NULL AND
    (import_job_id IS NOT NULL OR (execution_job_id IS NOT NULL AND receipt_sha256 IS NOT NULL))))
);

CREATE TABLE public.job_rerun_copies (
  job_id uuid NOT NULL,
  stage text NOT NULL,
  source_file_id uuid NOT NULL,
  source_job_id uuid NOT NULL,
  original_file_id uuid NOT NULL,
  original_job_id uuid NOT NULL,
  file_id uuid NOT NULL UNIQUE,
  slot text NOT NULL,
  role text NOT NULL CHECK (role <> 'result_manifest'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 public.sha256_hex NOT NULL,
  copy_revision integer NOT NULL DEFAULT 0 CHECK (copy_revision >= 0),
  source_checked boolean NOT NULL DEFAULT false,
  provider_upload_id text,
  provider_part_tags text[] NOT NULL DEFAULT '{}',
  target_ready boolean NOT NULL DEFAULT false,
  PRIMARY KEY (job_id, slot),
  CHECK (provider_upload_id IS NOT NULL OR cardinality(provider_part_tags) = 0),
  CHECK (source_checked OR NOT target_ready),
  FOREIGN KEY (job_id, stage) REFERENCES public.job_stage_reuse (job_id, stage),
  FOREIGN KEY (source_file_id, source_job_id, sha256) REFERENCES public.files (id, job_id, sha256),
  FOREIGN KEY (original_file_id, original_job_id, sha256) REFERENCES public.files (id, job_id, sha256),
  FOREIGN KEY (file_id, job_id, sha256) REFERENCES public.files (id, job_id, sha256)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (public.job_output_slot_role_ok(slot, role) AND job_id <> source_job_id)
);

CREATE TABLE public.recording_result_selections (
  recording_id uuid NOT NULL REFERENCES public.recordings (id),
  seq integer NOT NULL CHECK (seq > 0),
  job_id uuid NOT NULL,
  selected_by text REFERENCES public."user" (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 512),
  kind text NOT NULL CHECK (kind IN ('auto', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recording_id, seq),
  FOREIGN KEY (job_id, recording_id) REFERENCES public.jobs (id, recording_id),
  CHECK (kind <> 'manual' OR selected_by IS NOT NULL)
);

INSERT INTO public.recording_result_selections (recording_id, seq, job_id, reason, kind)
SELECT DISTINCT ON (j.recording_id) j.recording_id, 1, j.id, 'Existing accepted result', 'auto'
FROM public.jobs j JOIN public.recordings r ON r.id = j.recording_id
WHERE j.state = 'succeeded' AND r.deleted_at IS NULL
ORDER BY j.recording_id, (j.id = r.current_job_id) DESC NULLS LAST, j.finished_at DESC, j.id;

CREATE FUNCTION public.recording_result_selection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.recordings
    WHERE id = NEW.recording_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
      SELECT 1 FROM public.jobs
      WHERE id = NEW.job_id AND recording_id = NEW.recording_id AND state = 'succeeded'
    ) THEN
    PERFORM public.catalog_raise('SAC04', 'selection needs an accepted result of a live recording');
  END IF;
  IF NEW.kind = 'manual' AND NOT public.catalog_has_role(NEW.selected_by, 'staff') THEN
    PERFORM public.catalog_raise('SAC05', 'result selection requires staff');
  END IF;
  IF NEW.seq <> 1 + coalesce((
      SELECT max(seq) FROM public.recording_result_selections WHERE recording_id = NEW.recording_id
    ), 0) THEN
    PERFORM public.catalog_raise('SAC03', 'selection revision changed');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recording_result_selection_guard BEFORE INSERT ON public.recording_result_selections
  FOR EACH ROW EXECUTE FUNCTION public.recording_result_selection_guard();

CREATE FUNCTION public.recording_selected_job(p_recording_id uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT job_id FROM public.recording_result_selections
  WHERE recording_id = p_recording_id ORDER BY seq DESC LIMIT 1
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'job_rerun_plans', 'job_stage_reuse', 'recording_result_selections'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change()', t || '_immutable', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I
      FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change()', t || '_no_truncate', t);
  END LOOP;
END $$;

CREATE FUNCTION public.job_rerun_copy_progress_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE progress text[] := ARRAY[
  'copy_revision', 'source_checked', 'provider_upload_id', 'provider_part_tags', 'target_ready'
];
BEGIN
  IF TG_OP <> 'UPDATE'
    OR (to_jsonb(NEW) - progress) IS DISTINCT FROM (to_jsonb(OLD) - progress)
    OR NEW.copy_revision <> OLD.copy_revision + 1
    OR (OLD.source_checked AND NOT NEW.source_checked)
    OR OLD.target_ready THEN
    PERFORM public.catalog_raise('SAC01', 'copy inventory is immutable; only fenced progress may advance');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_rerun_copies_progress_guard BEFORE UPDATE OR DELETE ON public.job_rerun_copies
  FOR EACH ROW EXECUTE FUNCTION public.job_rerun_copy_progress_guard();
CREATE TRIGGER job_rerun_copies_no_truncate BEFORE TRUNCATE ON public.job_rerun_copies
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

CREATE OR REPLACE FUNCTION public.files_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  parent_state text;
  parent_manifest uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'reserved' OR NEW.transport_epoch <> 1 THEN
      PERFORM public.catalog_raise('SAC04', 'files start reserved at transport epoch 1');
    END IF;
    -- Lock and recheck the parent: a concurrent seal/acceptance holds it
    -- FOR UPDATE, so this waits and then sees the committed state.
    IF NEW.purpose = 'source' THEN
      SELECT status INTO parent_state FROM public.recordings
      WHERE id = NEW.recording_id AND source_manifest_file_id IS NULL FOR SHARE;
      IF parent_state IS NULL OR parent_state NOT IN ('registered', 'uploading') THEN
        PERFORM public.catalog_raise('SAC04', 'recording no longer accepts source files');
      END IF;
    ELSE
      SELECT state INTO parent_state FROM public.jobs WHERE id = NEW.job_id FOR SHARE;
      IF (parent_state IS NULL OR parent_state NOT IN ('running', 'result_pending'))
         AND NOT (parent_state = 'submitting' AND EXISTS (
           SELECT 1 FROM public.job_rerun_copies c
           WHERE c.job_id = NEW.job_id AND c.file_id = NEW.id AND c.role = NEW.role
             AND c.sha256 = NEW.sha256 AND c.size_bytes = NEW.size_bytes
             AND NEW.object_key = 'jobs/' || c.job_id || '/outputs/' || c.file_id || '/e1/' || c.slot
         )) THEN
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
  -- Seal freezes the declared source inventory. Retiring a logical source
  -- file (cancelled/failed/expired) is only valid before seal; afterwards a
  -- transport abort/restart keeps the file live under a new epoch. Lock the
  -- parent like the insert path so this serializes with a concurrent seal
  -- (lock order: recording row, then file row, for helpers touching both).
  IF NEW.purpose = 'source' AND NEW.state IN ('cancelled', 'failed', 'expired')
     AND OLD.state NOT IN ('cancelled', 'failed', 'expired') THEN
    SELECT source_manifest_file_id INTO parent_manifest FROM public.recordings
    WHERE id = NEW.recording_id FOR SHARE;
    IF NOT FOUND OR parent_manifest IS NOT NULL THEN
      PERFORM public.catalog_raise('SAC04', 'a sealed recording cannot retire declared source files');
    END IF;
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
CREATE FUNCTION public.job_rerun_preparation_ok(p_job uuid, p_owner text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
    JOIN public.recordings r ON r.id = j.recording_id
    JOIN public.dispatch_admission a ON a.slot = 1 AND a.job_id = j.id
    WHERE j.id = p_job AND j.derived_from_job_id IS NOT NULL AND j.state = 'submitting'
      AND r.current_job_id = j.id AND r.deleted_at IS NULL AND r.status = 'processing'
      AND j.controller_lease_owner = p_owner AND j.controller_lease_expires_at > clock_timestamp()
      AND j.execution_deadline > clock_timestamp() AND j.submission_intent_at IS NULL
      AND public.catalog_has_role(r.owner_user_id, 'collector')
      AND EXISTS (
        SELECT 1 FROM public.recording_registrations g
        WHERE g.recording_id = r.id AND g.owner_user_id = r.owner_user_id
          AND public.ingest_permission_ok(g.ingest_permission_id, g.owner_user_id, true)
      )
  )
$$;

CREATE FUNCTION public.job_rerun_reserve_copies(p_job uuid, p_owner text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  p jsonb;
  x jsonb;
  f jsonb;
  src public.files;
  child_id uuid;
  digest public.sha256_hex;
BEGIN
  PERFORM 1 FROM public.recordings r JOIN public.jobs child ON child.recording_id = r.id
  WHERE child.id = p_job FOR KEY SHARE OF r;
  SELECT * INTO j FROM public.jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND OR NOT public.job_rerun_preparation_ok(p_job, p_owner) THEN
    PERFORM public.catalog_raise('SAC04', 'rerun preparation needs a current controller lease');
  END IF;
  SELECT plan INTO p FROM public.job_rerun_plans WHERE job_id = p_job;
  IF NOT FOUND THEN PERFORM public.catalog_raise('SAC04', 'rerun has no confirmed plan'); END IF;
  -- The whole inventory is prepared in this transaction. A later call only
  -- advances one reserved file and does not walk the complete plan again.
  IF EXISTS (SELECT 1 FROM public.job_stage_reuse WHERE job_id = p_job) THEN
    RETURN true;
  END IF;
  FOR x IN SELECT value FROM jsonb_array_elements(p -> 'reuse') LOOP
    IF x ->> 'sourceJobId' IS DISTINCT FROM j.derived_from_job_id::text
       OR (p -> 'execute') ? (x ->> 'stage') THEN
      PERFORM public.catalog_raise('SAC04', 'reuse does not match the confirmed parent and stage');
    END IF;
    IF x ->> 'importJobId' IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.cached_processing_imports i JOIN public.jobs origin ON origin.id = i.job_id
      WHERE i.job_id = (x ->> 'importJobId')::uuid AND i.manifest_sha256 = x ->> 'importManifestSha256'
        AND origin.recording_id = j.recording_id AND origin.state = 'succeeded' AND
        (i.job_id = j.derived_from_job_id OR EXISTS (
          SELECT 1 FROM public.job_stage_reuse previous WHERE previous.job_id = j.derived_from_job_id
            AND previous.stage = x ->> 'stage' AND previous.import_job_id = i.job_id
        ))
    ) THEN
      PERFORM public.catalog_raise('SAC04', 'import reuse requires the original accepted import seal');
    END IF;
    INSERT INTO public.job_stage_reuse
      (job_id, stage, source_job_id, execution_job_id, import_job_id, imported_counts,
       state, fingerprint_sha256, receipt_sha256, error_code)
    VALUES (p_job, x ->> 'stage', j.derived_from_job_id, (x ->> 'executionJobId')::uuid,
            (x ->> 'importJobId')::uuid, nullif(x -> 'importedCounts', 'null'::jsonb),
            x ->> 'state', x ->> 'fingerprintSha256', x ->> 'receiptSha256', x ->> 'errorCode')
    ON CONFLICT (job_id, stage) DO NOTHING;
    FOR f IN SELECT value FROM jsonb_array_elements(x -> 'files') LOOP
      IF EXISTS (SELECT 1 FROM public.job_rerun_copies WHERE job_id = p_job AND slot = f ->> 'slot') THEN
        CONTINUE;
      END IF;
      SELECT sf.* INTO src FROM public.files sf
      JOIN public.job_output_slots s ON s.file_id = sf.id AND s.job_id = sf.job_id
      LEFT JOIN public.job_rerun_copies prev ON prev.file_id = sf.id
      WHERE sf.id = (f ->> 'fileId')::uuid AND sf.job_id = j.derived_from_job_id
        AND sf.recording_id = j.recording_id AND sf.purpose = 'output'
        AND sf.state IN ('completed', 'verified') AND sf.role = f ->> 'role'
        AND sf.size_bytes = (f ->> 'sizeBytes')::bigint AND sf.sha256 = f ->> 'sha256'
        AND s.slot = f ->> 'slot'
        AND coalesce(prev.original_job_id, sf.job_id) = (f ->> 'originalJobId')::uuid
        AND coalesce(prev.original_file_id, sf.id) = (f ->> 'originalFileId')::uuid;
      IF NOT FOUND THEN PERFORM public.catalog_raise('SAC04', 'confirmed reuse file no longer matches'); END IF;

      child_id := gen_random_uuid();
      digest := p ->> 'sourceManifestSha256';
      INSERT INTO public.job_rerun_copies
        (job_id, stage, source_file_id, source_job_id, original_file_id, original_job_id,
         file_id, slot, role, size_bytes, sha256)
      VALUES (p_job, x ->> 'stage', src.id, src.job_id,
              (f ->> 'originalFileId')::uuid, (f ->> 'originalJobId')::uuid,
              child_id, f ->> 'slot', src.role, src.size_bytes, src.sha256);
      INSERT INTO public.files
        (id, recording_id, job_id, purpose, role, required, size_bytes, sha256,
         object_key, part_size_bytes, part_count)
      VALUES (child_id, j.recording_id, p_job, 'output', src.role, src.required, src.size_bytes, src.sha256,
              'jobs/' || p_job || '/outputs/' || child_id || '/e1/' || (f ->> 'slot'), src.size_bytes, 1);
      INSERT INTO public.job_output_slots (job_id, slot, file_id, request_digest)
      VALUES (p_job, f ->> 'slot', child_id, digest);
    END LOOP;
  END LOOP;
  RETURN true;
END $$;

CREATE FUNCTION public.job_rerun_copy_progress(
  p_job uuid, p_owner text, p_file uuid, p_revision integer, p_source_checked boolean,
  p_upload_id text, p_part_tags text[], p_target_ready boolean
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.jobs WHERE id = p_job FOR UPDATE;
  IF NOT public.job_rerun_preparation_ok(p_job, p_owner) THEN
    PERFORM public.catalog_raise('SAC04', 'rerun preparation needs a current controller lease');
  END IF;
  UPDATE public.job_rerun_copies c SET copy_revision = copy_revision + 1,
    source_checked = p_source_checked, provider_upload_id = p_upload_id,
    provider_part_tags = p_part_tags, target_ready = p_target_ready
  WHERE c.job_id = p_job AND c.file_id = p_file AND c.copy_revision = p_revision
    AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = c.file_id AND f.state = 'reserved');
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.job_rerun_copy_progress(uuid, text, uuid, integer, boolean, text, text[], boolean) FROM PUBLIC;

CREATE FUNCTION public.job_rerun_complete_copy(p_job uuid, p_owner text, p_file uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.jobs WHERE id = p_job FOR UPDATE;
  IF NOT public.job_rerun_preparation_ok(p_job, p_owner) THEN
    PERFORM public.catalog_raise('SAC04', 'rerun preparation needs a current controller lease');
  END IF;
  UPDATE public.files f SET state = 'completed', observed_size_bytes = f.size_bytes, completed_at = now()
  WHERE f.id = p_file AND f.job_id = p_job AND f.state = 'reserved'
    AND EXISTS (SELECT 1 FROM public.job_rerun_copies c WHERE c.job_id = p_job AND c.file_id = p_file AND c.target_ready);
  RETURN FOUND OR EXISTS (
    SELECT 1 FROM public.job_rerun_copies c JOIN public.files f ON f.id = c.file_id
    WHERE c.job_id = p_job AND c.file_id = p_file AND f.state = 'completed'
  );
END $$;

CREATE FUNCTION public.job_rerun_claim_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p jsonb;
  backend text;
  approval_expires_at timestamptz;
BEGIN
  SELECT r.plan, j.execution_backend INTO p, backend FROM public.jobs j LEFT JOIN public.job_rerun_plans r ON r.job_id = j.id
    WHERE j.id = NEW.job_id AND j.derived_from_job_id IS NOT NULL;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF p IS NULL OR NOT (p -> 'execute') ? NEW.stage
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p -> 'reuse') AS x(value)
       WHERE NOT EXISTS (
         SELECT 1 FROM public.job_stage_reuse r
         WHERE r.job_id = NEW.job_id AND r.stage = x.value ->> 'stage'
       )
     )
     OR EXISTS (
       SELECT 1 FROM public.job_rerun_copies c JOIN public.files f ON f.id = c.file_id
       WHERE c.job_id = NEW.job_id AND f.state <> 'completed'
     ) THEN
    PERFORM public.catalog_raise('SAC04', 'stage claim requires completed selective preparation and an executed stage');
  END IF;
  IF backend = 'modal' THEN
    SELECT a.expires_at INTO approval_expires_at
      FROM public.rerun_spend_reservations r
      JOIN public.rerun_spend_authorizations a ON a.id = r.authorization_id
      JOIN public.jobs j ON j.id = r.job_id
      WHERE r.job_id = NEW.job_id AND a.expires_at > clock_timestamp()
        AND (a.recording_id IS NULL OR a.recording_id = j.recording_id)
        AND a.environment = p #>> ARRAY['bindings', NEW.stage, 'environment']
        AND r.compute_cents = (p ->> 'maxComputeCostUsd')::numeric * 100
        AND r.gpu_cents = (p ->> 'maxGpuCostUsd')::numeric * 100
      FOR SHARE OF a;
    IF NOT FOUND THEN
      PERFORM public.catalog_raise('SAC04', 'hosted stage claim requires current compute authorization');
    END IF;
    NEW.start_deadline := LEAST(NEW.start_deadline, approval_expires_at);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_rerun_claim_guard BEFORE INSERT ON public.job_stage_claims
  FOR EACH ROW EXECUTE FUNCTION public.job_rerun_claim_guard();

REVOKE ALL ON FUNCTION public.job_rerun_reserve_copies(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.job_rerun_complete_copy(uuid, text, uuid) FROM PUBLIC;

CREATE FUNCTION public.job_rerun_stage_run_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.jobs j LEFT JOIN public.job_rerun_plans p ON p.job_id = j.id
    WHERE j.id = NEW.job_id AND j.derived_from_job_id IS NOT NULL
      AND NOT coalesce((p.plan -> 'execute') ? NEW.stage, false)
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'a derived job records physical runs only for selected stages');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_rerun_stage_run_guard BEFORE INSERT ON public.job_stage_runs
  FOR EACH ROW EXECUTE FUNCTION public.job_rerun_stage_run_guard();

CREATE VIEW public.job_effective_stage_runs AS
  SELECT job_id, stage, state, error_code, counts, receipt_sha256,
         NULL::uuid AS source_job_id, NULL::uuid AS execution_job_id
  FROM public.job_stage_runs
  UNION ALL
  SELECT x.job_id, x.stage, x.state, x.error_code, coalesce(r.counts, x.imported_counts, '{}'::jsonb), x.receipt_sha256,
         x.source_job_id, x.execution_job_id
  FROM public.job_stage_reuse x
  LEFT JOIN public.job_stage_runs r ON r.job_id = x.execution_job_id AND r.stage = x.stage;

CREATE OR REPLACE FUNCTION public.job_stage_prior_settled(p_job uuid, p_recipe jsonb, p_stage text)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY['segment', 'caption']) s(stage)
    WHERE (p_stage = 'caption' AND s.stage = 'segment'
           OR p_stage = 'hand_pose' AND NOT (SELECT recipe_parallel FROM public.jobs WHERE id = p_job))
      AND coalesce((public.job_recipe_stage(p_recipe, s.stage) ->> 'enabled')::boolean, false)
      AND NOT EXISTS (SELECT 1 FROM public.job_effective_stage_runs r
                      WHERE r.job_id = p_job AND r.stage = s.stage AND public.job_stage_terminal(r.state)))
$$;

CREATE OR REPLACE FUNCTION public.job_recipe_stages_settled(p_job uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT count(*) = 3 FROM public.job_effective_stage_runs
    WHERE job_id = p_job AND public.job_stage_terminal(state)
$$;

CREATE TABLE public.rerun_spend_authorizations (
  id uuid PRIMARY KEY,
  environment text NOT NULL CHECK (length(environment) BETWEEN 1 AND 100),
  approval text NOT NULL CHECK (length(approval) BETWEEN 1 AND 512),
  recording_id uuid REFERENCES public.recordings (id),
  max_compute_cents bigint NOT NULL CHECK (max_compute_cents BETWEEN 1 AND 99999999),
  max_gpu_cents bigint NOT NULL CHECK (max_gpu_cents BETWEEN 0 AND max_compute_cents),
  expires_at timestamptz NOT NULL
);

CREATE TABLE public.rerun_spend_reservations (
  job_id uuid PRIMARY KEY REFERENCES public.jobs (id),
  authorization_id uuid NOT NULL REFERENCES public.rerun_spend_authorizations (id),
  compute_cents bigint NOT NULL CHECK (compute_cents BETWEEN 1 AND 99999999),
  gpu_cents bigint NOT NULL CHECK (gpu_cents BETWEEN 0 AND compute_cents),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER rerun_spend_reservation_immutable BEFORE UPDATE OR DELETE ON public.rerun_spend_reservations
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER rerun_spend_reservation_no_truncate BEFORE TRUNCATE ON public.rerun_spend_reservations
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

CREATE FUNCTION public.job_rerun_available_spend(p_environment text, p_recording uuid,
  p_gpu_cents bigint, p_compute_cents bigint)
RETURNS TABLE (authorization_id uuid)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT a.id FROM public.rerun_spend_authorizations a
  LEFT JOIN LATERAL (
    SELECT sum(r.gpu_cents) AS gpu, sum(r.compute_cents) AS compute
    FROM public.rerun_spend_reservations r JOIN public.jobs j ON j.id = r.job_id
    WHERE r.authorization_id = a.id AND (j.submission_intent_at IS NOT NULL OR
      j.state NOT IN ('succeeded', 'failed', 'cancelled'))
  ) reserved ON true
  WHERE a.environment = p_environment AND a.expires_at > clock_timestamp()
    AND (a.recording_id IS NULL OR a.recording_id = p_recording)
    AND a.max_gpu_cents - coalesce(reserved.gpu, 0) >= p_gpu_cents
    AND a.max_compute_cents - coalesce(reserved.compute, 0) >= p_compute_cents
$$;

CREATE FUNCTION public.job_rerun_reserve_spend(p_job uuid, p_environment text,
  p_gpu_cents bigint, p_compute_cents bigint)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a public.rerun_spend_authorizations;
        recording uuid;
BEGIN
  IF p_compute_cents NOT BETWEEN 1 AND 99999999 OR p_gpu_cents NOT BETWEEN 0 AND p_compute_cents THEN
    RETURN false;
  END IF;
  SELECT j.recording_id INTO recording
    FROM public.jobs j JOIN public.job_rerun_plans p ON p.job_id = j.id
    WHERE j.id = p_job AND j.derived_from_job_id IS NOT NULL AND j.state = 'queued'
      AND public.catalog_has_role(p.actor_id, 'staff')
      AND ((p.plan ->> 'maxGpuCostUsd')::numeric * 100) = p_gpu_cents
      AND ((p.plan ->> 'maxComputeCostUsd')::numeric * 100) = p_compute_cents;
  IF NOT FOUND THEN RETURN false; END IF;
  FOR a IN SELECT * FROM public.rerun_spend_authorizations
    WHERE environment = p_environment AND expires_at > clock_timestamp()
      AND (recording_id IS NULL OR recording_id = recording)
    ORDER BY expires_at, id FOR UPDATE
  LOOP
    IF EXISTS (
      SELECT 1
      FROM public.job_rerun_available_spend(p_environment, recording, p_gpu_cents, p_compute_cents) available
      WHERE available.authorization_id = a.id
    ) THEN
      INSERT INTO public.rerun_spend_reservations (job_id, authorization_id, gpu_cents, compute_cents)
      VALUES (p_job, a.id, p_gpu_cents, p_compute_cents);
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.job_rerun_reserve_spend(uuid, text, bigint, bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.job_seal_nonce(p_job uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN j.recipe IS NULL THEN j.invocation_nonce
         ELSE coalesce(
           (SELECT c.invocation_nonce FROM public.job_stage_claims c
            WHERE c.job_id = j.id AND c.stage = 'hand_pose'),
           (SELECT c.invocation_nonce FROM public.job_stage_claims c
            JOIN public.job_stage_evidence e ON e.job_id = c.job_id AND e.stage = c.stage
            WHERE c.job_id = j.id AND c.call_id = e.execution_ref AND j.derived_from_job_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM public.job_stage_reuse r WHERE r.job_id = j.id
                AND r.stage = 'hand_pose' AND r.state = 'succeeded')
              AND public.job_recipe_stages_settled(j.id)
            ORDER BY public.job_stage_ord(c.stage) DESC LIMIT 1)
         ) END
  FROM public.jobs j WHERE j.id = p_job
$$;

CREATE FUNCTION public.stateaction_grant_stage_rerun_reads(reader_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('GRANT SELECT ON public.job_effective_stage_runs,
    public.recording_result_selections, public.job_rerun_plans, public.job_stage_reuse,
    public.job_rerun_copies TO %I', reader_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_stage_rerun_reads(name) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stateaction_dev_reader') THEN
    PERFORM public.stateaction_grant_stage_rerun_reads('stateaction_dev_reader');
  END IF;
END $$;

CREATE FUNCTION public.stateaction_grant_stage_reruns(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.stateaction_grant_stage_rerun_reads(app_role);
  EXECUTE format('GRANT INSERT ON public.job_rerun_plans,
    public.recording_result_selections TO %I', app_role);
  EXECUTE format('GRANT SELECT ON public.cached_processing_imports,
    public.rerun_spend_authorizations, public.rerun_spend_reservations TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.job_rerun_reserve_copies(uuid, text),
    public.job_rerun_complete_copy(uuid, text, uuid),
    public.job_rerun_copy_progress(uuid, text, uuid, integer, boolean, text, text[], boolean),
    public.job_rerun_reserve_spend(uuid, text, bigint, bigint) TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_stage_reruns(name) FROM PUBLIC;
