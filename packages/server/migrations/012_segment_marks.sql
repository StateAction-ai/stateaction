-- SA-99 team Good/Issue marks per segment (migration 012). Additive only:
-- 001-011 are unchanged. Follows the `reviews` pattern of 003: append-only
-- revisions pinned to the exact accepted result, optimistic concurrency by
-- revision, written by the restricted web role through INSERT only.
--
-- What a mark is: one staff verdict on one segment of one accepted job's
-- segments.json, identified by (job_id, segments_sha256, segment_id). Marks
-- never edit model output (no row of segments, captions or hand pose is
-- touched). The newest revision of a (job, segment) wins; older revisions stay.
--
-- Invariants enforced here for every writer, including the owner credential:
--   * append-only: UPDATE, DELETE and TRUNCATE are refused (SAC01);
--   * verdict 'issue' requires an issue type (boundary, caption, hand_pose) and
--     'good' forbids one (CHECK);
--   * the job must be succeeded and own a completed segments_json file with
--     exactly the pinned digest (SAC04); a mark for another job's digest fails;
--   * the reviewer must hold an enabled staff role (SAC05);
--   * the revision must append to the latest one of that segment (SAC03).
-- Whether segment_id is one of that file's segments is checked by the API from
-- the digest-verified document (the ids live only in storage, not in the DB).
-- SQLSTATE classes reused from 003: SAC01 immutable, SAC03 stale revision,
-- SAC04 lifecycle, SAC05 authorization.

CREATE TABLE public.segment_marks (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.jobs (id),
  segments_sha256 sha256_hex NOT NULL,
  -- The accepted segments.json file: with job_id and digest it is a foreign key
  -- to files (id, job_id, sha256), so the pinned digest must exist for that job.
  segments_file_id uuid NOT NULL,
  segment_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  reviewer_user_id text NOT NULL REFERENCES "user" ("id") ON DELETE RESTRICT,
  verdict text NOT NULL CHECK (verdict IN ('good', 'issue')),
  issue_type text CHECK (issue_type IN ('boundary', 'caption', 'hand_pose')),
  note text CHECK (length(note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, segment_id, revision),
  FOREIGN KEY (segments_file_id, job_id, segments_sha256)
    REFERENCES public.files (id, job_id, sha256),
  CHECK ((verdict = 'issue') = (issue_type IS NOT NULL))
);
-- Latest mark per segment and per-reviewer history scans.
CREATE INDEX segment_marks_reviewer_created_idx
  ON public.segment_marks (reviewer_user_id, created_at DESC);

CREATE FUNCTION public.segment_marks_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  latest integer;
BEGIN
  -- Serialises concurrent marks of one segment; the UNIQUE key is the backstop.
  PERFORM pg_advisory_xact_lock(hashtextextended('segment_marks:' || NEW.job_id::text || ':' || NEW.segment_id::text, 0));
  IF NOT EXISTS (
    SELECT 1 FROM public.jobs j
    WHERE j.id = NEW.job_id AND j.state = 'succeeded' AND j.segment_count IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.files f
    WHERE f.id = NEW.segments_file_id AND f.job_id = NEW.job_id
      AND f.role = 'segments_json' AND f.purpose = 'output'
      AND f.sha256 = NEW.segments_sha256 AND f.state IN ('completed', 'verified')
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'marks target the accepted segments of a successful job');
  END IF;
  IF NOT public.catalog_has_role(NEW.reviewer_user_id, 'staff') THEN
    PERFORM public.catalog_raise('SAC05', 'reviewer must hold an enabled staff role');
  END IF;
  SELECT max(revision) INTO latest FROM public.segment_marks
  WHERE job_id = NEW.job_id AND segment_id = NEW.segment_id;
  IF NEW.revision <> coalesce(latest, 0) + 1 THEN
    PERFORM public.catalog_raise('SAC03', 'mark revision must append to the latest revision');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER segment_marks_insert_guard BEFORE INSERT ON public.segment_marks
  FOR EACH ROW EXECUTE FUNCTION public.segment_marks_insert_guard();
CREATE TRIGGER segment_marks_append_only BEFORE UPDATE OR DELETE ON public.segment_marks
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER segment_marks_no_truncate BEFORE TRUNCATE ON public.segment_marks
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

-- ------------------------------------------------------------- privileges
-- Chained after the 003-011 helpers (see src/migrations.ts grantAppRole).
CREATE FUNCTION public.stateaction_grant_segment_marks(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.segment_marks FROM %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT ON TABLE public.segment_marks TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_segment_marks(name) FROM PUBLIC;
