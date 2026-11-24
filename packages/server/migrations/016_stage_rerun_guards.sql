-- The applied 015 bytes remain unchanged. Verify confirmed lineage in the
-- catalog before the existing operation can reserve any child output files.
CREATE FUNCTION public.job_stage_reuse_origin_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.import_job_id IS NOT NULL OR NOT (
    EXISTS (
      SELECT 1 FROM public.job_stage_runs origin
      WHERE origin.job_id = NEW.source_job_id AND origin.stage = NEW.stage
        AND NEW.execution_job_id = origin.job_id
        AND (NEW.state, NEW.receipt_sha256, NEW.error_code)
          IS NOT DISTINCT FROM (origin.state, origin.receipt_sha256, origin.error_code)
    ) OR EXISTS (
      SELECT 1 FROM public.job_stage_reuse origin
      WHERE origin.job_id = NEW.source_job_id AND origin.stage = NEW.stage
        AND origin.import_job_id IS NULL
        AND (NEW.execution_job_id, NEW.state, NEW.receipt_sha256, NEW.error_code, NEW.fingerprint_sha256)
          IS NOT DISTINCT FROM
          (origin.execution_job_id, origin.state, origin.receipt_sha256, origin.error_code, origin.fingerprint_sha256)
    ) OR (
      NEW.state = 'not_run' AND NEW.execution_job_id IS NULL AND NEW.receipt_sha256 IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.job_effective_stage_runs origin
        WHERE origin.job_id = NEW.source_job_id AND origin.stage = NEW.stage
      )
    )
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'rerun evidence differs from the original stage');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_stage_reuse_origin_guard BEFORE INSERT ON public.job_stage_reuse
  FOR EACH ROW EXECUTE FUNCTION public.job_stage_reuse_origin_guard();

CREATE FUNCTION public.job_rerun_copy_slot_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.stage <> (CASE
      WHEN NEW.slot = 'segments.json' THEN 'segment'
      WHEN NEW.slot = 'captions.json' THEN 'caption'
      WHEN NEW.slot LIKE 'diagnostics/%' THEN split_part(NEW.slot, '/', 2)
      ELSE 'hand_pose'
    END)
    OR NOT EXISTS (
      SELECT 1 FROM public.job_stage_reuse r
      WHERE r.job_id = NEW.job_id AND r.stage = NEW.stage AND r.state = 'succeeded'
    ) THEN
    PERFORM public.catalog_raise('SAC04', 'rerun copy requires a successful origin and its stage slot');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_rerun_copy_slot_guard BEFORE INSERT ON public.job_rerun_copies
  FOR EACH ROW EXECUTE FUNCTION public.job_rerun_copy_slot_guard();

-- Owner-only accounting for attributable provider metering, rounded up in
-- cents. Until it exists a submitted job retains the entire reservation.
CREATE TABLE public.rerun_spend_reconciliations (
  job_id uuid PRIMARY KEY REFERENCES public.rerun_spend_reservations (job_id),
  compute_cents bigint NOT NULL CHECK (compute_cents BETWEEN 0 AND 99999999),
  gpu_cents bigint NOT NULL CHECK (gpu_cents BETWEEN 0 AND compute_cents),
  metering_reference text NOT NULL CHECK (length(btrim(metering_reference)) BETWEEN 1 AND 512),
  recorded_by name NOT NULL DEFAULT current_user,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER rerun_spend_reconciliation_immutable BEFORE UPDATE OR DELETE ON public.rerun_spend_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER rerun_spend_reconciliation_no_truncate BEFORE TRUNCATE ON public.rerun_spend_reconciliations
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

CREATE FUNCTION public.rerun_spend_reconciliation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.rerun_spend_authorizations a
  JOIN public.rerun_spend_reservations r ON r.authorization_id = a.id
  WHERE r.job_id = NEW.job_id FOR UPDATE OF a;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.jobs j JOIN public.job_execution_evidence e ON e.job_id = j.id
    WHERE j.id = NEW.job_id AND j.state IN ('succeeded', 'failed', 'cancelled')
      AND e.kind = 'provider_call_terminal'
      AND NOT EXISTS (SELECT 1 FROM public.dispatch_admission a WHERE a.job_id = j.id)
  ) OR EXISTS (
    SELECT 1 FROM public.job_stage_claims c
    WHERE c.job_id = NEW.job_id AND NOT EXISTS (
      SELECT 1 FROM public.job_stage_evidence e WHERE e.job_id = c.job_id AND e.stage = c.stage
        AND e.kind = 'provider_call_terminal'
        AND e.execution_ref = public.job_stage_call(c.job_id, c.stage)
    )
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'spend reconciliation needs exact terminal provider evidence');
  END IF;
  NEW.recorded_by := current_user;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER rerun_spend_reconciliation_guard BEFORE INSERT ON public.rerun_spend_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.rerun_spend_reconciliation_guard();

CREATE FUNCTION public.job_rerun_used_spend(p_authorization uuid)
RETURNS TABLE (gpu_cents numeric, compute_cents numeric)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(sum(coalesce(m.gpu_cents, r.gpu_cents)), 0),
         coalesce(sum(coalesce(m.compute_cents, r.compute_cents)), 0)
  FROM public.rerun_spend_reservations r
  JOIN public.jobs j ON j.id = r.job_id
  LEFT JOIN public.rerun_spend_reconciliations m ON m.job_id = r.job_id
  WHERE r.authorization_id = p_authorization AND (j.submission_intent_at IS NOT NULL OR
    j.state NOT IN ('succeeded', 'failed', 'cancelled'))
$$;

CREATE OR REPLACE FUNCTION public.job_rerun_available_spend(p_environment text, p_recording uuid,
  p_gpu_cents bigint, p_compute_cents bigint)
RETURNS TABLE (authorization_id uuid)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT a.id FROM public.rerun_spend_authorizations a
  CROSS JOIN LATERAL public.job_rerun_used_spend(a.id) reserved
  WHERE a.environment = p_environment AND a.expires_at > clock_timestamp()
    AND (a.recording_id IS NULL OR a.recording_id = p_recording)
    AND a.max_gpu_cents - reserved.gpu_cents >= p_gpu_cents
    AND a.max_compute_cents - reserved.compute_cents >= p_compute_cents
$$;

CREATE OR REPLACE FUNCTION public.job_rerun_claim_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p jsonb;
  backend text;
  approval public.rerun_spend_authorizations;
  used record;
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
    SELECT a.* INTO approval
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
    -- Lock the award before reading the total so cap reductions, reservations
    -- and owner reconciliation serialize with claim issuance.
    SELECT * INTO used FROM public.job_rerun_used_spend(approval.id);
    IF used.gpu_cents > approval.max_gpu_cents OR used.compute_cents > approval.max_compute_cents THEN
      PERFORM public.catalog_raise('SAC04', 'hosted stage claim exceeds the current authorization cap');
    END IF;
    NEW.start_deadline := LEAST(NEW.start_deadline, approval.expires_at);
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.job_stage_issue_claim(
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
  VALUES (p_job, p_stage, p_owner, p_bootstrap_sha256, v_start)
  RETURNING job_stage_claims.start_deadline INTO v_start;
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

CREATE OR REPLACE FUNCTION public.stateaction_grant_stage_reruns(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.stateaction_grant_stage_rerun_reads(app_role);
  EXECUTE format('GRANT INSERT ON public.job_rerun_plans,
    public.recording_result_selections TO %I', app_role);
  EXECUTE format('GRANT SELECT ON public.cached_processing_imports,
    public.rerun_spend_authorizations, public.rerun_spend_reservations,
    public.rerun_spend_reconciliations TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.job_rerun_reserve_copies(uuid, text),
    public.job_rerun_complete_copy(uuid, text, uuid),
    public.job_rerun_copy_progress(uuid, text, uuid, integer, boolean, text, text[], boolean),
    public.job_rerun_reserve_spend(uuid, text, bigint, bigint) TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_stage_reruns(name) FROM PUBLIC;

CREATE FUNCTION public.job_rerun_receipt_binding_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  binding jsonb;
  evidence jsonb;
  identity_keys constant text[] := ARRAY[
    'appName', 'codeRevision', 'environment', 'functionId', 'definitionId',
    'paramsSha256', 'definitionSha256'
  ];
BEGIN
  IF NEW.receipt IS NULL THEN RETURN NEW; END IF;
  SELECT p.plan #> ARRAY['bindings', NEW.stage] INTO binding
  FROM public.jobs j JOIN public.job_rerun_plans p ON p.job_id = j.id
  WHERE j.id = NEW.job_id AND j.execution_backend = 'modal';
  IF NOT FOUND THEN RETURN NEW; END IF;
  evidence := NEW.receipt -> 'providerBinding';
  IF NEW.receipt ->> 'schemaVersion' IS DISTINCT FROM '2'
     OR evidence IS NULL OR binding IS NULL
     OR EXISTS (
        SELECT 1 FROM unnest(identity_keys) AS k
        WHERE binding ->> k IS NULL OR (evidence ->> k) IS DISTINCT FROM (binding ->> k)
     ) THEN
    PERFORM public.catalog_raise('SAC04', 'hosted rerun receipt needs its confirmed deployment evidence');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_rerun_receipt_binding_guard BEFORE INSERT OR UPDATE OF receipt ON public.job_stage_runs
  FOR EACH ROW EXECUTE FUNCTION public.job_rerun_receipt_binding_guard();
