-- Extend review decisions and keep result-bound corrections and sharing evidence.
SET LOCAL lock_timeout = '2s';

ALTER TABLE public.review_clip_decisions DROP CONSTRAINT review_clip_decisions_decision_check;
ALTER TABLE public.review_clip_decisions ADD CONSTRAINT review_clip_decisions_decision_check
  CHECK (decision IN ('approved', 'rejected', 'reopened'));

CREATE OR REPLACE FUNCTION public.review_clip_decision_guard() RETURNS trigger
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
  IF NEW.decision IN ('rejected', 'reopened') AND EXISTS (
    SELECT 1 FROM public.dataset_review_clips
    WHERE clip_id = NEW.clip_id AND selection_revision = NEW.selection_revision
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'remove dataset assignments before leaving approval');
  END IF;
  RETURN NEW;
END $$;

-- Immutable command receipts allow a membership-only write to be replayed
-- and an undo to recover exactly the memberships changed by its target.
CREATE TABLE public.review_clip_commands (
  id uuid PRIMARY KEY,
  clip_id uuid NOT NULL REFERENCES public.review_clips (id),
  actor_user_id text NOT NULL REFERENCES public."user" (id),
  request jsonb NOT NULL,
  response jsonb NOT NULL,
  replaced_assignments jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE TRIGGER review_clip_commands_immutable BEFORE UPDATE OR DELETE ON public.review_clip_commands
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER review_clip_commands_no_truncate BEFORE TRUNCATE ON public.review_clip_commands
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

-- Legacy clearances reference viewer chunks. Review clip evidence is a
-- separate append-only record of the exact selected result the operator cleared.
CREATE TABLE public.dataset_review_clip_clearances (
  permission_id uuid NOT NULL REFERENCES public.dataset_sharing_permissions (id),
  clip_id uuid NOT NULL,
  job_id uuid NOT NULL,
  result_manifest_sha256 public.sha256_hex NOT NULL,
  selection_revision integer NOT NULL,
  cleared_by text NOT NULL CHECK (char_length(btrim(cleared_by)) BETWEEN 1 AND 200),
  cleared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (permission_id, clip_id, job_id, result_manifest_sha256, selection_revision),
  FOREIGN KEY (clip_id, selection_revision) REFERENCES public.clip_result_selections (clip_id, seq),
  FOREIGN KEY (job_id, clip_id) REFERENCES public.jobs (id, clip_id),
  FOREIGN KEY (job_id, result_manifest_sha256) REFERENCES public.jobs (id, result_manifest_sha256)
);
CREATE FUNCTION public.dataset_review_clip_clearance_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.require_review_clip_result(
    NEW.clip_id, NEW.job_id, NEW.result_manifest_sha256, NEW.selection_revision);
  IF (
    SELECT decision FROM public.review_clip_decisions
    WHERE clip_id = NEW.clip_id AND selection_revision = NEW.selection_revision
      AND job_id = NEW.job_id AND result_manifest_sha256 = NEW.result_manifest_sha256
    ORDER BY revision DESC LIMIT 1
  ) IS DISTINCT FROM 'approved' THEN
    PERFORM public.catalog_raise('SAC02', 'only approved review clip results can be cleared for sharing');
  END IF;
  PERFORM 1 FROM public.dataset_sharing_permissions
    WHERE id = NEW.permission_id AND status = 'active' FOR SHARE;
  IF NOT FOUND THEN
    PERFORM public.catalog_raise('SAC05', 'clearance needs active recipient-sharing permission');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dataset_review_clip_clearance_guard BEFORE INSERT ON public.dataset_review_clip_clearances
  FOR EACH ROW EXECUTE FUNCTION public.dataset_review_clip_clearance_guard();
CREATE TRIGGER dataset_review_clip_clearance_immutable BEFORE UPDATE OR DELETE ON public.dataset_review_clip_clearances
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER dataset_review_clip_clearance_no_truncate BEFORE TRUNCATE ON public.dataset_review_clip_clearances
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

CREATE FUNCTION public.dataset_review_sharing_ok(
  p_dataset uuid, p_clip uuid, p_job uuid, p_manifest public.sha256_hex, p_revision integer
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.dataset_sharing_permissions p
    JOIN public.dataset_access da ON da.sharing_permission_id = p.id
    WHERE da.dataset_id = p_dataset AND da.enabled FOR SHARE OF p;
  RETURN NOT EXISTS (
    SELECT 1 FROM public.dataset_access da
    WHERE da.dataset_id = p_dataset AND da.enabled AND NOT EXISTS (
      SELECT 1 FROM public.dataset_sharing_permissions p
      JOIN public.dataset_review_clip_clearances c ON c.permission_id = p.id
      WHERE p.id = da.sharing_permission_id AND p.status = 'active'
        AND c.clip_id = p_clip AND c.job_id = p_job AND c.result_manifest_sha256 = p_manifest
        AND c.selection_revision = p_revision
    )
  );
END $$;
REVOKE ALL ON FUNCTION public.dataset_review_sharing_ok(uuid, uuid, uuid, public.sha256_hex, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.dataset_review_clip_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.lock_review_clip(NEW.clip_id);
  -- Undo may restore the exact stale rows displaced by its target command.
  -- They remain invisible because their selection is older than the current one.
  IF NEW.selection_revision < (
    SELECT max(seq) FROM public.clip_result_selections WHERE clip_id = NEW.clip_id
  ) AND EXISTS (
    SELECT 1 FROM public.review_clip_commands undo
    JOIN public.review_clip_commands target ON target.id::text = undo.request ->> 'targetCommandId'
      AND target.clip_id = undo.clip_id AND target.request ->> 'action' = 'add'
    CROSS JOIN LATERAL jsonb_populate_recordset(
      NULL::public.dataset_review_clips, target.replaced_assignments
    ) prior
    WHERE undo.clip_id = NEW.clip_id AND undo.request ->> 'action' = 'undo'
      AND undo.xmin = pg_current_xact_id()::xid
      AND public.catalog_has_role(undo.actor_user_id, 'staff') AND prior = NEW
      AND EXISTS (
        SELECT 1 FROM public.review_clip_decisions reversal
        WHERE reversal.id = undo.id AND reversal.clip_id = NEW.clip_id
          AND reversal.selection_revision > NEW.selection_revision
          AND reversal.reviewer_user_id = undo.actor_user_id
          AND reversal.xmin = pg_current_xact_id()::xid
      )
  ) THEN
    PERFORM 1 FROM public.datasets WHERE id = NEW.dataset_id FOR UPDATE;
    RETURN NEW;
  END IF;
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
  -- Serialize with grant changes in the established clip -> dataset order.
  PERFORM 1 FROM public.datasets WHERE id = NEW.dataset_id FOR UPDATE;
  IF NOT public.dataset_review_sharing_ok(
    NEW.dataset_id, NEW.clip_id, NEW.job_id, NEW.result_manifest_sha256, NEW.selection_revision
  ) THEN
    PERFORM public.catalog_raise('SAC05',
      'every enabled recipient must have active sharing permission clearing this review clip result');
  END IF;
  DELETE FROM public.dataset_review_clips
    WHERE dataset_id = NEW.dataset_id AND clip_id = NEW.clip_id
      AND selection_revision < NEW.selection_revision;
  RETURN NEW;
END $$;

-- The whole dataset is hidden from customers when any stored assignment
-- targets an old selection or a clip that no longer has current approval.
CREATE VIEW public.datasets_with_stale_review_clips AS
  SELECT DISTINCT m.dataset_id
  FROM public.dataset_review_clips m
  WHERE NOT EXISTS (
    SELECT 1 FROM public.selected_dataset_review_clips s
    JOIN public.review_clips c ON c.id = s.clip_id AND c.selected_job_id = m.job_id
    JOIN public.jobs j ON j.id = c.selected_job_id AND j.result_manifest_sha256 = m.result_manifest_sha256
    WHERE s.dataset_id = m.dataset_id AND s.clip_id = m.clip_id
      AND m.selection_revision = (
        SELECT max(seq) FROM public.clip_result_selections WHERE clip_id = m.clip_id
      )
  );

CREATE OR REPLACE FUNCTION public.dataset_access_review_clip_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.enabled THEN
    PERFORM 1 FROM public.datasets WHERE id = NEW.dataset_id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM public.datasets_with_stale_review_clips WHERE dataset_id = NEW.dataset_id
    ) THEN
      PERFORM public.catalog_raise('SAC05', 'every review clip must have current approval');
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.dataset_review_clips m
      WHERE m.dataset_id = NEW.dataset_id AND NOT EXISTS (
        SELECT 1 FROM public.dataset_review_clip_clearances c
        WHERE c.permission_id = NEW.sharing_permission_id AND c.clip_id = m.clip_id
          AND c.job_id = m.job_id AND c.result_manifest_sha256 = m.result_manifest_sha256
          AND c.selection_revision = m.selection_revision
      )
    ) THEN
      PERFORM public.catalog_raise('SAC05',
        'every current approved review clip result must be cleared for this recipient before granting');
    END IF;
  END IF;
  RETURN NEW;
END $$;
-- Revalidate when changing evidence on an already enabled grant.
DROP TRIGGER dataset_access_review_clip_guard ON public.dataset_access;
CREATE TRIGGER dataset_access_review_clip_guard BEFORE INSERT OR UPDATE ON public.dataset_access
  FOR EACH ROW EXECUTE FUNCTION public.dataset_access_review_clip_guard();

CREATE TABLE public.caption_corrections (
  id uuid PRIMARY KEY,
  clip_id uuid NOT NULL,
  job_id uuid NOT NULL,
  result_manifest_sha256 public.sha256_hex NOT NULL,
  selection_revision integer NOT NULL,
  segments_sha256 public.sha256_hex NOT NULL,
  segment_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  text text CHECK (char_length(text) BETWEEN 1 AND 2000),
  not_needed boolean NOT NULL,
  reviewer_user_id text NOT NULL REFERENCES public."user" (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  undo_revision integer CHECK (undo_revision >= 0 AND undo_revision < revision - 1),
  mark_id uuid NOT NULL UNIQUE REFERENCES public.segment_marks (id),
  UNIQUE (clip_id, selection_revision, segment_id, revision),
  FOREIGN KEY (clip_id, selection_revision) REFERENCES public.clip_result_selections (clip_id, seq),
  FOREIGN KEY (job_id, clip_id) REFERENCES public.jobs (id, clip_id),
  FOREIGN KEY (job_id, result_manifest_sha256) REFERENCES public.jobs (id, result_manifest_sha256),
  CHECK (NOT not_needed OR text IS NULL),
  CHECK (text IS NOT NULL OR not_needed OR undo_revision IS NOT DISTINCT FROM 0),
  CHECK (undo_revision IS DISTINCT FROM 0 OR (text IS NULL AND NOT not_needed))
);
CREATE INDEX caption_corrections_job_idx ON public.caption_corrections (job_id, segment_id, selection_revision, revision DESC);
CREATE TRIGGER caption_corrections_immutable BEFORE UPDATE OR DELETE ON public.caption_corrections
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER caption_corrections_no_truncate BEFORE TRUNCATE ON public.caption_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

CREATE FUNCTION public.caption_correction_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  latest integer;
BEGIN
  IF NOT public.catalog_has_role(NEW.reviewer_user_id, 'staff') THEN
    PERFORM public.catalog_raise('SAC05', 'caption corrections require staff');
  END IF;
  PERFORM public.require_review_clip_result(
    NEW.clip_id, NEW.job_id, NEW.result_manifest_sha256, NEW.selection_revision);
  IF NOT EXISTS (
    SELECT 1 FROM public.segment_marks m
    JOIN public.job_output_slots s ON s.job_id = m.job_id
      AND s.slot = 'segments.json' AND s.file_id = m.segments_file_id
    WHERE m.id = NEW.mark_id AND m.job_id = NEW.job_id AND m.segment_id = NEW.segment_id
      AND m.segments_sha256 = NEW.segments_sha256 AND m.reviewer_user_id = NEW.reviewer_user_id
      AND (NEW.undo_revision IS NOT NULL OR (m.verdict = 'issue' AND m.issue_type = 'caption'))
      AND m.xmin = pg_current_xact_id()::xid
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'caption correction requires a matching mark in this transaction');
  END IF;
  SELECT coalesce(max(revision), 0) INTO latest FROM public.caption_corrections
    WHERE clip_id = NEW.clip_id AND selection_revision = NEW.selection_revision AND segment_id = NEW.segment_id;
  IF NEW.revision <> latest + 1 THEN
    PERFORM public.catalog_raise('SAC03', 'stale caption correction revision');
  END IF;
  IF NEW.undo_revision > 0 AND NOT EXISTS (
    SELECT 1 FROM public.caption_corrections c
    WHERE c.clip_id = NEW.clip_id AND c.selection_revision = NEW.selection_revision
      AND c.segment_id = NEW.segment_id AND c.revision = NEW.undo_revision
      AND c.undo_revision IS NULL AND c.text IS NOT DISTINCT FROM NEW.text
      AND c.not_needed = NEW.not_needed
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'undo must restore a prior edit of this caption');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER caption_correction_guard BEFORE INSERT ON public.caption_corrections
  FOR EACH ROW EXECUTE FUNCTION public.caption_correction_guard();

CREATE OR REPLACE FUNCTION public.stateaction_grant_clip_review(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON public.review_clip_decisions, public.dataset_review_clips FROM %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT ON public.review_clip_decisions, public.dataset_review_clips TO %I', app_role);
  EXECUTE format('GRANT SELECT ON public.selected_dataset_review_clips TO %I', app_role);
  EXECUTE format('GRANT DELETE ON public.dataset_review_clips TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.lock_review_clip(uuid), public.require_review_clip_result(uuid, uuid, public.sha256_hex, integer) TO %I', app_role);
  EXECUTE format('REVOKE ALL ON public.caption_corrections, public.review_clip_commands,
    public.datasets_with_stale_review_clips FROM %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT ON public.caption_corrections, public.review_clip_commands TO %I', app_role);
  EXECUTE format('REVOKE ALL ON public.dataset_review_clip_clearances FROM %I', app_role);
  EXECUTE format('GRANT SELECT ON public.datasets_with_stale_review_clips, public.dataset_review_clip_clearances TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.dataset_review_sharing_ok(uuid, uuid, uuid, public.sha256_hex, integer) TO %I', app_role);
END $$;

CREATE OR REPLACE FUNCTION public.stateaction_grant_clip_review_reads(reader_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('GRANT SELECT ON public.review_clip_decisions, public.dataset_review_clips,
    public.selected_dataset_review_clips, public.caption_corrections,
    public.datasets_with_stale_review_clips TO %I', reader_role);
END $$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'stateaction_dev_reader') THEN
    PERFORM public.stateaction_grant_clip_review_reads('stateaction_dev_reader');
  END IF;
END $$;
