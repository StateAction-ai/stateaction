-- Clip plan and review identities. Existing viewer chunks remain in clips.
SET LOCAL lock_timeout = '2s';

CREATE TABLE public.clip_plans (
  recording_id uuid NOT NULL REFERENCES public.recordings (id),
  version integer NOT NULL CHECK (version > 0),
  plan_job_id uuid UNIQUE,
  manifest_sha256 public.sha256_hex,
  original_mp4_file_id uuid UNIQUE,
  original_mp4_sha256 public.sha256_hex,
  frame_count integer CHECK (frame_count BETWEEN 1 AND 10000000),
  plan jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recording_id, version),
  FOREIGN KEY (plan_job_id, recording_id)
    REFERENCES public.jobs (id, recording_id),
  FOREIGN KEY (plan_job_id, manifest_sha256)
    REFERENCES public.jobs (id, result_manifest_sha256),
  FOREIGN KEY (original_mp4_file_id, plan_job_id, original_mp4_sha256)
    REFERENCES public.files (id, job_id, sha256),
  CHECK (
    (plan_job_id IS NULL AND version = 1 AND manifest_sha256 IS NULL
      AND original_mp4_file_id IS NULL AND original_mp4_sha256 IS NULL
      AND frame_count IS NULL AND plan IS NULL)
    OR
    (plan_job_id IS NOT NULL AND manifest_sha256 IS NOT NULL
      AND frame_count IS NOT NULL AND plan IS NOT NULL
      AND jsonb_typeof(plan) = 'object'
      AND ((original_mp4_file_id IS NOT NULL AND original_mp4_sha256 IS NOT NULL)
        OR (original_mp4_file_id IS NULL AND original_mp4_sha256 IS NULL
          AND plan ->> 'state' IS NOT DISTINCT FROM 'failed')))
  )
);

CREATE TRIGGER clip_plans_immutable BEFORE UPDATE OR DELETE ON public.clip_plans
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();

CREATE TABLE public.review_clips (
  id uuid PRIMARY KEY,
  recording_id uuid NOT NULL,
  plan_version integer NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  start_ordinal integer,
  end_ordinal integer,
  first_source_frame_id bigint,
  last_source_frame_id bigint,
  start_ts_ns bigint,
  end_ts_ns bigint,
  live_job_id uuid,
  selected_job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, recording_id),
  UNIQUE (recording_id, plan_version, ordinal),
  FOREIGN KEY (recording_id, plan_version)
    REFERENCES public.clip_plans (recording_id, version),
  CHECK (
    (start_ordinal IS NULL AND end_ordinal IS NULL AND first_source_frame_id IS NULL
      AND last_source_frame_id IS NULL AND start_ts_ns IS NULL AND end_ts_ns IS NULL)
    OR
    (start_ordinal IS NOT NULL AND end_ordinal IS NOT NULL
      AND first_source_frame_id IS NOT NULL AND last_source_frame_id IS NOT NULL
      AND start_ts_ns IS NOT NULL AND end_ts_ns IS NOT NULL
      AND start_ordinal >= 0 AND end_ordinal > start_ordinal AND end_ordinal <= 10000000
      AND first_source_frame_id >= 0 AND last_source_frame_id >= first_source_frame_id
      AND start_ts_ns >= 0 AND end_ts_ns >= start_ts_ns
      AND (end_ordinal = start_ordinal + 1) = (start_ts_ns = end_ts_ns)
      AND (end_ordinal = start_ordinal + 1) = (first_source_frame_id = last_source_frame_id))
  )
);
CREATE INDEX review_clips_queue_idx ON public.review_clips (created_at, id);

ALTER TABLE public.jobs ADD COLUMN clip_id uuid;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_clip_recording_fk
  FOREIGN KEY (clip_id, recording_id) REFERENCES public.review_clips (id, recording_id);
ALTER TABLE public.jobs ADD CONSTRAINT jobs_clip_identity_key UNIQUE (id, clip_id);
ALTER TABLE public.review_clips
  ADD CONSTRAINT review_clips_live_job_fk FOREIGN KEY (live_job_id, id)
    REFERENCES public.jobs (id, clip_id),
  ADD CONSTRAINT review_clips_selected_job_fk FOREIGN KEY (selected_job_id, id)
    REFERENCES public.jobs (id, clip_id);

-- Existing jobs and all retained files keep their original identities. Bounds
-- are unavailable unless recovered from the sealed frame map after migration.
INSERT INTO public.clip_plans (recording_id, version, created_at)
SELECT id, 1, created_at FROM public.recordings;

INSERT INTO public.review_clips (id, recording_id, plan_version, ordinal, created_at)
SELECT recording_id, recording_id, 1, 0, created_at FROM public.clip_plans;

-- ALTER TABLE holds its lock until this migration transaction commits. Disable
-- only the guards that would otherwise reject the new column on old terminal
-- rows. Preserve all existing columns, and restore both guards in this transaction.
-- These NOT VALID checks grandfather pre-007 rows, but PostgreSQL would
-- check the old fields on the clip-id-only UPDATE. Restore both before commit.
ALTER TABLE public.jobs DROP CONSTRAINT jobs_admission_complete;
ALTER TABLE public.jobs DROP CONSTRAINT jobs_claim_complete;
ALTER TABLE public.jobs DISABLE TRIGGER jobs_guard;
ALTER TABLE public.jobs DISABLE TRIGGER cached_import_job_guard;
UPDATE public.jobs SET clip_id = recording_id;
ALTER TABLE public.jobs ENABLE TRIGGER cached_import_job_guard;
ALTER TABLE public.jobs ENABLE TRIGGER jobs_guard;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_claim_complete CHECK (
  (claimed_at IS NULL) = (invocation_nonce IS NULL)
  AND (claimed_at IS NULL OR (execution_call_id IS NOT NULL AND capability_token_sha256 IS NOT NULL))
) NOT VALID;

UPDATE public.review_clips c SET live_job_id = r.current_job_id
  FROM public.recordings r WHERE r.id = c.recording_id;


ALTER TABLE public.jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_kind_check
  CHECK (kind IN ('process_recording', 'cached_import', 'clip_plan', 'clip_pipeline'));
ALTER TABLE public.jobs ADD CONSTRAINT jobs_clip_kind CHECK (
  (kind <> 'clip_pipeline' OR clip_id IS NOT NULL) AND (kind <> 'clip_plan' OR clip_id IS NULL));
ALTER TABLE public.jobs ADD CONSTRAINT jobs_admission_complete CHECK (
  (kind = 'cached_import' AND state IN ('queued', 'result_pending', 'succeeded'))
  OR (kind <> 'cached_import' AND (
    state = 'queued' OR (state = 'cancelled' AND admitted_at IS NULL)
    OR (admitted_at IS NOT NULL AND dispatch_key IS NOT NULL AND execution_backend IS NOT NULL
        AND execution_deadline IS NOT NULL)))) NOT VALID;

DROP INDEX public.jobs_one_active_per_recording_idx;
CREATE UNIQUE INDEX jobs_one_active_per_recording_idx ON public.jobs (recording_id)
  WHERE kind <> 'clip_pipeline' AND state NOT IN ('succeeded', 'failed', 'cancelled');
CREATE UNIQUE INDEX jobs_one_active_per_clip_idx ON public.jobs (clip_id)
  WHERE kind = 'clip_pipeline' AND state NOT IN ('succeeded', 'failed', 'cancelled');

ALTER TABLE public.job_result_candidates ADD COLUMN verified_clip_plan jsonb
  CHECK (verified_clip_plan IS NULL OR jsonb_typeof(verified_clip_plan) = 'object');

CREATE TABLE public.clip_result_selections (
  clip_id uuid NOT NULL REFERENCES public.review_clips (id),
  seq integer NOT NULL CHECK (seq > 0),
  job_id uuid NOT NULL,
  selected_by text REFERENCES public."user" (id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 512),
  kind text NOT NULL CHECK (kind IN ('auto','manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clip_id, seq),
  FOREIGN KEY (job_id, clip_id) REFERENCES public.jobs (id, clip_id),
  CHECK (kind <> 'manual' OR selected_by IS NOT NULL)
);

INSERT INTO public.clip_result_selections (clip_id, seq, job_id, selected_by, reason, kind, created_at)
SELECT j.clip_id, s.seq, s.job_id, s.selected_by, s.reason, s.kind, s.created_at
FROM public.recording_result_selections s JOIN public.jobs j ON j.id = s.job_id;

UPDATE public.review_clips c SET selected_job_id = (
  SELECT job_id FROM public.clip_result_selections WHERE clip_id = c.id ORDER BY seq DESC LIMIT 1
);

CREATE TRIGGER clip_result_selections_immutable BEFORE UPDATE OR DELETE ON public.clip_result_selections
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER clip_result_selections_no_truncate BEFORE TRUNCATE ON public.clip_result_selections
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER clip_plans_no_truncate BEFORE TRUNCATE ON public.clip_plans
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

CREATE FUNCTION public.clip_plan_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.plan_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.jobs j
    JOIN public.job_result_candidates c ON c.job_id = j.id AND c.status = 'accepted'
    LEFT JOIN public.job_output_slots s ON s.job_id = j.id AND s.slot = 'recording.mp4'
    LEFT JOIN public.files f ON f.id = s.file_id AND f.job_id = j.id
    LEFT JOIN public.job_output_verifications v
      ON v.file_id = f.id AND v.inventory_sha256 = c.inventory_sha256
    WHERE j.id = NEW.plan_job_id AND j.kind = 'clip_plan' AND j.state = 'succeeded'
      AND public.job_is_current(j.id)
      AND j.recording_id = NEW.recording_id AND j.result_manifest_sha256 = NEW.manifest_sha256
      AND NEW.plan ->> 'recording_id' = j.recording_id::text
      AND NEW.plan ->> 'source_manifest_sha256' = j.source_manifest_sha256
      AND NEW.plan ->> 'mode' = 'passthrough'
      AND c.verified_clip_plan = NEW.plan AND (NEW.plan ->> 'plan_version')::integer = NEW.version
      AND (NEW.plan ->> 'frame_count')::integer = NEW.frame_count
      AND ((f.id = NEW.original_mp4_file_id AND f.sha256 = NEW.original_mp4_sha256
              AND f.role = 'recording_mp4' AND f.state = 'verified' AND v.file_id IS NOT NULL)
        OR (NEW.plan ->> 'state' = 'failed' AND s.file_id IS NULL AND NEW.original_mp4_file_id IS NULL))
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'plan requires an accepted CPU plan and its verified original');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clip_plan_insert_guard BEFORE INSERT ON public.clip_plans
  FOR EACH ROW EXECUTE FUNCTION public.clip_plan_insert_guard();

CREATE FUNCTION public.review_clip_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p public.clip_plans;
  span jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - '{live_job_id,selected_job_id}'::text[]) IS DISTINCT FROM
       (to_jsonb(OLD) - '{live_job_id,selected_job_id}'::text[]) THEN
      PERFORM public.catalog_raise('SAC01', 'review clip identity is immutable');
    END IF;
    IF NEW.live_job_id IS DISTINCT FROM OLD.live_job_id THEN
      IF NEW.start_ordinal IS NULL THEN
        IF NEW.live_job_id IS DISTINCT FROM (
          SELECT r.current_job_id FROM public.recordings r WHERE r.id = NEW.recording_id
        ) THEN
          PERFORM public.catalog_raise('SAC04', 'legacy pointer must track the recording');
        END IF;
      ELSIF NOT EXISTS (
        SELECT 1 FROM public.jobs j WHERE j.id = NEW.live_job_id AND j.clip_id = NEW.id
          AND j.kind = 'clip_pipeline' AND j.state = 'queued'
          AND j.previous_job_id IS NOT DISTINCT FROM OLD.live_job_id
          AND (OLD.live_job_id IS NULL OR EXISTS (
            SELECT 1 FROM public.jobs prev WHERE prev.id = OLD.live_job_id
              AND prev.state IN ('failed', 'cancelled')
          ))
      ) THEN
        PERFORM public.catalog_raise('SAC04', 'live clip pointer needs its queued replacement or first job');
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO p FROM public.clip_plans WHERE recording_id = NEW.recording_id AND version = NEW.plan_version;
  IF p.plan_job_id IS NOT NULL THEN
    span := p.plan -> 'spans' -> NEW.ordinal;
    IF span ->> 'kind' IS DISTINCT FROM 'clip'
       OR span ->> 'start_ordinal' IS DISTINCT FROM NEW.start_ordinal::text
       OR span ->> 'end_ordinal' IS DISTINCT FROM NEW.end_ordinal::text
       OR span ->> 'first_source_frame_id' IS DISTINCT FROM NEW.first_source_frame_id::text
       OR span ->> 'last_source_frame_id' IS DISTINCT FROM NEW.last_source_frame_id::text
       OR span ->> 'start_ts_ns' IS DISTINCT FROM NEW.start_ts_ns::text
       OR span ->> 'end_ts_ns' IS DISTINCT FROM NEW.end_ts_ns::text
       OR NEW.live_job_id IS NOT NULL OR NEW.selected_job_id IS NOT NULL THEN
      PERFORM public.catalog_raise('SAC04', 'clip must match the verified plan');
    END IF;
  ELSIF NEW.id <> NEW.recording_id OR NEW.ordinal <> 0 OR NEW.start_ordinal IS NOT NULL
     OR NEW.selected_job_id IS NOT NULL OR NEW.live_job_id IS NOT NULL THEN
    PERFORM public.catalog_raise('SAC04', 'legacy clip must match its recording');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_clip_guard BEFORE INSERT OR UPDATE ON public.review_clips
  FOR EACH ROW EXECUTE FUNCTION public.review_clip_guard();
CREATE TRIGGER review_clips_no_delete BEFORE DELETE ON public.review_clips
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER review_clips_no_truncate BEFORE TRUNCATE ON public.review_clips
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

CREATE FUNCTION public.job_is_current(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.jobs j JOIN public.recordings r ON r.id = j.recording_id
    LEFT JOIN public.review_clips c ON c.id = j.clip_id
    WHERE j.id = p_job AND r.deleted_at IS NULL AND
      CASE WHEN j.kind = 'clip_pipeline' THEN c.live_job_id = j.id
           ELSE r.current_job_id = j.id END)
$$;

CREATE FUNCTION public.clip_selection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.review_clips c
    JOIN public.recordings r ON r.id = c.recording_id
    WHERE c.id = NEW.clip_id AND r.deleted_at IS NULL FOR UPDATE OF c;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.jobs WHERE id = NEW.job_id AND clip_id = NEW.clip_id AND state = 'succeeded'
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'selection requires an accepted job of this clip');
  END IF;
  IF NEW.kind = 'manual' AND NOT public.catalog_has_role(NEW.selected_by, 'staff') THEN
    PERFORM public.catalog_raise('SAC05', 'clip result selection requires staff');
  END IF;
  IF NEW.kind = 'auto' AND EXISTS (
    SELECT 1 FROM public.jobs WHERE id = NEW.job_id AND kind = 'clip_pipeline'
  ) AND (
    NEW.seq <> 1 OR NEW.selected_by IS NOT NULL OR NOT public.job_is_current(NEW.job_id)
    OR NOT EXISTS (
      SELECT 1 FROM public.job_result_candidates c
      JOIN public.jobs j ON j.id = c.job_id AND j.result_manifest_sha256 = c.manifest_sha256
      WHERE c.job_id = NEW.job_id AND c.status = 'accepted' AND c.outcome = 'succeeded'
    )
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'automatic selection requires the first accepted current clip result');
  END IF;
  IF NEW.seq <> 1 + coalesce((
      SELECT max(seq) FROM public.clip_result_selections WHERE clip_id = NEW.clip_id
    ), 0) THEN
    PERFORM public.catalog_raise('SAC03', 'clip selection revision changed');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clip_selection_guard BEFORE INSERT ON public.clip_result_selections
  FOR EACH ROW EXECUTE FUNCTION public.clip_selection_guard();

CREATE FUNCTION public.clip_apply_selection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.review_clips SET selected_job_id = NEW.job_id WHERE id = NEW.clip_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.clip_apply_selection() FROM PUBLIC;
CREATE TRIGGER clip_apply_selection AFTER INSERT ON public.clip_result_selections
  FOR EACH ROW EXECUTE FUNCTION public.clip_apply_selection();

CREATE FUNCTION public.clip_guard_recording_selection() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.jobs WHERE id = NEW.job_id AND kind IN ('clip_plan', 'clip_pipeline')) THEN
    PERFORM public.catalog_raise('SAC04', 'use the clip selection ledger for a clip result');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clip_guard_recording_selection BEFORE INSERT ON public.recording_result_selections
  FOR EACH ROW EXECUTE FUNCTION public.clip_guard_recording_selection();

-- The recording review routes can read the first clip while their UI moves
-- to the clip read model. Legacy selection retains its original semantics.
CREATE OR REPLACE FUNCTION public.recording_selected_job(p_recording_id uuid) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(
    (SELECT job_id FROM public.recording_result_selections
     WHERE recording_id = p_recording_id ORDER BY seq DESC LIMIT 1),
    (SELECT c.selected_job_id FROM public.review_clips c JOIN public.clip_plans p
      ON p.recording_id = c.recording_id AND p.version = c.plan_version
     WHERE c.recording_id = p_recording_id AND p.plan_job_id IS NOT NULL
     ORDER BY c.plan_version DESC, c.ordinal LIMIT 1))
$$;

-- Keep the existing recording-scoped review routes working for legacy results.
CREATE FUNCTION public.clip_follow_legacy_selection() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE target_clip uuid;
BEGIN
  SELECT clip_id INTO target_clip FROM public.jobs WHERE id = NEW.job_id AND kind <> 'clip_plan';
  IF target_clip IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.clip_plans p JOIN public.review_clips c
      ON c.recording_id = p.recording_id AND c.plan_version = p.version
    WHERE c.id = target_clip AND p.plan_job_id IS NULL
  ) THEN
    INSERT INTO public.clip_result_selections (clip_id, seq, job_id, selected_by, reason, kind, created_at)
    SELECT target_clip, coalesce(max(seq), 0) + 1, NEW.job_id, NEW.selected_by, NEW.reason, NEW.kind, NEW.created_at
    FROM public.clip_result_selections WHERE clip_id = target_clip;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clip_follow_legacy_selection AFTER INSERT ON public.recording_result_selections
  FOR EACH ROW EXECUTE FUNCTION public.clip_follow_legacy_selection();

CREATE FUNCTION public.clip_job_identity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.clip_id IS DISTINCT FROM OLD.clip_id THEN
      PERFORM public.catalog_raise('SAC01', 'job clip identity is immutable');
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind IN ('process_recording', 'cached_import') THEN
    INSERT INTO public.clip_plans (recording_id, version, created_at)
      SELECT id, 1, created_at FROM public.recordings WHERE id = NEW.recording_id
      ON CONFLICT DO NOTHING;
    INSERT INTO public.review_clips (id, recording_id, plan_version, ordinal, created_at)
      SELECT recording_id, recording_id, 1, 0, created_at FROM public.clip_plans
      WHERE recording_id = NEW.recording_id AND version = 1 AND plan_job_id IS NULL
      ON CONFLICT DO NOTHING;
    SELECT id INTO NEW.clip_id FROM public.review_clips
      WHERE id = NEW.recording_id AND start_ordinal IS NULL;
    IF NEW.clip_id IS NULL THEN
      PERFORM public.catalog_raise('SAC04', 'recording already has a verified clip plan');
    END IF;
  END IF;
  IF NEW.kind = 'clip_pipeline' AND EXISTS (
    SELECT 1 FROM public.jobs p WHERE p.id IN (NEW.previous_job_id, NEW.derived_from_job_id)
       AND p.clip_id IS DISTINCT FROM NEW.clip_id
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'clip job lineage cannot cross a plan boundary');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clip_job_identity_guard BEFORE INSERT OR UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.clip_job_identity_guard();

CREATE FUNCTION public.clip_task_identity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.jobs;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = NEW.job_id;
  IF j.kind NOT IN ('clip_pipeline', 'clip_plan') THEN
    RETURN NEW;
  END IF;
  IF NOT public.job_is_current(j.id)
     OR NEW.task_input ->> 'jobId' IS DISTINCT FROM j.id::text
     OR NEW.task_input ->> 'targetId' IS DISTINCT FROM j.recording_id::text
     OR NEW.task_input ->> 'sourceManifestSha256' IS DISTINCT FROM j.source_manifest_sha256
     OR NEW.task_input ->> 'profileRevision' IS DISTINCT FROM j.profile_revision THEN
    PERFORM public.catalog_raise('SAC04', 'task input must pin the current job and its source');
  END IF;
  IF j.kind = 'clip_plan' THEN
    IF NEW.task_input ->> 'schemaVersion' IS DISTINCT FROM '5'
       OR NEW.task_input ->> 'kind' IS DISTINCT FROM 'clip_plan'
       OR NEW.task_input ->> 'planVersion' IS DISTINCT FROM '1'
       OR NEW.task_input -> 'clipFilter' IS DISTINCT FROM
          '{"mode":"passthrough","module":"clip_filter@0","params":{}}'::jsonb THEN
      PERFORM public.catalog_raise('SAC04', 'plan input must use the admitted passthrough filter');
    END IF;
  ELSIF NEW.task_input ->> 'schemaVersion' IS DISTINCT FROM '4'
     OR NEW.task_input ->> 'kind' IS DISTINCT FROM 'process_recording'
     OR NOT EXISTS (
       SELECT 1 FROM public.review_clips c JOIN public.clip_plans p
         ON p.recording_id = c.recording_id AND p.version = c.plan_version
       WHERE c.id = j.clip_id AND c.id::text = NEW.task_input #>> '{clip,id}'
         AND c.plan_version::text = NEW.task_input #>> '{clip,planVersion}'
         AND p.manifest_sha256 = NEW.task_input #>> '{clip,planSha256}'
         AND p.plan -> 'spans' -> c.ordinal = NEW.task_input #> '{clip,sourceRange}'
     ) THEN
    PERFORM public.catalog_raise('SAC04', 'clip input must match its recorded plan and source range');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER clip_task_identity_guard BEFORE INSERT ON public.job_inputs
  FOR EACH ROW EXECUTE FUNCTION public.clip_task_identity_guard();

CREATE FUNCTION public.clip_follow_legacy_current_job() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.review_clips SET live_job_id = NEW.current_job_id
    WHERE id = NEW.id AND start_ordinal IS NULL;
  RETURN NEW;
END $$;
CREATE TRIGGER clip_follow_legacy_current_job AFTER UPDATE OF current_job_id ON public.recordings
  FOR EACH ROW WHEN (NEW.current_job_id IS DISTINCT FROM OLD.current_job_id)
  EXECUTE FUNCTION public.clip_follow_legacy_current_job();

DROP TRIGGER jobs_orchestration_guard ON public.jobs;
CREATE TRIGGER jobs_orchestration_guard BEFORE UPDATE ON public.jobs
  FOR EACH ROW WHEN (OLD.kind <> 'cached_import') EXECUTE FUNCTION public.jobs_orchestration_guard();
DROP TRIGGER jobs_acceptance_guard ON public.jobs;
CREATE TRIGGER jobs_acceptance_guard BEFORE UPDATE ON public.jobs
  FOR EACH ROW WHEN (OLD.kind <> 'cached_import') EXECUTE FUNCTION public.jobs_acceptance_guard();

CREATE OR REPLACE FUNCTION public.jobs_ingest_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  reg public.recording_registrations;
  adm public.recording_admissions;
BEGIN
  -- Other kinds are rejected by the jobs CHECK constraint itself.
  IF NEW.kind = 'cached_import' THEN
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
     OR (NEW.kind <> 'clip_pipeline' AND NEW.previous_job_id IS NULL AND NEW.derived_from_job_id IS NULL
         AND adm.job_id IS DISTINCT FROM NEW.id)
     OR (NEW.kind = 'clip_pipeline' AND NOT EXISTS (
       SELECT 1 FROM public.review_clips c JOIN public.clip_plans p
         ON p.recording_id = c.recording_id AND p.version = c.plan_version
       JOIN public.jobs plan ON plan.id = p.plan_job_id AND plan.state = 'succeeded'
       WHERE c.id = NEW.clip_id AND c.recording_id = NEW.recording_id
         AND p.plan ->> 'source_manifest_sha256' = NEW.source_manifest_sha256
     )) THEN
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


CREATE OR REPLACE FUNCTION public.job_current_ok(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.jobs j JOIN public.recordings r ON r.id = j.recording_id
    WHERE j.id = p_job AND j.state = 'running' AND j.claimed_at IS NOT NULL
      AND j.execution_deadline > now()
      AND public.job_is_current(j.id) AND r.deleted_at IS NULL AND r.status = 'processing'
      AND EXISTS (SELECT 1 FROM public.dispatch_admission a WHERE a.slot = 1 AND a.job_id = j.id)
      AND public.catalog_has_role(r.owner_user_id, 'collector')
      AND EXISTS (
        SELECT 1 FROM public.recording_registrations g
        WHERE g.recording_id = r.id AND g.owner_user_id = r.owner_user_id
          AND public.ingest_permission_ok(g.ingest_permission_id, g.owner_user_id, true)))
$$;


CREATE OR REPLACE FUNCTION public.job_stage_take_claim(
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
  SELECT public.job_is_current(p_job) AND r.deleted_at IS NULL AND r.status IN ('uploaded', 'processing')
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
       OR (NEW.kind = 'clip_plan' AND c.verified_clip_plan IS NULL)
       OR c.received_at > NEW.execution_deadline
       OR NOT EXISTS (SELECT 1 FROM public.job_execution_evidence WHERE job_id = NEW.id)
       OR NOT EXISTS (SELECT 1 FROM public.recordings r WHERE r.id = NEW.recording_id
                      AND public.job_is_current(NEW.id) AND r.deleted_at IS NULL AND r.status = 'processing')
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
           OR (j.kind = 'clip_plan' AND f.role NOT IN ('recording_mp4','result_manifest'))
           OR (j.kind = 'clip_pipeline' AND f.role = 'recording_mp4')
           OR (j.kind <> 'clip_plan' AND j.recipe IS NULL AND f.role IN ('segments_json', 'captions_json', 'hand_presence_json',
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
    IF NEW.status <> 'provisional' OR NEW.verified_counts IS NOT NULL OR NEW.verified_clip_plan IS NOT NULL THEN
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
  IF NEW.verified_clip_plan IS DISTINCT FROM OLD.verified_clip_plan
     AND NOT (OLD.status = 'provisional' AND NEW.status = 'verified' AND OLD.verified_clip_plan IS NULL
       AND NEW.outcome = 'succeeded'
       AND EXISTS (SELECT 1 FROM public.jobs WHERE id = NEW.job_id AND kind = 'clip_plan')) THEN
    PERFORM public.catalog_raise('SAC01', 'verified recording clip plan is write-once');
  END IF;
  RETURN NEW;
END $$;


CREATE OR REPLACE FUNCTION public.job_rerun_preparation_ok(p_job uuid, p_owner text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.jobs j
    JOIN public.recordings r ON r.id = j.recording_id
    JOIN public.dispatch_admission a ON a.slot = 1 AND a.job_id = j.id
    WHERE j.id = p_job AND j.derived_from_job_id IS NOT NULL AND j.state = 'submitting'
      AND public.job_is_current(j.id) AND r.deleted_at IS NULL AND r.status = 'processing'
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


CREATE FUNCTION public.stateaction_grant_clip_pipeline(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON public.clip_plans, public.review_clips, public.clip_result_selections FROM %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT ON public.clip_plans, public.review_clips, public.clip_result_selections TO %I', app_role);
  EXECUTE format('GRANT UPDATE (live_job_id) ON public.review_clips TO %I', app_role);
  EXECUTE format('GRANT UPDATE (verified_clip_plan) ON public.job_result_candidates TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_clip_pipeline(name) FROM PUBLIC;

-- The preserved recording_selected_job function now reads these tables.
-- Extend the existing reader helper so both current and future read-only
-- accounts can still use it.
CREATE OR REPLACE FUNCTION public.stateaction_grant_stage_rerun_reads(reader_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('GRANT SELECT ON public.job_effective_stage_runs,
    public.recording_result_selections, public.job_rerun_plans, public.job_stage_reuse,
    public.job_rerun_copies, public.clip_plans, public.review_clips,
    public.clip_result_selections TO %I', reader_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_stage_rerun_reads(name) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stateaction_dev_reader') THEN
    PERFORM public.stateaction_grant_stage_rerun_reads('stateaction_dev_reader');
  END IF;
END $$;
