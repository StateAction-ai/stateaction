-- Search indexes hold verified, result-bound projections, never source keys.
SET LOCAL lock_timeout = '2s';

ALTER TABLE public.job_result_candidates ADD COLUMN verified_review_search jsonb;
ALTER TABLE public.job_result_candidates ADD CONSTRAINT verified_review_search_object
  CHECK (verified_review_search IS NULL OR jsonb_typeof(verified_review_search) = 'object');

CREATE FUNCTION public.verified_review_search_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.verified_review_search IS NOT NULL)
    OR (TG_OP = 'UPDATE' AND NEW.verified_review_search IS DISTINCT FROM OLD.verified_review_search
        AND NOT ((OLD.status = 'provisional' AND NEW.status = 'verified' AND NEW.outcome = 'succeeded')
          OR (OLD.status = 'verified' AND NEW.status = 'accepted' AND NEW.verified_review_search IS NULL))) THEN
    PERFORM public.catalog_raise('SAC01', 'review search projection requires verified annotations');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER verified_review_search_guard
  BEFORE INSERT OR UPDATE ON public.job_result_candidates
  FOR EACH ROW EXECUTE FUNCTION public.verified_review_search_guard();

CREATE TABLE public.review_result_search (
  job_id uuid PRIMARY KEY,
  result_manifest_sha256 public.sha256_hex NOT NULL,
  segments_sha256 public.sha256_hex,
  segments_clock_domain text,
  no_hand_detected boolean NOT NULL,
  CHECK ((segments_sha256 IS NULL) = (segments_clock_domain IS NULL)),
  UNIQUE (job_id, result_manifest_sha256, segments_sha256),
  FOREIGN KEY (job_id, result_manifest_sha256)
    REFERENCES public.jobs (id, result_manifest_sha256)
);

CREATE TABLE public.review_caption_search (
  job_id uuid NOT NULL,
  result_manifest_sha256 public.sha256_hex NOT NULL,
  segments_sha256 public.sha256_hex NOT NULL,
  segment_id uuid NOT NULL,
  start_ts_ns bigint NOT NULL CHECK (start_ts_ns >= 0),
  original_text text CHECK (length(original_text) BETWEEN 1 AND 2000),
  original_label text CHECK (length(original_label) BETWEEN 1 AND 64),
  original_terms tsvector GENERATED ALWAYS AS
    (to_tsvector('simple', coalesce(original_text, ''))) STORED,
  PRIMARY KEY (job_id, segment_id),
  FOREIGN KEY (job_id, result_manifest_sha256, segments_sha256)
    REFERENCES public.review_result_search (job_id, result_manifest_sha256, segments_sha256)
);

CREATE INDEX review_caption_search_terms_idx
  ON public.review_caption_search USING gin (original_terms);
CREATE INDEX caption_corrections_search_terms_idx
  ON public.caption_corrections USING gin (to_tsvector('simple', coalesce(text, '')));
CREATE INDEX caption_corrections_search_result_idx
  ON public.caption_corrections (clip_id, job_id, selection_revision, segment_id, revision DESC);

CREATE TRIGGER review_result_search_immutable BEFORE UPDATE OR DELETE ON public.review_result_search
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER review_caption_search_immutable BEFORE UPDATE OR DELETE ON public.review_caption_search
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();

CREATE FUNCTION public.stateaction_grant_review_search(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON public.review_result_search, public.review_caption_search FROM %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT ON public.review_result_search, public.review_caption_search TO %I', app_role);
  EXECUTE format('GRANT UPDATE (verified_review_search) ON public.job_result_candidates TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_review_search(name) FROM PUBLIC;
