CREATE TABLE public.recording_capture_profiles (
  recording_id uuid PRIMARY KEY,
  source_manifest_sha256 public.sha256_hex NOT NULL,
  state text NOT NULL,
  reason text,
  code text,
  capture_source_id text,
  allowed_recipe_ids text[] NOT NULL,
  recipe_id text,
  recipe_sha256 public.sha256_hex,
  recipe jsonb,
  selected_by text REFERENCES public."user" (id),
  evidence jsonb NOT NULL CHECK (
    jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 32768
  ),
  matched_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (recording_id, source_manifest_sha256)
    REFERENCES public.recordings (id, source_manifest_sha256),
  CHECK (array_position(allowed_recipe_ids, NULL) IS NULL),
  CHECK ((
    state = 'held' AND (
      (reason = 'needs_setup' AND code = 'capture_source_unmatched'
        AND capture_source_id IS NULL AND cardinality(allowed_recipe_ids) = 0)
      OR (reason = 'needs_setup' AND code = 'recipe_unavailable'
        AND capture_source_id IS NOT NULL AND cardinality(allowed_recipe_ids) > 0)
      OR (reason = 'choose_recipe' AND code = 'manual_selection'
        AND capture_source_id IS NOT NULL AND cardinality(allowed_recipe_ids) > 0)
    )
    AND recipe_id IS NULL AND recipe_sha256 IS NULL AND recipe IS NULL AND selected_by IS NULL
    OR state = 'selected' AND reason IS NULL AND code IS NULL AND capture_source_id IS NOT NULL
      AND recipe_id = ANY (allowed_recipe_ids) AND recipe_sha256 IS NOT NULL
      AND jsonb_typeof(recipe) = 'object' AND recipe ->> 'recipeId' = recipe_id
  ) IS TRUE)
);

CREATE FUNCTION public.capture_profile_identity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.recording_id IS DISTINCT FROM OLD.recording_id
     OR NEW.source_manifest_sha256 IS DISTINCT FROM OLD.source_manifest_sha256
     OR OLD.state = 'selected' THEN
    PERFORM public.catalog_raise('SAC04', 'the selected capture recipe and source identity are immutable');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER capture_profile_identity_guard BEFORE UPDATE
  ON public.recording_capture_profiles FOR EACH ROW EXECUTE FUNCTION public.capture_profile_identity_guard();
REVOKE ALL ON public.recording_capture_profiles FROM PUBLIC;

ALTER TABLE public.cached_processing_imports ADD COLUMN originating_recipe_ref jsonb;
ALTER TABLE public.cached_processing_imports ADD CONSTRAINT cached_import_originating_recipe_ref
  CHECK (originating_recipe_ref IS NULL OR (
    jsonb_typeof(originating_recipe_ref) = 'object' AND (
      (
        originating_recipe_ref = jsonb_build_object('kind', 'workflow', 'workflowId', 'flora-spike-c')
        AND job_id = '74528137-a415-4cce-affc-2f3dfa89e1a8'
        AND manifest_sha256 = '4327070161cb747e775fa7b9fa281855094586290a60c67019cf2c9184e77e24'
      )
      OR (
        originating_recipe_ref ->> 'kind' = 'recipe'
        AND originating_recipe_ref ->> 'recipeId' ~ '^[a-z][a-z0-9_]{0,63}@[1-9][0-9]{0,8}$'
        AND originating_recipe_ref ->> 'recipeSha256' ~ '^[a-f0-9]{64}$'
        AND originating_recipe_ref = jsonb_build_object(
          'kind', 'recipe',
          'recipeId', originating_recipe_ref ->> 'recipeId',
          'recipeSha256', originating_recipe_ref ->> 'recipeSha256'
        )
      )
    )
  ) IS TRUE);

-- SA-143 published this exact manifest and documented the producer workflow.
ALTER TABLE public.cached_processing_imports DISABLE TRIGGER cached_processing_imports_immutable;
UPDATE public.cached_processing_imports
SET originating_recipe_ref = '{"kind":"workflow","workflowId":"flora-spike-c"}'::jsonb
WHERE job_id = '74528137-a415-4cce-affc-2f3dfa89e1a8'
  AND manifest_sha256 = '4327070161cb747e775fa7b9fa281855094586290a60c67019cf2c9184e77e24';
ALTER TABLE public.cached_processing_imports ENABLE TRIGGER cached_processing_imports_immutable;

CREATE FUNCTION public.stateaction_grant_capture_profiles(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.recording_capture_profiles TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_capture_profiles(name) FROM PUBLIC;
