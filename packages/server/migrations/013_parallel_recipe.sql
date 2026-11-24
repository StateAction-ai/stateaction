-- The existing three stage identities and their evidence stay intact. Jobs
-- that already issued any stage claim keep the serial graph on re-entry.
ALTER TABLE public.jobs ADD COLUMN recipe_parallel boolean NOT NULL DEFAULT false;

CREATE FUNCTION public.job_start_parallel_recipe(p_job uuid, p_owner text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND OR j.recipe IS NULL OR j.controller_lease_owner IS DISTINCT FROM p_owner
     OR j.controller_lease_expires_at <= now() THEN
    PERFORM public.catalog_raise('SAC04', 'Recipe job is not leased by this controller');
  END IF;
  IF j.recipe_parallel THEN RETURN true; END IF;
  IF j.submission_intent_at IS NOT NULL OR j.state <> 'submitting' THEN RETURN false; END IF;
  UPDATE public.jobs SET recipe_parallel = true WHERE id = p_job;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.job_start_parallel_recipe(uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.job_stage_prior_settled(p_job uuid, p_recipe jsonb, p_stage text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY['segment', 'caption']) s(stage)
    WHERE (p_stage = 'caption' AND s.stage = 'segment'
           OR p_stage = 'hand_pose' AND NOT (SELECT recipe_parallel FROM jobs WHERE id = p_job))
      AND coalesce((public.job_recipe_stage(p_recipe, s.stage) ->> 'enabled')::boolean, false)
      AND NOT EXISTS (SELECT 1 FROM public.job_stage_runs r
                      WHERE r.job_id = p_job AND r.stage = s.stage AND public.job_stage_terminal(r.state)))
$$;

CREATE FUNCTION public.job_recipe_stages_settled(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT count(*) = 3 FROM public.job_stage_runs
    WHERE job_id = p_job AND public.job_stage_terminal(state)
$$;

CREATE FUNCTION public.job_parallel_recipe_closure_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (SELECT recipe_parallel FROM public.jobs WHERE id = NEW.job_id)
     AND NOT public.job_recipe_stages_settled(NEW.job_id) THEN
    PERFORM public.catalog_raise('SAC04', 'all recipe stages must be terminal before sealing');
  END IF;
  RETURN NEW;
END $$;
-- Runs after job_output_closures_guard has taken the job row lock.
CREATE TRIGGER job_parallel_recipe_closure_guard BEFORE INSERT ON public.job_output_closures
  FOR EACH ROW EXECUTE FUNCTION public.job_parallel_recipe_closure_guard();

CREATE FUNCTION public.stateaction_grant_parallel_recipe(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.job_start_parallel_recipe(uuid, text) TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_parallel_recipe(name) FROM PUBLIC;
