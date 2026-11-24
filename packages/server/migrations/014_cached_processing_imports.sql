-- Cached imports have no admission, worker claim, invocation or provider receipt.
-- The restricted application role can read completed imports but cannot create them.
ALTER TABLE public.jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_kind_check
  CHECK (kind IN ('process_recording', 'cached_import'));
ALTER TABLE public.jobs DROP CONSTRAINT jobs_admission_complete;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_admission_complete CHECK (
  (kind = 'cached_import' AND state IN ('queued', 'result_pending', 'succeeded'))
  OR (kind = 'process_recording' AND (
    state = 'queued'
    OR (state = 'cancelled' AND admitted_at IS NULL)
    OR (admitted_at IS NOT NULL AND dispatch_key IS NOT NULL AND execution_backend IS NOT NULL
        AND execution_deadline IS NOT NULL)))) NOT VALID;

ALTER TABLE public.recordings ADD COLUMN imported_from_cache boolean NOT NULL DEFAULT false;
ALTER TABLE public.jobs DROP CONSTRAINT jobs_annotation_counts_accepted;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_annotation_counts_accepted CHECK (
  segment_count IS NULL OR (state = 'succeeded' AND (recipe IS NOT NULL OR kind = 'cached_import')));

CREATE FUNCTION public.cached_import_recording_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.imported_from_cache IS DISTINCT FROM OLD.imported_from_cache THEN
    PERFORM public.catalog_raise('SAC01', 'an existing recording cannot be marked as an import');
  END IF;
  IF TG_OP = 'INSERT' AND NEW.imported_from_cache AND (
      current_user <> pg_get_userbyid((SELECT relowner FROM pg_class
                                      WHERE oid = 'public.recordings'::regclass))
      OR NEW.owner_user_id <> 'stateaction-cached-import-source'
      OR NEW.rgb_profile <> 'h264_mcap_simulation_v1'
      OR NEW.client_recording_id <> NEW.id) THEN
    PERFORM public.catalog_raise('SAC05', 'only the catalog owner may register a dedicated cached import');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cached_import_recording_guard BEFORE INSERT OR UPDATE ON public.recordings
  FOR EACH ROW EXECUTE FUNCTION public.cached_import_recording_guard();

CREATE TABLE public.cached_processing_imports (
  job_id uuid PRIMARY KEY REFERENCES public.jobs (id),
  manifest_file_id uuid NOT NULL,
  manifest_sha256 public.sha256_hex NOT NULL,
  inventory_sha256 public.sha256_hex NOT NULL,
  clip_count integer NOT NULL CHECK (clip_count BETWEEN 1 AND 999),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'
    AND evidence ->> 'source' = 'imported' AND octet_length(evidence::text) <= 65536),
  imported_by text NOT NULL REFERENCES public."user" (id),
  imported_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (manifest_file_id, job_id, manifest_sha256)
    REFERENCES public.files (id, job_id, sha256)
);

CREATE TRIGGER cached_processing_imports_immutable BEFORE UPDATE OR DELETE
  ON public.cached_processing_imports FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();

-- Keep both live job triggers and their bodies intact for ordinary executions.
DROP TRIGGER jobs_orchestration_guard ON public.jobs;
CREATE TRIGGER jobs_orchestration_guard BEFORE UPDATE ON public.jobs
  FOR EACH ROW WHEN (OLD.kind = 'process_recording')
  EXECUTE FUNCTION public.jobs_orchestration_guard();
DROP TRIGGER jobs_acceptance_guard ON public.jobs;
CREATE TRIGGER jobs_acceptance_guard BEFORE UPDATE ON public.jobs
  FOR EACH ROW WHEN (OLD.kind = 'process_recording')
  EXECUTE FUNCTION public.jobs_acceptance_guard();

CREATE FUNCTION public.cached_import_job_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  seal public.cached_processing_imports;
BEGIN
  IF current_user <> pg_get_userbyid((SELECT relowner FROM pg_class
                                     WHERE oid = 'public.jobs'::regclass)) THEN
    PERFORM public.catalog_raise('SAC05', 'only the catalog owner may create an import');
  END IF;
  IF NEW.recipe IS NOT NULL OR NEW.previous_job_id IS NOT NULL
     OR NEW.execution_backend IS NOT NULL OR NEW.admitted_at IS NOT NULL
     OR NEW.dispatch_key IS NOT NULL OR NEW.workflow_run_ref IS NOT NULL
     OR NEW.submission_intent_at IS NOT NULL OR NEW.claimed_at IS NOT NULL
     OR NEW.execution_call_id IS NOT NULL OR NEW.invocation_nonce IS NOT NULL
     OR NEW.capability_token_sha256 IS NOT NULL OR NEW.execution_deadline IS NOT NULL
     OR NEW.controller_lease_owner IS NOT NULL THEN
    PERFORM public.catalog_raise('SAC04', 'a cached import cannot carry live execution identity');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM public.recordings r
                   WHERE r.id = NEW.recording_id AND r.imported_from_cache AND r.current_job_id IS NULL)
       OR EXISTS (SELECT 1 FROM public.recording_registrations WHERE recording_id = NEW.recording_id)
       OR EXISTS (SELECT 1 FROM public.recording_admissions WHERE recording_id = NEW.recording_id)
       OR EXISTS (SELECT 1 FROM public.jobs WHERE recording_id = NEW.recording_id) THEN
      PERFORM public.catalog_raise('SAC04', 'the import needs its own dedicated recording');
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state = 'queued' AND NEW.state = 'result_pending' THEN RETURN NEW; END IF;
  IF OLD.state IS DISTINCT FROM 'result_pending' OR NEW.state IS DISTINCT FROM 'succeeded' THEN
    PERFORM public.catalog_raise('SAC04', 'invalid cached import state transition');
  END IF;
  SELECT * INTO seal FROM public.cached_processing_imports WHERE job_id = NEW.id;
  IF seal.job_id IS NULL
     OR NOT public.catalog_has_role(seal.imported_by, 'staff')
     OR seal.manifest_file_id IS DISTINCT FROM NEW.result_manifest_file_id
     OR seal.manifest_sha256 IS DISTINCT FROM NEW.result_manifest_sha256
     OR seal.inventory_sha256 IS DISTINCT FROM public.job_output_inventory_digest(NEW.id)
     OR seal.clip_count <> (SELECT count(*) FROM public.clips WHERE job_id = NEW.id)
     OR (NEW.segment_count, NEW.failed_window_count, NEW.caption_count, NEW.caption_failed_count)
       IS DISTINCT FROM ((seal.evidence -> 'counts' ->> 'segments')::integer,
                         (seal.evidence -> 'counts' ->> 'failedWindows')::integer,
                         (seal.evidence -> 'counts' ->> 'captions')::integer,
                         (seal.evidence -> 'counts' ->> 'failedCaptions')::integer)
     OR NOT EXISTS (SELECT 1 FROM public.recordings r WHERE r.id = NEW.recording_id
                   AND r.current_job_id = NEW.id AND r.deleted_at IS NULL AND r.status = 'processing')
     OR EXISTS (
       SELECT 1 FROM public.files f LEFT JOIN public.job_output_slots s
         ON s.job_id = f.job_id AND s.file_id = f.id
       WHERE f.job_id = NEW.id AND (f.state <> 'verified' OR s.slot IS NULL
         OR NOT public.job_output_slot_role_ok(s.slot, f.role))
     ) THEN
    PERFORM public.catalog_raise('SAC04', 'cached import needs its verified inventory, clips and staff seal');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cached_import_job_guard BEFORE INSERT OR UPDATE ON public.jobs
  FOR EACH ROW WHEN (NEW.kind = 'cached_import') EXECUTE FUNCTION public.cached_import_job_guard();

-- No slot can be reserved after the import becomes visible.
CREATE FUNCTION public.cached_import_slot_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.jobs WHERE id = NEW.job_id
             AND kind = 'cached_import' AND state <> 'result_pending') THEN
    PERFORM public.catalog_raise('SAC04', 'cached import inventory is closed');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cached_import_slot_guard BEFORE INSERT OR UPDATE ON public.job_output_slots
  FOR EACH ROW EXECUTE FUNCTION public.cached_import_slot_guard();

-- Admission requires a job_inputs row. Forbid such a row even while an
-- operator's transaction is assembling an imported job.
CREATE FUNCTION public.cached_import_live_input_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.jobs WHERE id = NEW.job_id AND kind = 'cached_import') THEN
    PERFORM public.catalog_raise('SAC04', 'cached imports have no dispatch inputs');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cached_import_live_input_guard BEFORE INSERT ON public.job_inputs
  FOR EACH ROW EXECUTE FUNCTION public.cached_import_live_input_guard();

REVOKE ALL ON public.cached_processing_imports FROM PUBLIC;

CREATE FUNCTION public.stateaction_grant_cached_imports(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.cached_processing_imports FROM %I', app_role);
  EXECUTE format('GRANT SELECT ON TABLE public.cached_processing_imports TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_cached_imports(name) FROM PUBLIC;
