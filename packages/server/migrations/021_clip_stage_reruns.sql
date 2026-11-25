-- Permit a confirmed stage-set retry to replace its exact current clip job.
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION public.review_clip_guard() RETURNS trigger
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
          AND (
            (j.previous_job_id IS NOT DISTINCT FROM OLD.live_job_id
             AND (OLD.live_job_id IS NULL OR EXISTS (
               SELECT 1 FROM public.jobs prev WHERE prev.id = OLD.live_job_id
                 AND prev.state IN ('failed', 'cancelled')
             )))
            OR (j.derived_from_job_id = OLD.live_job_id AND EXISTS (
              SELECT 1 FROM public.job_rerun_plans rp
              WHERE rp.job_id = j.id AND rp.plan -> 'schemaVersion' = '2'::jsonb
                AND rp.plan ->> 'clipId' = NEW.id::text
                AND rp.plan ->> 'parentJobId' = OLD.live_job_id::text
                AND rp.plan ->> 'sourceManifestSha256' = j.source_manifest_sha256
                AND rp.plan ->> 'clipSelectionSeq' = coalesce((
                  SELECT max(s.seq) FROM public.clip_result_selections s WHERE s.clip_id = NEW.id
                ), 0)::text
                AND public.catalog_has_role(rp.actor_id, 'staff')
            ))
          )
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
-- A retry may improve the result without discarding an independent inherited
-- failure. Preserve the prior selection if a previously good stage regressed.
CREATE FUNCTION public.clip_rerun_may_select(
  child uuid, current_seq integer, planned_seq integer, previous uuid, parent uuid
) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT current_seq = planned_seq
    AND NOT EXISTS (
      SELECT 1 FROM public.job_effective_stage_runs new_run
      WHERE new_run.job_id = child AND new_run.state IN ('failed', 'cancelled')
        AND NOT EXISTS (
          SELECT 1 FROM public.job_effective_stage_runs prior_run
          WHERE prior_run.job_id = coalesce(previous, parent)
            AND prior_run.stage = new_run.stage AND prior_run.state IN ('failed', 'cancelled')
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.job_effective_stage_runs prior_run
      WHERE prior_run.job_id = previous AND prior_run.state = 'succeeded'
        AND NOT EXISTS (
          SELECT 1 FROM public.job_effective_stage_runs new_run
          WHERE new_run.job_id = child AND new_run.stage = prior_run.stage AND new_run.state = 'succeeded'
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.jobs prior_run JOIN public.jobs new_run ON new_run.id = child
      WHERE prior_run.id = previous
        AND (coalesce(new_run.failed_window_count, 0) > coalesce(prior_run.failed_window_count, 0)
          OR coalesce(new_run.caption_failed_count, 0) > coalesce(prior_run.caption_failed_count, 0))
    )
$$;

CREATE OR REPLACE FUNCTION public.clip_selection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  planned_seq integer;
  current_seq integer;
  previous uuid;
  parent uuid;
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
  IF NEW.kind = 'auto' THEN
    SELECT (p.plan ->> 'clipSelectionSeq')::integer, c.selected_job_id, j.derived_from_job_id
      INTO planned_seq, previous, parent
    FROM public.job_rerun_plans p
    JOIN public.jobs j ON j.id = p.job_id
    JOIN public.review_clips c ON c.id = NEW.clip_id
    WHERE p.job_id = NEW.job_id AND p.plan -> 'schemaVersion' = '2'::jsonb;
  END IF;
  IF NEW.kind = 'auto' AND EXISTS (
    SELECT 1 FROM public.jobs WHERE id = NEW.job_id AND kind = 'clip_pipeline'
  ) AND (
    (planned_seq IS NULL AND NEW.seq <> 1) OR NEW.selected_by IS NOT NULL OR NOT public.job_is_current(NEW.job_id)
    OR NOT EXISTS (
      SELECT 1 FROM public.job_result_candidates c
      JOIN public.jobs j ON j.id = c.job_id AND j.result_manifest_sha256 = c.manifest_sha256
      WHERE c.job_id = NEW.job_id AND c.status = 'accepted' AND c.outcome = 'succeeded'
    )
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'automatic selection requires the first accepted current clip result');
  END IF;
  SELECT coalesce(max(seq), 0) INTO current_seq
    FROM public.clip_result_selections WHERE clip_id = NEW.clip_id;
  -- Obsolete or regressing results remain in the run history.
  IF planned_seq IS NOT NULL
     AND NOT public.clip_rerun_may_select(NEW.job_id, current_seq, planned_seq, previous, parent) THEN
    RETURN NULL;
  END IF;
  IF NEW.seq <> 1 + current_seq THEN
    PERFORM public.catalog_raise('SAC03', 'clip selection revision changed');
  END IF;
  RETURN NEW;
END $$;

-- A legacy whole-recording clip mirrors the recording selection ledger.
-- Check the clip revision before inserting a recording-level auto-selection.
CREATE FUNCTION public.guard_legacy_clip_rerun_selection() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  planned_seq integer;
  current_seq integer;
  previous uuid;
  parent uuid;
  clip uuid;
BEGIN
  IF NEW.kind <> 'auto' THEN RETURN NEW; END IF;
  SELECT (p.plan ->> 'clipSelectionSeq')::integer, c.selected_job_id, j.derived_from_job_id, c.id
    INTO planned_seq, previous, parent, clip
  FROM public.job_rerun_plans p
  JOIN public.jobs j ON j.id = p.job_id
  JOIN public.review_clips c ON c.id = j.clip_id
  WHERE j.id = NEW.job_id AND p.plan -> 'schemaVersion' = '2'::jsonb
  FOR UPDATE OF c;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT coalesce(max(seq), 0) INTO current_seq FROM public.clip_result_selections WHERE clip_id = clip;
  IF public.clip_rerun_may_select(NEW.job_id, current_seq, planned_seq, previous, parent) THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER guard_legacy_clip_rerun_selection BEFORE INSERT ON public.recording_result_selections
  FOR EACH ROW EXECUTE FUNCTION public.guard_legacy_clip_rerun_selection();
