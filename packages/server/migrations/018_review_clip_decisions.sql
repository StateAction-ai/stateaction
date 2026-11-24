-- Reviews and working dataset assignments for review clips. Viewer-chunk
-- decisions remain separate and never confer approval on a review clip.
SET LOCAL lock_timeout = '2s';
CREATE TABLE public.review_clip_decisions (
  id uuid PRIMARY KEY,
  clip_id uuid NOT NULL REFERENCES public.review_clips (id),
  job_id uuid NOT NULL,
  result_manifest_sha256 public.sha256_hex NOT NULL,
  selection_revision integer NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  reviewer_user_id text NOT NULL REFERENCES public."user" (id),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  task_label text CHECK (length(task_label) <= 200),
  notes text CHECK (length(notes) <= 4000),
  dataset_selection jsonb CHECK (
    dataset_selection IS NULL OR (
      jsonb_typeof(dataset_selection) = 'object'
      AND octet_length(dataset_selection::text) <= 16384
    )
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (clip_id, revision),
  FOREIGN KEY (job_id, clip_id) REFERENCES public.jobs (id, clip_id),
  FOREIGN KEY (job_id, result_manifest_sha256)
    REFERENCES public.jobs (id, result_manifest_sha256),
  FOREIGN KEY (clip_id, selection_revision)
    REFERENCES public.clip_result_selections (clip_id, seq),
  CHECK (decision <> 'approved' OR length(btrim(coalesce(task_label, ''))) >= 1),
  CHECK (decision = 'approved' OR dataset_selection IS NULL)
);

CREATE INDEX review_clip_decisions_result_idx
  ON public.review_clip_decisions (clip_id, selection_revision, revision DESC);
CREATE TRIGGER review_clip_decisions_immutable BEFORE UPDATE OR DELETE ON public.review_clip_decisions
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER review_clip_decisions_no_truncate BEFORE TRUNCATE ON public.review_clip_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

CREATE TABLE public.dataset_review_clips (
  dataset_id uuid NOT NULL REFERENCES public.datasets (id),
  clip_id uuid NOT NULL REFERENCES public.review_clips (id),
  job_id uuid NOT NULL,
  result_manifest_sha256 public.sha256_hex NOT NULL,
  selection_revision integer NOT NULL,
  added_by text NOT NULL REFERENCES public."user" (id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, clip_id, selection_revision),
  FOREIGN KEY (job_id, clip_id) REFERENCES public.jobs (id, clip_id),
  FOREIGN KEY (job_id, result_manifest_sha256)
    REFERENCES public.jobs (id, result_manifest_sha256),
  FOREIGN KEY (clip_id, selection_revision)
    REFERENCES public.clip_result_selections (clip_id, seq)
);
CREATE INDEX dataset_review_clips_result_idx ON public.dataset_review_clips (clip_id, selection_revision);
CREATE TRIGGER dataset_review_clips_no_update BEFORE UPDATE ON public.dataset_review_clips
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();

-- Match the recording -> clip lock order of the legacy selection mirror. The
-- clip lock is also taken by the per-clip result selection trigger in 017.
CREATE FUNCTION public.lock_review_clip(p_clip uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.recordings r
    JOIN public.review_clips c ON c.recording_id = r.id
    WHERE c.id = p_clip
    FOR UPDATE OF r;
  IF NOT FOUND THEN
    PERFORM public.catalog_raise('SAC02', 'review clip not found');
  END IF;
  PERFORM 1 FROM public.review_clips WHERE id = p_clip FOR UPDATE;
END $$;

CREATE FUNCTION public.require_review_clip_result(
  p_clip uuid, p_job uuid, p_manifest public.sha256_hex, p_revision integer
) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.lock_review_clip(p_clip);
  IF NOT EXISTS (
    SELECT 1 FROM public.review_clips c
    JOIN public.recordings r ON r.id = c.recording_id AND r.deleted_at IS NULL
    JOIN public.jobs j ON j.id = c.selected_job_id AND j.clip_id = c.id
    JOIN LATERAL (
      SELECT seq, job_id FROM public.clip_result_selections WHERE clip_id = c.id
      ORDER BY seq DESC LIMIT 1
    ) selection ON selection.job_id = j.id
    WHERE c.id = p_clip AND j.id = p_job AND j.state = 'succeeded'
      AND j.result_manifest_sha256 = p_manifest AND selection.seq = p_revision
  ) THEN
    PERFORM public.catalog_raise('SAC03', 'selected clip result changed');
  END IF;
END $$;

CREATE FUNCTION public.review_clip_decision_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.catalog_has_role(NEW.reviewer_user_id, 'staff') THEN
    PERFORM public.catalog_raise('SAC05', 'review requires staff');
  END IF;
  PERFORM public.require_review_clip_result(
    NEW.clip_id, NEW.job_id, NEW.result_manifest_sha256, NEW.selection_revision);
  IF NEW.revision <> 1 + coalesce((
    SELECT max(revision) FROM public.review_clip_decisions WHERE clip_id = NEW.clip_id
  ), 0) THEN
    PERFORM public.catalog_raise('SAC03', 'stale review revision');
  END IF;
  IF NEW.decision = 'rejected' AND EXISTS (
    SELECT 1 FROM public.dataset_review_clips
    WHERE clip_id = NEW.clip_id AND selection_revision = NEW.selection_revision
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'remove dataset assignments before rejection');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_clip_decision_guard BEFORE INSERT ON public.review_clip_decisions
  FOR EACH ROW EXECUTE FUNCTION public.review_clip_decision_guard();

CREATE FUNCTION public.dataset_review_clip_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.catalog_has_role(NEW.added_by, 'staff') THEN
    PERFORM public.catalog_raise('SAC05', 'dataset assignment requires staff');
  END IF;
  PERFORM public.require_review_clip_result(
    NEW.clip_id, NEW.job_id, NEW.result_manifest_sha256, NEW.selection_revision);
  IF (
    SELECT decision FROM public.review_clip_decisions
    WHERE clip_id = NEW.clip_id AND job_id = NEW.job_id
      AND result_manifest_sha256 = NEW.result_manifest_sha256
      AND selection_revision = NEW.selection_revision
    ORDER BY revision DESC LIMIT 1
  ) IS DISTINCT FROM 'approved' THEN
    PERFORM public.catalog_raise('SAC04', 'dataset assignment requires approval');
  END IF;
  -- Legacy sharing clearances refer to viewer chunks and cannot clear a clip.
  PERFORM 1 FROM public.datasets WHERE id = NEW.dataset_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.dataset_access WHERE dataset_id = NEW.dataset_id AND enabled
  ) THEN
    PERFORM public.catalog_raise('SAC05', 'shared dataset has no review clip clearance');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dataset_review_clip_insert_guard BEFORE INSERT ON public.dataset_review_clips
  FOR EACH ROW EXECUTE FUNCTION public.dataset_review_clip_insert_guard();

-- Staff dataset reads use the same selected job and latest decision as Review.
CREATE VIEW public.selected_dataset_review_clips AS
  SELECT m.dataset_id, m.clip_id, m.added_at, r.started_at,
         r.imported_from_cache,
         i.evidence #>> '{attribution,title}' AS import_title,
         CASE WHEN c.end_ts_ns IS NOT NULL THEN c.end_ts_ns - c.start_ts_ns
           WHEN jsonb_typeof(i.evidence -> 'durationSeconds') = 'number'
             THEN round((i.evidence ->> 'durationSeconds')::numeric * 1000000000)::bigint
         END AS duration_ns,
         decision.task_label
  FROM public.dataset_review_clips m
  JOIN public.review_clips c ON c.id = m.clip_id AND c.selected_job_id = m.job_id
  JOIN public.recordings r ON r.id = c.recording_id AND r.deleted_at IS NULL
  JOIN public.jobs j ON j.id = m.job_id AND j.state = 'succeeded'
    AND j.result_manifest_sha256 = m.result_manifest_sha256
  JOIN LATERAL (
    SELECT seq, job_id FROM public.clip_result_selections WHERE clip_id = c.id
    ORDER BY seq DESC LIMIT 1
  ) selection ON selection.seq = m.selection_revision AND selection.job_id = j.id
  LEFT JOIN public.cached_processing_imports i ON i.job_id = j.id
  JOIN LATERAL (
    SELECT decision, task_label FROM public.review_clip_decisions
    WHERE clip_id = c.id AND job_id = j.id AND result_manifest_sha256 = j.result_manifest_sha256
      AND selection_revision = selection.seq
    ORDER BY revision DESC LIMIT 1
  ) decision ON decision.decision = 'approved';

-- Both assignment and sharing take the same dataset lock before checking
-- membership so the restriction holds regardless of which command runs first.
CREATE FUNCTION public.dataset_access_review_clip_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.enabled THEN
    PERFORM 1 FROM public.datasets WHERE id = NEW.dataset_id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM public.selected_dataset_review_clips WHERE dataset_id = NEW.dataset_id
    ) THEN
      PERFORM public.catalog_raise('SAC05', 'sharing requires review clip clearance');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dataset_access_review_clip_guard BEFORE INSERT OR UPDATE OF enabled ON public.dataset_access
  FOR EACH ROW EXECUTE FUNCTION public.dataset_access_review_clip_guard();

CREATE FUNCTION public.stateaction_grant_clip_review_reads(reader_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('GRANT SELECT ON public.review_clip_decisions, public.dataset_review_clips,
    public.selected_dataset_review_clips TO %I', reader_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_clip_review_reads(name) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stateaction_dev_reader') THEN
    PERFORM public.stateaction_grant_clip_review_reads('stateaction_dev_reader');
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.lock_review_clip(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_review_clip_result(uuid, uuid, public.sha256_hex, integer) FROM PUBLIC;
CREATE FUNCTION public.stateaction_grant_clip_review(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON public.review_clip_decisions, public.dataset_review_clips FROM %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT ON public.review_clip_decisions, public.dataset_review_clips TO %I', app_role);
  EXECUTE format('GRANT SELECT ON public.selected_dataset_review_clips TO %I', app_role);
  EXECUTE format('GRANT DELETE ON public.dataset_review_clips TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.lock_review_clip(uuid), public.require_review_clip_result(uuid, uuid, public.sha256_hex, integer) TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_clip_review(name) FROM PUBLIC;
