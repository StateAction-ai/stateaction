-- SA-25 durable job admission, controller leases and worker claims.
-- Additive only: 001-006 are unchanged. Every function pins
-- search_path = pg_catalog, public, pg_temp and schema-qualifies relations.
--
-- Invariants enforced by the database (not only by application code):
--   * ONE global admission slot (dispatch_admission). Every execution kind
--     (processing now, export later) is serialized through it, so at most one
--     execution is admitted at a time and further queued jobs hold no
--     controller or compute.
--   * The slot is released ONLY when BOTH the job's business state is terminal
--     (succeeded/failed/cancelled) AND authoritative execution evidence is
--     persisted (job_execution_evidence): a reaped local child, a terminal
--     exact provider call, or a definite pre-submission rejection of a job
--     with no submission intent. Whichever arrives last releases it. A terminal
--     state alone, evidence alone, an expired lease or deadline, a missing
--     heartbeat or an unknown submission never frees it.
--   * Permanent input identity (job_inputs) and absolute deadlines are
--     written once at admission, before any external effect.
--   * Worker claim identity (invocation nonce, execution call ID) is
--     write-once, so a replayed or duplicate physical worker cannot claim.
-- Lock order (extends docs/components/catalog.md): recording row, then job
-- row; the slot row is taken only by admission (before candidate job rows
-- with SKIP LOCKED, never waiting on a job row) and by the release statement.
-- SQLSTATE classes reused from 003: SAC01 immutable, SAC04 lifecycle,
-- SAC05 not authorized.

ALTER TABLE public.jobs
  ADD COLUMN execution_backend text CHECK (execution_backend IN ('local', 'modal')),
  ADD COLUMN admitted_at timestamptz,
  ADD COLUMN dispatch_key text UNIQUE,
  ADD COLUMN submission_intent_owner text CHECK (length(submission_intent_owner) BETWEEN 1 AND 200),
  ADD COLUMN bootstrap_token_sha256 public.sha256_hex,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN last_heartbeat_at timestamptz,
  ADD COLUMN heartbeat_phase text CHECK (heartbeat_phase IN (
    'hashing_source', 'decoding', 'inference', 'writing_outputs', 'uploading', 'sealing')),
  ADD COLUMN processed_frames bigint CHECK (processed_frames >= 0),
  ADD COLUMN total_frames bigint CHECK (total_frames >= 0),
  ADD COLUMN unknown_at timestamptz,
  ADD CONSTRAINT jobs_dispatch_key_fixed CHECK (dispatch_key IS NULL OR dispatch_key = 'job:' || id::text),
  ADD CONSTRAINT jobs_admission_complete CHECK (
    state = 'queued'
    OR (state = 'cancelled' AND admitted_at IS NULL)
    OR (admitted_at IS NOT NULL AND dispatch_key IS NOT NULL AND execution_backend IS NOT NULL
        AND execution_deadline IS NOT NULL)) NOT VALID,
  ADD CONSTRAINT jobs_claim_complete CHECK (
    (claimed_at IS NULL) = (invocation_nonce IS NULL)
    AND (claimed_at IS NULL OR (execution_call_id IS NOT NULL AND capability_token_sha256 IS NOT NULL))) NOT VALID,
  ADD CONSTRAINT jobs_intent_complete CHECK (
    (submission_intent_at IS NULL) = (submission_intent_owner IS NULL)
    AND (submission_intent_at IS NULL OR (bootstrap_token_sha256 IS NOT NULL AND start_deadline IS NOT NULL))),
  ADD CONSTRAINT jobs_deadline_order CHECK (start_deadline IS NULL OR execution_deadline IS NULL
    OR start_deadline <= execution_deadline);
CREATE UNIQUE INDEX jobs_bootstrap_token_idx ON public.jobs (bootstrap_token_sha256)
  WHERE bootstrap_token_sha256 IS NOT NULL;
CREATE UNIQUE INDEX jobs_capability_token_idx ON public.jobs (capability_token_sha256)
  WHERE capability_token_sha256 IS NOT NULL;
CREATE INDEX jobs_queue_idx ON public.jobs (created_at, id) WHERE state = 'queued';
CREATE INDEX jobs_undelivered_dispatch_idx ON public.jobs (admitted_at)
  WHERE state = 'submitting' AND workflow_run_ref IS NULL;

-- 1. job_inputs: the permanent, secret-free identity of what one job runs on.
-- Written in the admission transaction, before the slot is taken and before
-- any external effect; immutable.
CREATE TABLE public.job_inputs (
  job_id uuid PRIMARY KEY REFERENCES public.jobs (id),
  source_manifest_sha256 public.sha256_hex NOT NULL,
  profile_revision text NOT NULL CHECK (length(profile_revision) BETWEEN 1 AND 128),
  execution_backend text NOT NULL CHECK (execution_backend IN ('local', 'modal')),
  code_revision text NOT NULL CHECK (length(code_revision) BETWEEN 1 AND 128),
  image_spec_sha256 public.sha256_hex NOT NULL,
  model_sha256 public.sha256_hex NOT NULL,
  config_sha256 public.sha256_hex NOT NULL,
  max_output_files integer NOT NULL CHECK (max_output_files BETWEEN 1 AND 2000),
  max_output_bytes bigint NOT NULL CHECK (max_output_bytes BETWEEN 1 AND 107374182400),
  max_control_document_bytes integer NOT NULL CHECK (max_control_document_bytes BETWEEN 1 AND 1048576),
  -- Canonical task-input document (jobs.task-input) and its sa-cjson-v1 digest.
  task_input jsonb NOT NULL CHECK (jsonb_typeof(task_input) = 'object' AND octet_length(task_input::text) <= 4096),
  task_input_sha256 public.sha256_hex NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER job_inputs_immutable BEFORE UPDATE OR DELETE ON public.job_inputs
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();

-- 2. dispatch_admission: the single global admission slot.
CREATE TABLE public.dispatch_admission (
  slot smallint PRIMARY KEY CHECK (slot = 1),
  job_id uuid UNIQUE REFERENCES public.jobs (id),
  admitted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((job_id IS NULL) = (admitted_at IS NULL))
);
INSERT INTO public.dispatch_admission (slot) VALUES (1);

-- 3. job_execution_evidence: authoritative proof that the exact physical
-- execution is over (or never happened). Only this frees the slot.
CREATE TABLE public.job_execution_evidence (
  job_id uuid PRIMARY KEY REFERENCES public.jobs (id),
  kind text NOT NULL CHECK (kind IN (
    'local_child_reaped', 'provider_call_terminal', 'pre_submission_rejected')),
  -- The exact local execution handle / provider function call ID; null only
  -- for a definite pre-submission rejection.
  execution_ref text CHECK (length(execution_ref) BETWEEN 1 AND 200),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096),
  recorded_by text NOT NULL CHECK (length(btrim(recorded_by)) BETWEEN 1 AND 200),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'pre_submission_rejected') = (execution_ref IS NULL))
);

CREATE FUNCTION public.job_execution_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
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
       OR j.invocation_nonce IS NOT NULL THEN
      PERFORM public.catalog_raise('SAC04', 'a submitted job cannot be released as never submitted');
    END IF;
  ELSE
    IF j.execution_call_id IS DISTINCT FROM NEW.execution_ref THEN
      PERFORM public.catalog_raise('SAC04', 'evidence must name the exact recorded execution');
    END IF;
    IF (NEW.kind = 'local_child_reaped') IS DISTINCT FROM (j.execution_backend = 'local') THEN
      PERFORM public.catalog_raise('SAC04', 'evidence kind does not match the job execution backend');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_execution_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON public.job_execution_evidence
  FOR EACH ROW EXECUTE FUNCTION public.job_execution_evidence_guard();

CREATE FUNCTION public.dispatch_admission_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    PERFORM public.catalog_raise('SAC01', 'the admission slot is a fixed singleton');
  END IF;
  IF OLD.job_id IS NULL AND NEW.job_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = NEW.job_id AND state = 'queued')
       OR NOT EXISTS (SELECT 1 FROM public.job_inputs WHERE job_id = NEW.job_id) THEN
      PERFORM public.catalog_raise('SAC04', 'only a queued job with persisted inputs can be admitted');
    END IF;
  ELSIF OLD.job_id IS NOT NULL AND NEW.job_id IS NULL THEN
    -- Release needs BOTH a terminal business state AND authoritative terminal
    -- execution evidence; neither alone frees the slot.
    IF NOT EXISTS (SELECT 1 FROM public.job_execution_evidence WHERE job_id = OLD.job_id)
       OR NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = OLD.job_id
                      AND state IN ('succeeded', 'failed', 'cancelled')) THEN
      PERFORM public.catalog_raise('SAC04',
        'the admission slot is released only by a terminal job state plus terminal execution evidence');
    END IF;
  ELSIF OLD.job_id IS DISTINCT FROM NEW.job_id THEN
    PERFORM public.catalog_raise('SAC04', 'the admission slot cannot move between jobs');
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER dispatch_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON public.dispatch_admission
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_admission_guard();

-- Releases the slot when (and only when) both release conditions hold. Called
-- by AFTER triggers on both inputs, so whichever arrives last frees the slot
-- and no code path can forget or shortcut it.
CREATE FUNCTION public.dispatch_try_release(p_job uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.dispatch_admission SET job_id = NULL, admitted_at = NULL
  WHERE slot = 1 AND job_id = p_job
    AND EXISTS (SELECT 1 FROM public.job_execution_evidence WHERE job_id = p_job)
    AND EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job AND state IN ('succeeded', 'failed', 'cancelled'));
END $$;
CREATE FUNCTION public.job_state_release() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.state IN ('succeeded', 'failed', 'cancelled') AND NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM public.dispatch_try_release(NEW.id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER job_state_release AFTER UPDATE OF state ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.job_state_release();
CREATE FUNCTION public.job_evidence_release() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.dispatch_try_release(NEW.job_id);
  RETURN NULL;
END $$;
CREATE TRIGGER job_evidence_release AFTER INSERT ON public.job_execution_evidence
  FOR EACH ROW EXECUTE FUNCTION public.job_evidence_release();

-- 4. service_capabilities: operator-issued, hashed machine credentials for
-- workflow controllers and the repair cron. Never a Better Auth session and
-- never issued from a request: created through the owner-credential CLI.
-- Worker capabilities stay job-bound on jobs rows (bootstrap, then running).
CREATE TABLE public.service_capabilities (
  credential_id uuid PRIMARY KEY,
  token_sha256 public.sha256_hex NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('workflow', 'cron')),
  audience text NOT NULL CHECK (length(audience) BETWEEN 1 AND 100),
  scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 8
    AND scopes <@ ARRAY['jobs:status', 'jobs:reconcile', 'jobs:repair']::text[]),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION public.service_capabilities_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.catalog_raise('SAC01', 'service capabilities are revoked, never deleted');
  END IF;
  IF TG_OP = 'UPDATE' AND ((NEW.credential_id, NEW.token_sha256, NEW.kind, NEW.audience, NEW.scopes,
        NEW.label, NEW.expires_at, NEW.created_at)
      IS DISTINCT FROM (OLD.credential_id, OLD.token_sha256, OLD.kind, OLD.audience, OLD.scopes,
        OLD.label, OLD.expires_at, OLD.created_at) OR OLD.revoked_at IS NOT NULL) THEN
    PERFORM public.catalog_raise('SAC01', 'service capabilities only move from active to revoked');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_capabilities_guard BEFORE UPDATE OR DELETE ON public.service_capabilities
  FOR EACH ROW EXECUTE FUNCTION public.service_capabilities_guard();

-- 5. Job lifecycle guard: write-once identity and the state machine, so no
-- helper, credential or fixture can skip admission.
CREATE FUNCTION public.jobs_orchestration_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  allowed text[];
  holds_slot boolean;
BEGIN
  IF NEW.state = OLD.state THEN
    allowed := ARRAY[OLD.state];
  ELSE
    allowed := CASE OLD.state
      WHEN 'queued' THEN ARRAY['submitting', 'cancelled']
      WHEN 'submitting' THEN ARRAY['submit_unknown', 'running', 'cancel_requested', 'needs_attention', 'failed']
      WHEN 'submit_unknown' THEN ARRAY['running', 'cancel_requested', 'needs_attention', 'failed']
      WHEN 'running' THEN ARRAY['result_pending', 'cancel_requested', 'needs_attention', 'failed']
      WHEN 'result_pending' THEN ARRAY['succeeded', 'cancel_requested', 'needs_attention', 'failed']
      WHEN 'cancel_requested' THEN ARRAY['cancelled', 'needs_attention']
      WHEN 'needs_attention' THEN ARRAY['cancel_requested', 'cancelled', 'failed']
      ELSE ARRAY[]::text[]
    END;
  END IF;
  IF NOT (NEW.state = ANY (allowed)) THEN
    PERFORM public.catalog_raise('SAC04', 'illegal job state transition ' || OLD.state || ' -> ' || NEW.state);
  END IF;
  IF (OLD.admitted_at IS NOT NULL AND NEW.admitted_at IS DISTINCT FROM OLD.admitted_at)
     OR (OLD.dispatch_key IS NOT NULL AND NEW.dispatch_key IS DISTINCT FROM OLD.dispatch_key)
     OR (OLD.execution_backend IS NOT NULL AND NEW.execution_backend IS DISTINCT FROM OLD.execution_backend)
     OR (OLD.execution_deadline IS NOT NULL AND NEW.execution_deadline IS DISTINCT FROM OLD.execution_deadline)
     OR (OLD.start_deadline IS NOT NULL AND NEW.start_deadline IS DISTINCT FROM OLD.start_deadline)
     OR (OLD.submission_intent_at IS NOT NULL AND (NEW.submission_intent_at, NEW.submission_intent_owner,
          NEW.bootstrap_token_sha256) IS DISTINCT FROM
          (OLD.submission_intent_at, OLD.submission_intent_owner, OLD.bootstrap_token_sha256))
     OR (OLD.claimed_at IS NOT NULL AND (NEW.claimed_at, NEW.capability_token_sha256)
          IS DISTINCT FROM (OLD.claimed_at, OLD.capability_token_sha256)) THEN
    PERFORM public.catalog_raise('SAC01', 'admission, deadline, intent and claim identity are write-once');
  END IF;
  -- Admission happens exactly once: queued -> submitting with the slot held,
  -- persisted inputs, dispatch key, backend and the absolute deadline.
  IF OLD.state = 'queued' AND NEW.state = 'submitting' THEN
    IF NEW.admitted_at IS NULL OR NEW.dispatch_key IS NULL OR NEW.execution_deadline IS NULL
       OR NEW.execution_backend IS NULL THEN
      PERFORM public.catalog_raise('SAC04', 'admission must persist dispatch key, backend and absolute deadline');
    END IF;
  END IF;
  -- Compute may only begin (or be re-entered) while holding the slot; later
  -- states follow from those and are re-gated per call by the claim predicate.
  IF NEW.state IN ('submitting', 'submit_unknown', 'running')
     AND NEW.state IS DISTINCT FROM OLD.state THEN
    SELECT EXISTS (SELECT 1 FROM public.dispatch_admission WHERE slot = 1 AND job_id = NEW.id)
      INTO holds_slot;
    IF NOT holds_slot THEN
      PERFORM public.catalog_raise('SAC04', 'only the job holding the admission slot can be active');
    END IF;
  END IF;
  IF NEW.state = 'submit_unknown' AND NEW.submission_intent_at IS NULL THEN
    PERFORM public.catalog_raise('SAC04', 'unknown submission requires persisted submission intent');
  END IF;
  IF NEW.state = 'running' AND (NEW.claimed_at IS NULL OR NEW.invocation_nonce IS NULL
      OR NEW.execution_call_id IS NULL) THEN
    PERFORM public.catalog_raise('SAC04', 'running requires a worker claim with nonce and execution ID');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_orchestration_guard BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_orchestration_guard();

-- ------------------------------------------------------------- privileges
-- Chained after the 003/004 helper: the migrator calls every feature helper
-- that exists. Admission/claims never need DELETE; evidence, inputs and the
-- slot are written by the web role through the job service only.
CREATE FUNCTION public.stateaction_grant_jobs(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'job_inputs', 'dispatch_admission', 'job_execution_evidence', 'service_capabilities'
  ] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, app_role);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO %I', t, app_role);
  END LOOP;
  EXECUTE format('GRANT INSERT ON TABLE public.job_inputs, public.job_execution_evidence TO %I', app_role);
  EXECUTE format('GRANT UPDATE (job_id, admitted_at, updated_at) ON TABLE public.dispatch_admission TO %I', app_role);
  -- Machine credentials are operator-issued with the owner credential.
  EXECUTE format('GRANT UPDATE (revoked_at) ON TABLE public.service_capabilities TO %I', app_role);
  EXECUTE format('GRANT UPDATE (execution_backend, admitted_at, dispatch_key, submission_intent_owner, bootstrap_token_sha256, claimed_at, last_heartbeat_at, heartbeat_phase, processed_frames, total_frames, unknown_at) ON TABLE public.jobs TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_jobs(name) FROM PUBLIC;
