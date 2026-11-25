CREATE FUNCTION public.stateaction_grant_hosted_console_reads(reader_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('GRANT SELECT (permission_id, clip_id, job_id, result_manifest_sha256,
    selection_revision) ON public.dataset_review_clip_clearances TO %I', reader_role);
  EXECUTE format('GRANT SELECT (job_id, result_manifest_sha256,
    segments_clock_domain, no_hand_detected) ON public.review_result_search TO %I', reader_role);
  EXECUTE format('GRANT SELECT (job_id, result_manifest_sha256, segments_sha256,
    segment_id, start_ts_ns, original_text, original_label, original_terms)
    ON public.review_caption_search TO %I', reader_role);
  EXECUTE format('GRANT SELECT (recording_id, state, reason, code, capture_source_id,
    allowed_recipe_ids, recipe_id, recipe_sha256, recipe, selected_by, evidence, matched_at)
    ON public.recording_capture_profiles TO %I', reader_role);
  EXECUTE format('GRANT SELECT (job_id, clip_id, result_manifest_sha256, clip_plan_sha256,
    size_bytes, object_key) ON public.review_clip_video_backfills TO %I', reader_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_hosted_console_reads(name) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'stateaction_dev_reader') THEN
    PERFORM public.stateaction_grant_hosted_console_reads('stateaction_dev_reader');
  END IF;
END $$;
