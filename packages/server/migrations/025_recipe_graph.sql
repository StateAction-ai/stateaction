SET LOCAL lock_timeout = '2s';

LOCK TABLE public.dispatch_admission, public.jobs, public.job_execution_evidence,
  public.job_stage_claims, public.job_stage_runs, public.job_stage_evidence
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;

DO $$
DECLARE
  slot_holders bigint;
  unsettled_jobs bigint;
  unsettled_claims bigint;
BEGIN
  SELECT count(*) INTO slot_holders FROM public.dispatch_admission WHERE job_id IS NOT NULL;
  SELECT count(*) INTO unsettled_jobs
  FROM public.jobs j
  WHERE j.kind IN ('process_recording', 'clip_plan', 'clip_pipeline')
    AND (
      j.state NOT IN ('queued', 'succeeded', 'failed', 'cancelled')
      OR (
        j.admitted_at IS NOT NULL AND j.submission_intent_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.job_execution_evidence e WHERE e.job_id = j.id)
      )
    );
  SELECT count(*) INTO unsettled_claims
  FROM public.job_stage_claims c
  WHERE NOT EXISTS (
    SELECT 1 FROM public.job_stage_evidence e
    WHERE e.job_id = c.job_id AND e.stage = c.stage
      AND e.execution_ref = public.job_stage_call(c.job_id, c.stage)
  );
  IF slot_holders + unsettled_jobs + unsettled_claims > 0 THEN
    RAISE EXCEPTION 'recipe migration blocked: % slot holders, % unsettled jobs and % unsettled claims',
      slot_holders, unsettled_jobs, unsettled_claims USING ERRCODE = '55000';
  END IF;
END $$;

CREATE TABLE public.job_legacy_recipe_nodes (
  job_id uuid NOT NULL REFERENCES public.jobs (id),
  node_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('recording', 'clip')),
  admitted_spec jsonb NOT NULL CHECK (jsonb_typeof(admitted_spec) = 'object'),
  execution_job_id uuid NOT NULL,
  original_receipt_sha256 public.sha256_hex,
  PRIMARY KEY (job_id, node_id),
  FOREIGN KEY (execution_job_id, node_id) REFERENCES public.job_stage_runs (job_id, stage)
);
CREATE TRIGGER job_legacy_recipe_nodes_immutable
  BEFORE UPDATE OR DELETE ON public.job_legacy_recipe_nodes
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER job_legacy_recipe_nodes_no_truncate
  BEFORE TRUNCATE ON public.job_legacy_recipe_nodes
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

INSERT INTO public.job_legacy_recipe_nodes
  (job_id, node_id, scope, admitted_spec, execution_job_id, original_receipt_sha256)
SELECT j.id, e.stage, CASE WHEN j.kind = 'clip_pipeline' THEN 'clip' ELSE 'recording' END,
       s.spec, r.job_id, r.receipt_sha256
FROM public.job_effective_stage_runs e
JOIN public.jobs j ON j.id = e.job_id
JOIN public.job_stage_runs r ON r.job_id = coalesce(e.execution_job_id, e.job_id) AND r.stage = e.stage
JOIN public.jobs producer ON producer.id = r.job_id AND producer.recording_id = j.recording_id
  AND producer.source_manifest_sha256 = j.source_manifest_sha256
CROSS JOIN LATERAL (SELECT public.job_recipe_stage(j.recipe, e.stage) AS spec) s
WHERE s.spec IS NOT NULL AND s.spec = public.job_recipe_stage(producer.recipe, e.stage)
  AND s.spec ->> 'module' = r.module AND s.spec #>> '{resources,gpu}' = r.requested_gpu
  AND e.state = r.state AND e.receipt_sha256 IS NOT DISTINCT FROM r.receipt_sha256
  AND public.job_stage_terminal(r.state)
  AND (r.call_id IS NULL OR EXISTS (
    SELECT 1 FROM public.job_stage_evidence proof
    WHERE proof.job_id = r.job_id AND proof.stage = r.stage AND proof.execution_ref = r.call_id
  ));

CREATE VIEW public.job_legacy_recipe_outputs AS
SELECT n.job_id, n.node_id, v.file_id, f.role, v.sha256, v.size_bytes, v.inventory_sha256
FROM public.job_legacy_recipe_nodes n
JOIN public.job_stage_runs r ON r.job_id = n.execution_job_id AND r.stage = n.node_id
JOIN public.job_result_candidates c ON c.job_id = n.job_id AND c.status = 'accepted'
JOIN public.job_output_verifications v ON v.job_id = n.job_id AND v.inventory_sha256 = c.inventory_sha256
JOIN public.files f ON f.id = v.file_id AND f.state = 'verified' AND f.size_bytes = v.size_bytes
WHERE r.state IN ('succeeded', 'failed') AND r.receipt IS NOT NULL
  AND (
    (n.job_id = n.execution_job_id AND r.receipt -> 'outputs' @> jsonb_build_array(
      jsonb_build_object('fileId', f.id::text, 'role', f.role, 'sha256', v.sha256, 'sizeBytes', v.size_bytes::text)))
    OR (
      n.job_id <> n.execution_job_id AND EXISTS (
        SELECT 1 FROM public.job_rerun_copies copies
        JOIN public.job_output_verifications original ON original.file_id = copies.original_file_id
        WHERE copies.job_id = n.job_id AND copies.stage = n.node_id AND copies.file_id = v.file_id
          AND copies.original_job_id = n.execution_job_id AND original.job_id = n.execution_job_id
          AND original.sha256 = v.sha256 AND original.size_bytes = v.size_bytes
          AND r.receipt -> 'outputs' @> jsonb_build_array(
            jsonb_build_object('fileId', original.file_id::text, 'role', f.role,
                               'sha256', original.sha256, 'sizeBytes', original.size_bytes::text))
      )
    )
  );

DO $$
DECLARE summary record;
BEGIN
  FOR summary IN
    SELECT j.kind, count(*) AS jobs,
      count(*) FILTER (WHERE n.job_id IS NOT NULL) AS mapped,
      count(*) FILTER (WHERE n.job_id IS NULL) AS unmapped,
      count(*) FILTER (WHERE n.job_id IS NOT NULL AND n.missing_receipt) AS missing_receipts
    FROM public.jobs j
    LEFT JOIN (
      SELECT job_id, bool_or(original_receipt_sha256 IS NULL) AS missing_receipt
      FROM public.job_legacy_recipe_nodes GROUP BY job_id
    ) n ON n.job_id = j.id
    GROUP BY j.kind ORDER BY j.kind
  LOOP
    RAISE NOTICE 'recipe migration history: % total %, mapped %, unmapped %, missing receipt %',
      summary.kind, summary.jobs, summary.mapped, summary.unmapped, summary.missing_receipts;
  END LOOP;
END $$;

CREATE TABLE public.job_recipe_graphs (
  job_id uuid PRIMARY KEY REFERENCES public.job_inputs (job_id),
  recipe_ref text NOT NULL CHECK (recipe_ref ~ '^[a-z][a-z0-9_]{0,31}@[1-9][0-9]{0,8}$'),
  recipe_sha256 public.sha256_hex NOT NULL,
  graph jsonb NOT NULL CHECK (jsonb_typeof(graph) = 'object' AND octet_length(graph::text) <= 524288),
  source_seconds integer NOT NULL CHECK (source_seconds BETWEEN 1 AND 7200),
  resolved_bindings jsonb NOT NULL CHECK (jsonb_typeof(resolved_bindings) = 'object'),
  parent_job_id uuid REFERENCES public.job_recipe_graphs (job_id),
  max_compute_cents integer NOT NULL CHECK (max_compute_cents BETWEEN 0 AND 100000000),
  max_gpu_cents integer NOT NULL CHECK (max_gpu_cents BETWEEN 0 AND max_compute_cents),
  CHECK (parent_job_id IS DISTINCT FROM job_id),
  CHECK ((graph ->> 'recipe' = recipe_ref AND graph ->> 'recipeSha256' = recipe_sha256) IS TRUE)
);

CREATE TABLE public.job_recipe_nodes (
  job_id uuid NOT NULL REFERENCES public.job_recipe_graphs (job_id),
  node_id text NOT NULL CHECK (node_id ~ '^[a-z][a-z0-9_]{0,31}$'),
  scope text NOT NULL CHECK (scope IN ('recording', 'clip')),
  spec jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object' AND octet_length(spec::text) <= 16384),
  binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object' AND octet_length(binding::text) <= 16384),
  budget_seconds integer NOT NULL CHECK (budget_seconds BETWEEN 1 AND 7200),
  compute_cost_cents integer NOT NULL CHECK (compute_cost_cents BETWEEN 0 AND 100000000),
  gpu_cost_cents integer NOT NULL CHECK (gpu_cost_cents BETWEEN 0 AND compute_cost_cents),
  PRIMARY KEY (job_id, node_id),
  CHECK ((spec ->> 'scope' = scope AND spec ->> 'moduleLockSha256' = binding ->> 'moduleLockSha256') IS TRUE)
);

CREATE TRIGGER job_recipe_graphs_immutable
  BEFORE UPDATE OR DELETE ON public.job_recipe_graphs
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER job_recipe_graphs_no_truncate
  BEFORE TRUNCATE ON public.job_recipe_graphs
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER job_recipe_nodes_immutable
  BEFORE UPDATE OR DELETE ON public.job_recipe_nodes
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER job_recipe_nodes_no_truncate
  BEFORE TRUNCATE ON public.job_recipe_nodes
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

CREATE OR REPLACE FUNCTION public.clip_task_identity_guard() RETURNS trigger
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
    IF NEW.task_input ->> 'schemaVersion' = '6' THEN
      IF NEW.task_input ->> 'kind' IS DISTINCT FROM 'clip_plan' OR NEW.task_input ? 'clip' THEN
        PERFORM public.catalog_raise('SAC04', 'recording graph input must have recording scope');
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.task_input ->> 'schemaVersion' IS DISTINCT FROM '5'
       OR NEW.task_input ->> 'kind' IS DISTINCT FROM 'clip_plan'
       OR NEW.task_input ->> 'planVersion' IS DISTINCT FROM '1'
       OR NEW.task_input -> 'clipFilter' IS DISTINCT FROM
          '{"mode":"passthrough","module":"clip_filter@0","params":{}}'::jsonb THEN
      PERFORM public.catalog_raise('SAC04', 'plan input must use the admitted passthrough filter');
    END IF;
  ELSIF NOT (
       (NEW.task_input ->> 'schemaVersion' = '4' AND NEW.task_input ->> 'kind' = 'process_recording')
       OR (NEW.task_input ->> 'schemaVersion' = '6' AND NEW.task_input ->> 'kind' = 'clip_pipeline')
     ) IS TRUE
     OR NOT EXISTS (
       SELECT 1 FROM public.review_clips c JOIN public.clip_plans p
         ON p.recording_id = c.recording_id AND p.version = c.plan_version
       WHERE c.id = j.clip_id AND c.id::text = NEW.task_input #>> '{clip,id}'
         AND c.plan_version::text = NEW.task_input #>> '{clip,planVersion}'
         AND CASE WHEN NEW.task_input ->> 'schemaVersion' = '6' THEN EXISTS (
           SELECT 1 FROM public.job_recipe_node_outputs o
           JOIN public.job_recipe_graphs g ON g.job_id = o.job_id
           WHERE o.job_id = p.plan_job_id AND o.artifact_type = 'clip_plan@1'
             AND o.node_id || '.' || o.port = g.graph #>> '{fanOut,clip}'
             AND o.sha256 = NEW.task_input #>> '{clip,planSha256}'
         ) ELSE p.manifest_sha256 = NEW.task_input #>> '{clip,planSha256}' END
         AND p.plan -> 'spans' -> c.ordinal = NEW.task_input #> '{clip,sourceRange}'
     ) THEN
    PERFORM public.catalog_raise('SAC04', 'clip input must match its recorded plan and source range');
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION public.job_pin_recipe_graph(p_job uuid, p_graph jsonb, p_runtime jsonb)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  i public.job_inputs;
  parent_id uuid;
  parent_bindings jsonb;
  bindings jsonb := '{}'::jsonb;
  job_scope text;
  graph_spec record;
  runtime jsonb;
  job_seconds integer;
  compute_cents bigint := 0;
  gpu_cents bigint := 0;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job FOR UPDATE;
  SELECT * INTO i FROM public.job_inputs WHERE job_id = p_job;
  IF j.id IS NULL OR j.state <> 'queued' OR NOT public.job_is_current(j.id)
     OR j.kind NOT IN ('clip_plan', 'clip_pipeline')
     OR i.task_input ->> 'schemaVersion' IS DISTINCT FROM '6'
     OR i.task_input ->> 'recipeRef' IS DISTINCT FROM p_graph ->> 'recipe'
     OR i.task_input ->> 'recipeSha256' IS DISTINCT FROM p_graph ->> 'recipeSha256'
     OR i.source_manifest_sha256 IS DISTINCT FROM j.source_manifest_sha256
     OR jsonb_typeof(p_runtime) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_graph -> 'nodes') IS DISTINCT FROM 'object' THEN
    PERFORM public.catalog_raise('SAC04', 'graph requires the current job with matching admitted inputs');
  END IF;

  job_seconds := (i.task_input ->> 'sourceSeconds')::integer;
  IF job_seconds IS NULL OR job_seconds > (p_graph #>> '{meta,limits,maxSourceSeconds}')::integer THEN
    PERFORM public.catalog_raise('SAC04', 'source exceeds admitted graph duration');
  END IF;
  IF j.kind = 'clip_pipeline' THEN
    job_scope := 'clip';
    SELECT g.job_id, g.resolved_bindings INTO parent_id, parent_bindings
    FROM public.review_clips c
    JOIN public.clip_plans p ON p.recording_id = c.recording_id AND p.version = c.plan_version
    JOIN public.job_recipe_graphs g ON g.job_id = p.plan_job_id AND g.graph = p_graph
    JOIN public.jobs producer ON producer.id = g.job_id AND producer.state = 'succeeded'
      AND producer.recording_id = j.recording_id AND producer.source_manifest_sha256 = j.source_manifest_sha256
    JOIN public.job_recipe_node_outputs output ON output.job_id = g.job_id
      AND output.artifact_type = 'clip_plan@1'
      AND output.node_id || '.' || output.port = g.graph #>> '{fanOut,clip}'
    WHERE c.id = j.clip_id AND output.sha256 = i.task_input #>> '{clip,planSha256}';
    IF parent_id IS NULL THEN
      PERFORM public.catalog_raise('SAC04', 'clip graph requires its accepted parent plan and graph');
    END IF;
  ELSE
    job_scope := 'recording';
  END IF;

  IF ARRAY(SELECT key FROM jsonb_object_keys(p_runtime) key ORDER BY key)
       IS DISTINCT FROM ARRAY(SELECT key FROM jsonb_each(p_graph -> 'nodes')
                             WHERE job_scope = 'recording' OR value ->> 'scope' = job_scope ORDER BY key)
     OR p_runtime = '{}'::jsonb THEN
    PERFORM public.catalog_raise('SAC04', 'runtime bindings must cover the admitted scope exactly');
  END IF;

  FOR graph_spec IN
    SELECT key, value FROM jsonb_each(p_graph -> 'nodes')
    WHERE job_scope = 'recording' OR value ->> 'scope' = job_scope
  LOOP
    runtime := p_runtime -> graph_spec.key;
    IF NOT COALESCE(
      runtime #>> '{binding,moduleLockSha256}' = graph_spec.value ->> 'moduleLockSha256'
      AND runtime #>> '{binding,codeRevision}' = i.code_revision
      AND (runtime ->> 'budgetSeconds')::integer =
        ceil((graph_spec.value #>> '{resources,budget,fixedSeconds}')::numeric
           + (graph_spec.value #>> '{resources,budget,perSourceSecond}')::numeric * job_seconds)
      AND (runtime ->> 'computeCostCents')::bigint BETWEEN 0 AND 100000000
      AND (runtime ->> 'gpuCostCents')::bigint BETWEEN 0 AND (runtime ->> 'computeCostCents')::bigint,
      false
    ) THEN
      PERFORM public.catalog_raise('SAC04', 'node runtime bounds or binding do not match the graph');
    END IF;
    IF parent_id IS NOT NULL
      AND parent_bindings -> graph_spec.key IS DISTINCT FROM runtime -> 'binding' THEN
      PERFORM public.catalog_raise('SAC04', 'clip binding differs from the recording admission');
    END IF;
    bindings := bindings || jsonb_build_object(graph_spec.key, runtime -> 'binding');
    compute_cents := compute_cents + (runtime ->> 'computeCostCents')::bigint;
    gpu_cents := gpu_cents + (runtime ->> 'gpuCostCents')::bigint;
  END LOOP;

  IF compute_cents > (p_graph #>> '{meta,limits,maxRecordingCostUsd}')::numeric * 100
     OR (job_scope = 'clip' AND compute_cents > (p_graph #>> '{meta,limits,maxClipJobCostUsd}')::numeric * 100) THEN
    PERFORM public.catalog_raise('SAC04', 'job runtime costs exceed the published caps');
  END IF;

  INSERT INTO public.job_recipe_graphs
    (job_id, recipe_ref, recipe_sha256, graph, source_seconds, resolved_bindings, parent_job_id, max_compute_cents, max_gpu_cents)
  VALUES (j.id, p_graph ->> 'recipe', p_graph ->> 'recipeSha256', p_graph, job_seconds, bindings, parent_id, compute_cents, gpu_cents);
  INSERT INTO public.job_recipe_nodes
    (job_id, node_id, scope, spec, binding, budget_seconds, compute_cost_cents, gpu_cost_cents)
  SELECT j.id, key, job_scope, p_graph -> 'nodes' -> key, value -> 'binding',
    (value ->> 'budgetSeconds')::integer,
    (value ->> 'computeCostCents')::integer, (value ->> 'gpuCostCents')::integer
  FROM jsonb_each(p_runtime) WHERE p_graph #>> ARRAY['nodes', key, 'scope'] = job_scope;
END $$;
REVOKE ALL ON FUNCTION public.job_pin_recipe_graph(uuid, jsonb, jsonb) FROM PUBLIC;


CREATE TABLE public.job_recipe_node_claims (
  job_id uuid NOT NULL,
  node_id text NOT NULL,
  controller_owner text NOT NULL CHECK (length(controller_owner) BETWEEN 1 AND 200),
  bootstrap_sha256 public.sha256_hex NOT NULL UNIQUE,
  intent_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  start_deadline timestamptz NOT NULL,
  submission_started_at timestamptz,
  claimed_at timestamptz,
  invocation_nonce text UNIQUE CHECK (invocation_nonce ~ '^[A-Za-z0-9_-]{43}$'),
  capability_sha256 public.sha256_hex UNIQUE,
  execution_ref text UNIQUE CHECK (execution_ref ~ '^[A-Za-z0-9_-]{1,128}$'),
  PRIMARY KEY (job_id, node_id),
  FOREIGN KEY (job_id, node_id) REFERENCES public.job_recipe_nodes (job_id, node_id),
  CHECK (start_deadline > intent_at),
  CHECK (execution_ref IS NULL OR submission_started_at IS NOT NULL),
  CHECK ((claimed_at IS NULL) = (invocation_nonce IS NULL) AND (claimed_at IS NULL) = (capability_sha256 IS NULL)),
  CHECK (claimed_at IS NULL OR execution_ref IS NOT NULL)
);

CREATE TABLE public.job_recipe_node_evidence (
  job_id uuid NOT NULL,
  node_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('never_submitted', 'local_child_reaped', 'provider_call_terminal')),
  execution_ref text CHECK (execution_ref ~ '^[A-Za-z0-9_-]{1,128}$'),
  observed jsonb NOT NULL CHECK (jsonb_typeof(observed) = 'object' AND octet_length(observed::text) <= 4096),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id, node_id),
  FOREIGN KEY (job_id, node_id) REFERENCES public.job_recipe_node_claims (job_id, node_id),
  CHECK ((kind = 'never_submitted') = (execution_ref IS NULL))
);

CREATE TRIGGER job_recipe_node_evidence_immutable
  BEFORE UPDATE OR DELETE ON public.job_recipe_node_evidence
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER job_recipe_node_evidence_no_truncate
  BEFORE TRUNCATE ON public.job_recipe_node_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

CREATE TABLE public.job_recipe_node_results (
  job_id uuid NOT NULL,
  node_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('succeeded', 'failed', 'cancelled', 'skipped')),
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  receipt jsonb CHECK (jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 524288),
  receipt_bytes text,
  receipt_sha256 public.sha256_hex,
  fingerprint_sha256 public.sha256_hex,
  reuse_job_id uuid,
  settled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id, node_id),
  FOREIGN KEY (job_id, node_id) REFERENCES public.job_recipe_nodes (job_id, node_id),
  FOREIGN KEY (reuse_job_id, node_id) REFERENCES public.job_recipe_node_results (job_id, node_id),
  CHECK (reuse_job_id IS DISTINCT FROM job_id),
  CHECK ((state = 'succeeded') = (error_code IS NULL)),
  CHECK ((receipt IS NULL) = (receipt_sha256 IS NULL) AND (receipt IS NULL) = (receipt_bytes IS NULL)),
  CHECK (reuse_job_id IS NULL OR (state = 'succeeded' AND receipt IS NULL)),
  CHECK (state <> 'succeeded' OR receipt IS NOT NULL OR reuse_job_id IS NOT NULL)
);

CREATE TRIGGER job_recipe_node_results_immutable
  BEFORE UPDATE OR DELETE ON public.job_recipe_node_results
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER job_recipe_node_results_no_truncate
  BEFORE TRUNCATE ON public.job_recipe_node_results
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

CREATE TABLE public.job_recipe_node_outputs (
  job_id uuid NOT NULL,
  node_id text NOT NULL,
  port text NOT NULL CHECK (port ~ '^[a-z][a-z0-9_]{0,31}$'),
  artifact_type text NOT NULL CHECK (artifact_type ~ '^[a-z][a-z0-9_]{0,31}@[1-9][0-9]{0,8}$'),
  file_id uuid NOT NULL UNIQUE,
  sha256 public.sha256_hex NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  PRIMARY KEY (job_id, node_id, port, file_id),
  FOREIGN KEY (job_id, node_id) REFERENCES public.job_recipe_node_results (job_id, node_id),
  FOREIGN KEY (file_id, job_id, sha256) REFERENCES public.files (id, job_id, sha256)
);

CREATE TRIGGER job_recipe_node_outputs_immutable
  BEFORE UPDATE OR DELETE ON public.job_recipe_node_outputs
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();
CREATE TRIGGER job_recipe_node_outputs_no_truncate
  BEFORE TRUNCATE ON public.job_recipe_node_outputs
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

CREATE TABLE public.job_graph_file_verifications (
  file_id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  node_id text NOT NULL,
  sha256 public.sha256_hex NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  FOREIGN KEY (job_id,node_id) REFERENCES public.job_recipe_node_evidence (job_id,node_id),
  FOREIGN KEY (file_id,job_id,sha256) REFERENCES public.files (id,job_id,sha256)
);

CREATE TRIGGER job_graph_file_verifications_immutable
  BEFORE UPDATE OR DELETE ON public.job_graph_file_verifications
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();

CREATE TRIGGER job_graph_file_verifications_no_truncate
  BEFORE TRUNCATE ON public.job_graph_file_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_forbid_change();

CREATE FUNCTION public.job_graph_verify_file(
  p_job uuid,p_node text,p_owner text,p_file uuid,p_name text,p_sha text,p_size bigint
) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE j public.jobs;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job FOR UPDATE;
  IF j.id IS NULL OR j.controller_lease_owner IS DISTINCT FROM p_owner
     OR j.controller_lease_expires_at <= clock_timestamp()
     OR NOT EXISTS (SELECT 1 FROM public.dispatch_admission WHERE job_id = p_job) THEN
    PERFORM public.catalog_raise('SAC04', 'file verification requires the current graph lease');
  END IF;
  IF j.state <> 'running' OR j.execution_deadline <= clock_timestamp() THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.job_recipe_node_claims c
    JOIN public.job_recipe_node_evidence e USING(job_id,node_id)
    WHERE c.job_id = p_job AND c.node_id = p_node AND c.claimed_at IS NOT NULL
      AND c.execution_ref = e.execution_ref
  ) OR NOT EXISTS (
    SELECT 1 FROM public.files f JOIN public.job_output_slots s ON s.job_id = f.job_id AND s.file_id = f.id
    WHERE f.id = p_file AND f.job_id = p_job AND f.recording_id = j.recording_id AND f.purpose = 'output'
      AND f.state IN ('completed','verified') AND f.size_bytes = p_size AND f.observed_size_bytes = p_size
      AND f.sha256 = p_sha AND s.slot = 'nodes/' || p_node || '/' || p_name
      AND public.graph_output_allowed(p_job,p_node,p_name,f.role)
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'file verification must match the terminal node and its completed slot');
  END IF;
  INSERT INTO public.job_graph_file_verifications(file_id,job_id,node_id,sha256,size_bytes)
  VALUES (p_file,p_job,p_node,p_sha,p_size) ON CONFLICT (file_id) DO NOTHING;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.job_graph_verify_file(uuid,text,text,uuid,text,text,bigint) FROM PUBLIC;

CREATE FUNCTION public.job_graph_retry_spend_deadline(p_job uuid, p_environment text)
RETURNS timestamptz LANGUAGE plpgsql VOLATILE
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  approval public.rerun_spend_authorizations;
  used record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.jobs WHERE id = p_job AND derived_from_job_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.job_rerun_plans
                WHERE job_id = p_job AND plan ->> 'maxComputeCostUsd' = '0.00') THEN
    RETURN 'infinity';
  END IF;
  SELECT cap.* INTO approval
  FROM public.rerun_spend_reservations reservation
  JOIN public.rerun_spend_authorizations cap ON cap.id = reservation.authorization_id
  JOIN public.jobs j ON j.id = reservation.job_id
  JOIN public.job_rerun_plans t ON t.job_id = j.id
  WHERE reservation.job_id = p_job AND cap.expires_at > clock_timestamp()
    AND cap.environment = p_environment AND coalesce(cap.recording_id,j.recording_id) = j.recording_id
    AND reservation.compute_cents = (t.plan ->> 'maxComputeCostUsd')::numeric * 100
    AND reservation.gpu_cents = (t.plan ->> 'maxGpuCostUsd')::numeric * 100
  FOR SHARE OF cap;
  IF NOT FOUND THEN
    PERFORM public.catalog_raise('SAC04', 'graph submission requires current compute authorization');
  END IF;
  SELECT * INTO used FROM public.job_rerun_used_spend(approval.id);
  IF used.gpu_cents > approval.max_gpu_cents OR used.compute_cents > approval.max_compute_cents THEN
    PERFORM public.catalog_raise('SAC04', 'graph submission exceeds the current authorization cap');
  END IF;
  RETURN approval.expires_at;
END $$;
REVOKE ALL ON FUNCTION public.job_graph_retry_spend_deadline(uuid,text) FROM PUBLIC;

CREATE FUNCTION public.job_graph_issue_claim(
  p_job uuid, p_node text, p_owner text, p_binding jsonb, p_token_sha256 text, p_start_seconds integer
) RETURNS TABLE (issued boolean, start_deadline timestamptz, execution_deadline timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  n public.job_recipe_nodes;
  snapshot public.job_recipe_graphs;
  start_at timestamptz;
  checked_at timestamptz;
  spend_deadline timestamptz;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job FOR UPDATE;
  SELECT * INTO n FROM public.job_recipe_nodes WHERE job_id = p_job AND node_id = p_node;
  SELECT * INTO snapshot FROM public.job_recipe_graphs WHERE job_id = p_job;
  checked_at := clock_timestamp();
  IF j.id IS NULL OR n.job_id IS NULL
     OR j.controller_lease_owner IS DISTINCT FROM p_owner OR j.controller_lease_expires_at <= checked_at
     OR j.state NOT IN ('submitting', 'running')
     OR NOT public.job_is_current(j.id)
     OR NOT EXISTS (SELECT 1 FROM public.dispatch_admission WHERE job_id = p_job)
     OR n.binding IS DISTINCT FROM p_binding
     OR j.execution_deadline <= checked_at + make_interval(secs => n.budget_seconds)
     OR p_start_seconds NOT BETWEEN 1 AND 1800 THEN
    PERFORM public.catalog_raise('SAC04', 'node claim requires the current job, lease and admitted binding');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.job_recipe_node_claims c WHERE c.job_id = p_job AND c.node_id = p_node
  ) THEN
    RETURN QUERY SELECT false, NULL::timestamptz, j.execution_deadline;
    RETURN;
  END IF;
  IF j.derived_from_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.job_rerun_plans t
    WHERE t.job_id = j.id AND t.plan ->> 'schemaVersion' = '3'
      AND t.plan ->> 'recipeSha256' = snapshot.recipe_sha256
      AND (t.plan -> 'execute') ? p_node
      AND t.plan -> 'bindings' @> jsonb_build_array(jsonb_build_array(p_node,n.binding))
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(t.plan -> 'reuse') kept
        WHERE NOT EXISTS (
          SELECT 1 FROM public.job_recipe_node_results r
          WHERE r.job_id = p_job AND r.node_id = kept ->> 'nodeId'
            AND r.state = 'succeeded' AND r.reuse_job_id IS NOT NULL
        )
      )
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'graph retry requires confirmed node, retained outputs and reserved spend');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.job_recipe_node_results r WHERE r.job_id = p_job AND r.node_id = p_node
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(n.spec -> 'producers') producer(id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.job_recipe_node_results r
      JOIN public.job_recipe_node_outputs o USING (job_id, node_id)
      WHERE r.node_id = producer.id AND r.state = 'succeeded' AND r.job_id =
        CASE WHEN snapshot.graph #>> ARRAY['nodes', producer.id, 'scope'] = n.scope
          THEN p_job ELSE snapshot.parent_job_id END
    )
  ) OR EXISTS (
    SELECT 1 FROM jsonb_each(n.spec -> 'inputs') AS input(port, edge)
    WHERE input.edge ->> 'from' NOT IN ('recording.source','clip.video')
      AND NOT EXISTS (
        SELECT 1 FROM public.job_recipe_node_outputs o
        JOIN public.job_recipe_node_results r USING(job_id,node_id)
        WHERE o.node_id || '.' || o.port = input.edge ->> 'from'
          AND o.artifact_type = input.edge ->> 'type' AND r.state = 'succeeded'
          AND o.job_id = CASE WHEN snapshot.graph #>> ARRAY[
            'nodes', split_part(input.edge ->> 'from','.',1), 'scope'
          ] = n.scope THEN p_job ELSE snapshot.parent_job_id END
      )
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'node is settled or its producer has no proved output');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.job_recipe_node_claims c
    JOIN public.job_recipe_nodes active USING (job_id, node_id)
    LEFT JOIN public.job_recipe_node_evidence e USING (job_id, node_id)
    WHERE c.job_id = p_job AND e.job_id IS NULL
      AND (active.spec #>> '{resources,gpu}' IS NULL) = (n.spec #>> '{resources,gpu}' IS NULL)
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'resource class already has an outstanding node');
  END IF;
  spend_deadline := public.job_graph_retry_spend_deadline(p_job, n.binding ->> 'environment');
  start_at := LEAST(checked_at + make_interval(secs => p_start_seconds),
                   j.execution_deadline - make_interval(secs => n.budget_seconds), spend_deadline);
  IF start_at <= clock_timestamp() OR j.controller_lease_expires_at <= clock_timestamp() THEN
    PERFORM public.catalog_raise('SAC04', 'node authorization expired while checking its bounds');
  END IF;
  INSERT INTO public.job_recipe_node_claims (job_id, node_id, controller_owner, bootstrap_sha256, intent_at, start_deadline)
  VALUES (p_job, p_node, p_owner, p_token_sha256, checked_at, start_at);
  IF j.submission_intent_at IS NULL THEN
    UPDATE public.jobs SET submission_intent_at = checked_at, submission_intent_owner = p_owner,
      bootstrap_token_sha256 = p_token_sha256, start_deadline = start_at WHERE id = p_job;
  END IF;
  RETURN QUERY SELECT true, start_at, j.execution_deadline;
END $$;
REVOKE ALL ON FUNCTION public.job_graph_issue_claim(uuid,text,text,jsonb,text,integer) FROM PUBLIC;


CREATE FUNCTION public.job_graph_begin_submission(p_job uuid, p_node text, p_owner text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  c public.job_recipe_node_claims;
  checked_at timestamptz;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job FOR UPDATE;
  SELECT * INTO c FROM public.job_recipe_node_claims WHERE job_id = p_job AND node_id = p_node;
  checked_at := clock_timestamp();
  IF c.job_id IS NULL OR j.controller_lease_owner IS DISTINCT FROM p_owner
     OR j.controller_lease_expires_at <= checked_at OR NOT public.job_is_current(j.id)
     OR NOT EXISTS (SELECT 1 FROM public.dispatch_admission WHERE job_id = p_job)
     OR EXISTS (SELECT 1 FROM public.job_recipe_node_evidence WHERE job_id = p_job AND node_id = p_node) THEN
    PERFORM public.catalog_raise('SAC04', 'submission needs a current unsettled claim and lease');
  END IF;
  IF c.submission_started_at IS NOT NULL THEN
    RETURN 'already_started';
  END IF;
  IF j.state = 'cancel_requested' THEN
    INSERT INTO public.job_recipe_node_evidence (job_id, node_id, kind, observed)
    VALUES (p_job, p_node, 'never_submitted', '{"reason":"cancel_requested"}');
    INSERT INTO public.job_recipe_node_results (job_id, node_id, state, error_code)
    VALUES (p_job, p_node, 'cancelled', 'cancel_requested');
    RETURN 'never_submitted';
  END IF;
  IF j.state NOT IN ('submitting', 'running') OR c.start_deadline <= checked_at
     OR c.controller_owner IS DISTINCT FROM p_owner THEN
    PERFORM public.catalog_raise('SAC04', 'submission authority has expired');
  END IF;
  PERFORM public.job_graph_retry_spend_deadline(p_job, (
    SELECT binding ->> 'environment' FROM public.job_recipe_nodes
    WHERE job_id = p_job AND node_id = p_node
  ));
  IF c.start_deadline <= clock_timestamp() OR j.controller_lease_expires_at <= clock_timestamp() THEN
    PERFORM public.catalog_raise('SAC04', 'submission authority expired while checking spend');
  END IF;
  UPDATE public.job_recipe_node_claims SET submission_started_at = checked_at
  WHERE job_id = p_job AND node_id = p_node;
  RETURN 'started';
END $$;
REVOKE ALL ON FUNCTION public.job_graph_begin_submission(uuid,text,text) FROM PUBLIC;

CREATE FUNCTION public.job_graph_bind_call(p_job uuid, p_node text, p_owner text, p_execution_ref text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  c public.job_recipe_node_claims;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job FOR UPDATE;
  SELECT * INTO c FROM public.job_recipe_node_claims WHERE job_id = p_job AND node_id = p_node;
  IF c.submission_started_at IS NULL OR j.controller_lease_owner IS DISTINCT FROM p_owner
     OR j.controller_lease_expires_at <= clock_timestamp()
     OR NOT EXISTS (SELECT 1 FROM public.dispatch_admission WHERE job_id = p_job)
     OR p_execution_ref IS NULL
     OR (j.execution_backend = 'modal' AND p_execution_ref !~ '^fc-[A-Za-z0-9]{1,77}$')
     OR (c.execution_ref IS NOT NULL AND c.execution_ref IS DISTINCT FROM p_execution_ref) THEN
    PERFORM public.catalog_raise('SAC04', 'the current lease can bind only the exact started call');
  END IF;
  UPDATE public.job_recipe_node_claims SET execution_ref = p_execution_ref
  WHERE job_id = p_job AND node_id = p_node AND execution_ref IS NULL;
END $$;
REVOKE ALL ON FUNCTION public.job_graph_bind_call(uuid,text,text,text) FROM PUBLIC;

CREATE FUNCTION public.job_graph_record_terminal(
  p_job uuid, p_node text, p_owner text, p_kind text, p_execution_ref text, p_observed jsonb
) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  c public.job_recipe_node_claims;
  e public.job_recipe_node_evidence;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job FOR UPDATE;
  SELECT * INTO c FROM public.job_recipe_node_claims WHERE job_id = p_job AND node_id = p_node;
  IF c.execution_ref IS NULL OR c.execution_ref IS DISTINCT FROM p_execution_ref
     OR j.controller_lease_owner IS DISTINCT FROM p_owner OR j.controller_lease_expires_at <= clock_timestamp()
     OR NOT EXISTS (SELECT 1 FROM public.dispatch_admission WHERE job_id = p_job)
     OR p_kind IS DISTINCT FROM (CASE j.execution_backend WHEN 'modal'
        THEN 'provider_call_terminal' WHEN 'local' THEN 'local_child_reaped' END) THEN
    PERFORM public.catalog_raise('SAC04', 'terminal evidence requires the current lease and exact call');
  END IF;
  SELECT * INTO e FROM public.job_recipe_node_evidence WHERE job_id = p_job AND node_id = p_node;
  IF FOUND THEN
    IF (e.kind, e.execution_ref, e.observed) IS DISTINCT FROM (p_kind, p_execution_ref, p_observed) THEN
      PERFORM public.catalog_raise('SAC01', 'node execution evidence is immutable');
    END IF;
    RETURN;
  END IF;
  INSERT INTO public.job_recipe_node_evidence (job_id, node_id, kind, execution_ref, observed)
  VALUES (p_job, p_node, p_kind, p_execution_ref, p_observed);
END $$;
REVOKE ALL ON FUNCTION public.job_graph_record_terminal(uuid,text,text,text,text,jsonb) FROM PUBLIC;



CREATE FUNCTION public.job_graph_take_claim(
  p_job uuid, p_node text, p_bootstrap_sha256 text, p_nonce text,
  p_backend text, p_execution_ref text, p_capability_sha256 text
) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  c public.job_recipe_node_claims;
  checked_at timestamptz;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job;
  PERFORM 1 FROM public.recordings WHERE id = j.recording_id FOR UPDATE;
  SELECT * INTO j FROM public.jobs WHERE id = p_job FOR UPDATE;
  SELECT * INTO c FROM public.job_recipe_node_claims WHERE job_id = p_job AND node_id = p_node;
  checked_at := clock_timestamp();
  IF c.job_id IS NULL OR c.submission_started_at IS NULL OR c.claimed_at IS NOT NULL
     OR c.bootstrap_sha256 IS DISTINCT FROM p_bootstrap_sha256
     OR c.start_deadline <= checked_at OR j.execution_deadline <= checked_at
     OR j.execution_backend IS DISTINCT FROM p_backend OR p_execution_ref IS NULL
     OR (p_backend = 'modal' AND p_execution_ref !~ '^fc-[A-Za-z0-9]{1,77}$')
     OR (c.execution_ref IS NOT NULL AND c.execution_ref IS DISTINCT FROM p_execution_ref)
     OR j.state NOT IN ('submitting','submit_unknown','running')
     OR NOT public.job_is_current(j.id)
     OR NOT EXISTS (SELECT 1 FROM public.dispatch_admission WHERE job_id = p_job)
     OR EXISTS (SELECT 1 FROM public.job_recipe_node_evidence WHERE job_id = p_job AND node_id = p_node)
     OR NOT EXISTS (
       SELECT 1 FROM public.recordings r JOIN public.recording_registrations g
        ON g.recording_id = r.id AND g.owner_user_id = r.owner_user_id
       WHERE r.id = j.recording_id AND r.deleted_at IS NULL AND r.status IN ('uploaded','processing')
        AND public.catalog_has_role(r.owner_user_id, 'collector')
        AND public.ingest_permission_ok(g.ingest_permission_id, g.owner_user_id, true)
     ) THEN
    PERFORM public.catalog_raise('SAC05', 'node bootstrap is unavailable');
  END IF;
  UPDATE public.job_recipe_node_claims SET claimed_at = checked_at, execution_ref = p_execution_ref,
    invocation_nonce = p_nonce, capability_sha256 = p_capability_sha256
    WHERE job_id = p_job AND node_id = p_node;
  IF j.claimed_at IS NULL THEN
    UPDATE public.jobs SET claimed_at = checked_at, invocation_nonce = p_nonce,
      execution_call_id = p_execution_ref, capability_token_sha256 = p_capability_sha256,
      last_heartbeat_at = checked_at, state = 'running' WHERE id = p_job;
    UPDATE public.recordings SET status = 'processing' WHERE id = j.recording_id;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.job_graph_take_claim(uuid,text,text,text,text,text,text) FROM PUBLIC;


CREATE FUNCTION public.graph_file_role(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN p_name = 'plan.json' THEN 'diagnostic_blob'
    WHEN p_name = 'video.mp4' THEN 'recording_mp4'
    WHEN p_name = 'segments.json' THEN 'segments_json'
    WHEN p_name = 'captions.json' THEN 'captions_json'
    WHEN p_name = 'hand_presence.json' THEN 'hand_presence_json'
    WHEN p_name IN ('replay_provenance.json','provenance.json','windows.json') THEN 'diagnostic_blob'
    WHEN p_name ~ '^observations_[0-9]{1,3}\.json$' THEN 'hand_observations_json'
    WHEN p_name ~ '^frame_map_[0-9]{1,3}\.json$' THEN 'frame_map_json'
    WHEN p_name ~ '^arrays_[0-9]{1,3}\.npz$' THEN 'hand_arrays_npz'
    WHEN p_name ~ '^rrd_[0-9]{1,3}\.rrd$' THEN 'viewer_rrd'
    WHEN p_name ~ '^rgb_[0-9]{1,3}\.mp4$' THEN 'clip_mp4'
    WHEN p_name ~ '^thumbnail_[0-9]{1,3}\.jpg$' THEN 'thumbnail_jpeg'
  END
$$;

CREATE FUNCTION public.graph_output_allowed(p_job uuid, p_node text, p_name text, p_role text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.graph_file_role(p_name) = p_role AND EXISTS (
    SELECT 1 FROM public.job_recipe_nodes n
    CROSS JOIN LATERAL jsonb_each_text(n.spec -> 'outputs') AS ports
    WHERE n.job_id = p_job AND n.node_id = p_node AND CASE ports.value
      WHEN 'clip_plan@1' THEN p_name = 'plan.json'
      WHEN 'review_video@1' THEN p_name = 'video.mp4'
      WHEN 'segments@2' THEN p_name IN ('segments.json','windows.json','replay_provenance.json','provenance.json')
      WHEN 'captions@2' THEN p_name IN ('captions.json','replay_provenance.json','provenance.json')
      WHEN 'hand_pose@2' THEN p_role IN ('hand_observations_json','frame_map_json','hand_arrays_npz','viewer_rrd','clip_mp4','thumbnail_jpeg','hand_presence_json')
      ELSE false END
  )
$$;

CREATE OR REPLACE FUNCTION public.job_output_slot_role_ok(p_slot text, p_role text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN p_slot = 'result-manifest.json' THEN p_role = 'result_manifest'
    WHEN p_slot = 'review-clip.mp4' OR p_slot ~ '^clips/[0-9]{3}/rgb\.mp4$' THEN p_role = 'clip_mp4'
    WHEN p_slot ~ '^clips/[0-9]{3}/hand-arrays\.npz$' THEN p_role = 'hand_arrays_npz'
    WHEN p_slot ~ '^clips/[0-9]{3}/hand-observations\.json$' THEN p_role = 'hand_observations_json'
    WHEN p_slot ~ '^clips/[0-9]{3}/frame-map\.json$' THEN p_role = 'frame_map_json'
    WHEN p_slot ~ '^clips/[0-9]{3}/thumbnail\.jpg$' THEN p_role = 'thumbnail_jpeg'
    WHEN p_slot ~ '^clips/[0-9]{3}/viewer\.rrd$' THEN p_role = 'viewer_rrd'
    WHEN p_slot = 'segments.json' THEN p_role = 'segments_json'
    WHEN p_slot = 'captions.json' THEN p_role = 'captions_json'
    WHEN p_slot = 'hand-presence.json' THEN p_role = 'hand_presence_json'
    WHEN p_slot = 'recording.mp4' THEN p_role = 'recording_mp4'
    WHEN p_slot ~ '^diagnostics/(segment|caption|hand_pose)/[a-z0-9_.-]{1,64}$'
         AND p_slot !~ '/\.{1,2}$' THEN p_role = 'diagnostic_blob'
    WHEN p_slot ~ '^nodes/[a-z][a-z0-9_]{0,31}/[A-Za-z0-9_.-]{1,128}$'
      THEN coalesce(public.graph_file_role(split_part(p_slot,'/',3)) = p_role, false)
    ELSE false
  END
$$;

CREATE FUNCTION public.graph_output_slot_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.slot LIKE 'nodes/%' AND NOT EXISTS (
    SELECT 1 FROM public.files f
    WHERE f.id = NEW.file_id AND f.job_id = NEW.job_id AND f.purpose = 'output'
      AND NEW.slot ~ '^nodes/[a-z][a-z0-9_]{0,31}/[A-Za-z0-9_.-]{1,128}$'
      AND public.graph_output_allowed(NEW.job_id,split_part(NEW.slot,'/',2),split_part(NEW.slot,'/',3),f.role)
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'output slot must name a declared graph artifact');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER graph_output_slot_guard BEFORE INSERT ON public.job_output_slots
  FOR EACH ROW EXECUTE FUNCTION public.graph_output_slot_guard();

CREATE FUNCTION public.job_graph_record_result(
  p_job uuid, p_node text, p_owner text, p_state text, p_error text,
  p_receipt text, p_outputs jsonb, p_fingerprint text
) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  n public.job_recipe_nodes;
  issued_claim public.job_recipe_node_claims;
  e public.job_recipe_node_evidence;
  r public.job_recipe_node_results;
  doc jsonb;
  digest text;
  receipt_files bigint;
  expired boolean;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job FOR UPDATE;
  SELECT * INTO n FROM public.job_recipe_nodes WHERE job_id = p_job AND node_id = p_node;
  IF n.job_id IS NULL OR j.controller_lease_owner IS DISTINCT FROM p_owner
     OR j.controller_lease_expires_at <= clock_timestamp()
     OR NOT EXISTS (SELECT 1 FROM public.dispatch_admission WHERE job_id = p_job)
     OR jsonb_typeof(p_outputs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_outputs) > 2000 THEN
    PERFORM public.catalog_raise('SAC04', 'node settlement requires the current job and lease');
  END IF;
  SELECT * INTO r FROM public.job_recipe_node_results WHERE job_id = p_job AND node_id = p_node;
  expired := j.execution_deadline <= clock_timestamp();
  IF p_state = 'succeeded' AND r.state IS DISTINCT FROM 'succeeded' AND (j.state <> 'running' OR expired) THEN
    p_state := CASE WHEN j.state = 'cancel_requested' THEN 'cancelled' ELSE 'failed' END;
    p_error := CASE WHEN j.state = 'cancel_requested' THEN 'cancel_requested'
                    WHEN expired THEN 'execution_deadline' ELSE 'graph_worker_unclaimed' END;
    p_receipt := NULL;
    p_outputs := '[]'::jsonb;
    p_fingerprint := NULL;
  END IF;
  IF p_receipt IS NOT NULL THEN
    IF octet_length(p_receipt) > 524288 THEN
      PERFORM public.catalog_raise('SAC04', 'node receipt exceeds the admitted cap');
    END IF;
    doc := p_receipt::jsonb;
    digest := encode(sha256(convert_to(p_receipt, 'UTF8')), 'hex');
  END IF;
  IF r.job_id IS NOT NULL THEN
    IF (r.state,r.error_code,r.receipt_sha256,r.fingerprint_sha256) IS DISTINCT FROM (p_state,p_error,digest,p_fingerprint) THEN
      PERFORM public.catalog_raise('SAC01', 'node settlement is immutable');
    END IF;
    RETURN;
  END IF;
  SELECT * INTO e FROM public.job_recipe_node_evidence WHERE job_id = p_job AND node_id = p_node;
  IF p_state = 'skipped' THEN
    IF p_receipt IS NOT NULL OR jsonb_array_length(p_outputs) <> 0 THEN
      PERFORM public.catalog_raise('SAC04', 'a skipped node cannot have an execution or output');
    END IF;
    IF j.state = 'submit_unknown' AND EXISTS (
      SELECT 1 FROM public.job_recipe_node_claims outstanding
      LEFT JOIN public.job_recipe_node_results settled USING(job_id,node_id)
      WHERE outstanding.job_id = p_job AND outstanding.submission_started_at IS NOT NULL
        AND settled.job_id IS NULL
    ) THEN
      PERFORM public.catalog_raise('SAC04', 'an unresolved submission does not authorize skipping other nodes');
    END IF;
    SELECT * INTO issued_claim FROM public.job_recipe_node_claims WHERE job_id = p_job AND node_id = p_node;
    IF FOUND THEN
      IF issued_claim.submission_started_at IS NOT NULL OR e.job_id IS NOT NULL
        OR (j.state NOT IN ('cancel_requested','submit_unknown','needs_attention')
          AND j.execution_deadline > clock_timestamp()) THEN
        PERFORM public.catalog_raise('SAC04', 'a live or started claim cannot be skipped');
      END IF;
      INSERT INTO public.job_recipe_node_evidence (job_id,node_id,kind,observed)
      VALUES (p_job,p_node,'never_submitted',jsonb_build_object('reason',p_error));
    END IF;
  ELSIF e.job_id IS NULL OR e.execution_ref IS NULL THEN
    PERFORM public.catalog_raise('SAC04', 'node settlement requires terminal evidence for its exact call');
  END IF;
  IF p_state = 'succeeded' AND (
    doc IS NULL OR doc ->> 'jobId' IS DISTINCT FROM p_job::text
    OR doc ->> 'recipeRef' IS DISTINCT FROM (
      SELECT recipe_ref FROM public.job_recipe_graphs WHERE job_id = p_job
    )
    OR doc ->> 'recordingId' IS DISTINCT FROM j.recording_id::text
    OR doc ->> 'sourceManifestSha256' IS DISTINCT FROM j.source_manifest_sha256
    OR doc ->> 'recipeSha256' IS DISTINCT FROM (
      SELECT recipe_sha256 FROM public.job_recipe_graphs WHERE job_id = p_job
    )
    OR doc ->> 'nodeId' IS DISTINCT FROM p_node
    OR doc ->> 'module' IS DISTINCT FROM n.spec ->> 'module'
    OR doc ->> 'executionRef' IS DISTINCT FROM e.execution_ref
    OR NOT EXISTS (
      SELECT 1 FROM public.job_recipe_node_claims c WHERE c.job_id = p_job AND c.node_id = p_node
        AND c.claimed_at IS NOT NULL AND c.invocation_nonce = doc ->> 'claimRef'
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.files f WHERE f.recording_id = j.recording_id
        AND f.role = 'source_mcap' AND f.purpose = 'source' AND f.state IN ('completed','verified')
        AND f.id::text = doc ->> 'sourceFileId' AND f.sha256 = doc ->> 'sourceSha256'
    )
    OR doc -> 'binding' IS DISTINCT FROM n.binding
    OR (j.execution_backend = 'modal' AND (
      NOT doc ? 'observedGpu'
      OR (n.spec #>> '{resources,gpu}' IS NULL) <> (doc ->> 'observedGpu' IS NULL)
    ))
    OR doc ->> 'status' IS DISTINCT FROM 'succeeded'
    OR p_fingerprint IS NULL
    OR j.state <> 'running'
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'successful receipt must prove this admitted execution');
  END IF;
  IF p_state = 'succeeded' THEN
    SELECT sum((SELECT count(*) FROM jsonb_each(value -> 'files'))) INTO receipt_files
      FROM jsonb_each(doc -> 'outputs');
    IF receipt_files IS NULL OR receipt_files <> jsonb_array_length(p_outputs) OR receipt_files < 1
       OR ARRAY(SELECT key FROM jsonb_each(doc -> 'outputs') ORDER BY key)
          IS DISTINCT FROM ARRAY(SELECT key FROM jsonb_each(n.spec -> 'outputs') ORDER BY key)
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_outputs) AS x(value)
         WHERE NOT EXISTS (
           SELECT 1 FROM public.files f
           JOIN public.job_output_slots s ON s.job_id = f.job_id AND s.file_id = f.id
           JOIN public.job_graph_file_verifications v ON v.file_id = f.id AND v.job_id = p_job
             AND v.node_id = p_node AND v.sha256 = f.sha256 AND v.size_bytes = f.size_bytes
           WHERE f.job_id = p_job AND f.recording_id = j.recording_id
             AND f.id::text = x.value ->> 'fileId' AND f.purpose = 'output'
             AND f.state IN ('completed','verified') AND f.size_bytes = f.observed_size_bytes
             AND f.size_bytes::text = x.value ->> 'sizeBytes' AND f.sha256 = x.value ->> 'sha256'
             AND s.slot = 'nodes/' || p_node || '/' || (x.value ->> 'name')
             AND public.graph_output_allowed(p_job,p_node,x.value ->> 'name',f.role)
             AND n.spec #>> ARRAY['outputs',x.value ->> 'port'] = x.value ->> 'artifactType'
             AND doc #>> ARRAY['outputs',x.value ->> 'port','kind'] = x.value ->> 'artifactType'
             AND doc #>> ARRAY['outputs',x.value ->> 'port','files',x.value ->> 'logicalFile','name'] = x.value ->> 'name'
             AND doc #>> ARRAY['outputs',x.value ->> 'port','files',x.value ->> 'logicalFile','sha256'] = f.sha256
             AND doc #>> ARRAY['outputs',x.value ->> 'port','files',x.value ->> 'logicalFile','sizeBytes'] = f.size_bytes::text
         )
       ) THEN
      PERFORM public.catalog_raise('SAC04', 'result outputs must match the complete verified node inventory');
    END IF;
  ELSIF jsonb_array_length(p_outputs) <> 0 OR p_receipt IS NOT NULL OR p_fingerprint IS NOT NULL THEN
    PERFORM public.catalog_raise('SAC04', 'failed node settlement does not attach unverified output');
  END IF;
  INSERT INTO public.job_recipe_node_results
    (job_id,node_id,state,error_code,receipt,receipt_bytes,receipt_sha256,fingerprint_sha256)
  VALUES (p_job,p_node,p_state,p_error,doc,p_receipt,digest,p_fingerprint);
  INSERT INTO public.job_recipe_node_outputs
    (job_id,node_id,port,artifact_type,file_id,sha256,size_bytes)
  SELECT p_job,p_node,value ->> 'port',value ->> 'artifactType',
    (value ->> 'fileId')::uuid,value ->> 'sha256',(value ->> 'sizeBytes')::bigint
  FROM jsonb_array_elements(p_outputs);
END $$;
REVOKE ALL ON FUNCTION public.job_graph_record_result(uuid,text,text,text,text,text,jsonb,text) FROM PUBLIC;


CREATE TABLE public.job_graph_seals (
  job_id uuid PRIMARY KEY REFERENCES public.job_recipe_graphs (job_id),
  nonce text NOT NULL UNIQUE CHECK (nonce ~ '^[A-Za-z0-9_-]{43}$')
);
CREATE TRIGGER job_graph_seals_immutable
  BEFORE UPDATE OR DELETE ON public.job_graph_seals
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();

CREATE FUNCTION public.job_graph_settled(p_job uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.job_recipe_graphs WHERE job_id = p_job)
    AND NOT EXISTS (
      SELECT 1 FROM public.job_recipe_nodes n LEFT JOIN public.job_recipe_node_results r USING(job_id,node_id)
      WHERE n.job_id = p_job AND r.job_id IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.job_recipe_node_claims c LEFT JOIN public.job_recipe_node_evidence e USING(job_id,node_id)
      WHERE c.job_id = p_job AND (e.job_id IS NULL OR e.execution_ref IS DISTINCT FROM c.execution_ref)
    )
$$;

CREATE FUNCTION public.job_graph_seal(p_job uuid,p_owner text,p_nonce text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  existing text;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job FOR UPDATE;
  IF j.state <> 'running' OR j.controller_lease_owner IS DISTINCT FROM p_owner
    OR j.controller_lease_expires_at <= clock_timestamp() OR j.execution_deadline <= clock_timestamp()
    OR NOT public.job_is_current(j.id) OR NOT public.job_graph_settled(p_job)
    OR NOT EXISTS (SELECT 1 FROM public.dispatch_admission WHERE job_id = p_job) THEN
    PERFORM public.catalog_raise('SAC04', 'graph assembly requires settled executions and the current lease');
  END IF;
  INSERT INTO public.job_graph_seals(job_id,nonce) VALUES (p_job,p_nonce) ON CONFLICT (job_id) DO NOTHING;
  SELECT nonce INTO existing FROM public.job_graph_seals WHERE job_id = p_job;
  RETURN existing;
END $$;
REVOKE ALL ON FUNCTION public.job_graph_seal(uuid,text,text) FROM PUBLIC;

CREATE FUNCTION public.graph_output_in_inventory(p_job uuid,p_file uuid,p_role text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_role = 'result_manifest'
    OR NOT EXISTS (SELECT 1 FROM public.job_recipe_graphs WHERE job_id = p_job)
    OR EXISTS (SELECT 1 FROM public.job_recipe_node_outputs WHERE job_id = p_job AND file_id = p_file)
$$;

CREATE VIEW public.job_recipe_graph_definitions AS
SELECT job_id, recipe_ref, recipe_sha256, graph FROM public.job_recipe_graphs;

CREATE VIEW public.job_recipe_node_read_status AS
SELECT n.job_id, n.node_id, CASE
  WHEN r.state = 'succeeded' AND (
    coalesce((coalesce(r.receipt,original.receipt) #>> '{counts,failed_windows}')::bigint,0) > 0
    OR coalesce((coalesce(r.receipt,original.receipt) #>> '{counts,failed_captions}')::bigint,0) > 0
  ) THEN 'partially_complete'
  WHEN r.reuse_job_id IS NOT NULL THEN 'reused'
  WHEN r.state IS NOT NULL THEN r.state
  WHEN c.job_id IS NULL THEN 'not_run'
  WHEN c.submission_started_at IS NULL THEN 'queued' ELSE 'running' END AS state
FROM public.job_recipe_nodes n
LEFT JOIN public.job_recipe_node_results r USING(job_id,node_id)
LEFT JOIN public.job_recipe_node_claims c USING(job_id,node_id)
LEFT JOIN public.job_recipe_node_results original ON original.job_id = r.reuse_job_id AND original.node_id = r.node_id;

CREATE FUNCTION public.stateaction_grant_recipe_graph_history(p_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON public.job_legacy_recipe_nodes, public.job_legacy_recipe_outputs, public.job_recipe_graph_definitions, public.job_recipe_node_read_status, public.job_effective_execution_status FROM %I', p_role);
  EXECUTE format('GRANT SELECT ON public.job_legacy_recipe_nodes, public.job_legacy_recipe_outputs, public.job_recipe_graph_definitions, public.job_recipe_node_read_status, public.job_effective_execution_status TO %I', p_role);
END $$;

REVOKE ALL ON FUNCTION public.stateaction_grant_recipe_graph_history(name) FROM PUBLIC;

CREATE FUNCTION public.stateaction_grant_recipe_graph_app(p_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON public.job_recipe_graphs, public.job_recipe_nodes, public.job_recipe_node_claims, public.job_recipe_node_evidence, public.job_recipe_node_results, public.job_recipe_node_outputs, public.job_graph_seals FROM %I', p_role);
  EXECUTE format('GRANT SELECT ON public.job_recipe_graphs, public.job_recipe_nodes, public.job_recipe_node_claims, public.job_recipe_node_evidence, public.job_recipe_node_results, public.job_recipe_node_outputs, public.job_graph_seals TO %I', p_role);
  EXECUTE format('REVOKE ALL ON public.job_graph_file_verifications FROM %I', p_role);
  EXECUTE format('GRANT SELECT ON public.job_graph_file_verifications TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.job_graph_verify_file(uuid,text,text,uuid,text,text,bigint) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.job_graph_begin_submission(uuid,text,text), public.job_graph_bind_call(uuid,text,text,text), public.job_graph_record_terminal(uuid,text,text,text,text,jsonb) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.job_graph_seal(uuid,text,text) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.job_graph_reserve_copies(uuid,text), public.job_graph_finish_copies(uuid,text) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.job_graph_take_claim(uuid,text,text,text,text,text,text) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.job_graph_record_result(uuid,text,text,text,text,text,jsonb,text) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.job_graph_issue_claim(uuid,text,text,jsonb,text,integer) TO %I', p_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.job_pin_recipe_graph(uuid,jsonb,jsonb) TO %I', p_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_recipe_graph_app(name) FROM PUBLIC;

DO $$
DECLARE constraint_name name;
BEGIN
  SELECT conname INTO STRICT constraint_name FROM pg_constraint
  WHERE conrelid = 'public.recording_capture_profiles'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%recipeId%';
  EXECUTE format('ALTER TABLE public.recording_capture_profiles DROP CONSTRAINT %I', constraint_name);
END $$;
ALTER TABLE public.recording_capture_profiles ADD CONSTRAINT capture_profile_recipe_identity
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
      AND jsonb_typeof(recipe) = 'object' AND (
        recipe ->> 'recipeId' = recipe_id OR
        (recipe ->> 'schema' = 'stateaction.compiled-recipe/v1'
         AND recipe ->> 'recipe' = recipe_id AND recipe ->> 'recipeSha256' = recipe_sha256)
      )
  ) IS TRUE);

CREATE OR REPLACE FUNCTION public.job_seal_nonce(p_job uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.job_recipe_graphs WHERE job_id = j.id)
         THEN (SELECT nonce FROM public.job_graph_seals WHERE job_id = j.id)
         WHEN j.recipe IS NULL THEN j.invocation_nonce
         ELSE coalesce(
           (SELECT c.invocation_nonce FROM public.job_stage_claims c
            WHERE c.job_id = j.id AND c.stage = 'hand_pose'),
           (SELECT c.invocation_nonce FROM public.job_stage_claims c
            JOIN public.job_stage_evidence e ON e.job_id = c.job_id AND e.stage = c.stage
            WHERE c.job_id = j.id AND c.call_id = e.execution_ref AND j.derived_from_job_id IS NOT NULL
              AND EXISTS (SELECT 1 FROM public.job_stage_reuse r WHERE r.job_id = j.id
                AND r.stage = 'hand_pose' AND r.state = 'succeeded')
              AND public.job_recipe_stages_settled(j.id)
            ORDER BY public.job_stage_ord(c.stage) DESC LIMIT 1)
         ) END
  FROM public.jobs j WHERE j.id = p_job
$$;

CREATE OR REPLACE FUNCTION public.job_output_inventory_digest(p_job uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT encode(sha256(convert_to(coalesce(string_agg(
    s.slot || ':' || f.id::text || ':' || f.role || ':' || f.size_bytes::text || ':' || f.sha256,
    E'\n' ORDER BY s.slot), ''), 'UTF8')), 'hex')
  FROM public.files f JOIN public.job_output_slots s ON s.file_id = f.id AND s.job_id = f.job_id
  WHERE f.job_id = p_job AND f.purpose = 'output' AND public.graph_output_in_inventory(p_job,f.id,f.role)
$$;


DO $$
DECLARE con record;
BEGIN
  FOR con IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.job_execution_evidence'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%pre_submission_rejected%'
  LOOP
    EXECUTE format('ALTER TABLE public.job_execution_evidence DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;
ALTER TABLE public.job_execution_evidence
  ADD CONSTRAINT job_execution_evidence_kind CHECK (kind IN (
    'local_child_reaped','provider_call_terminal','pre_submission_rejected','graph_nodes_terminal')),
  ADD CONSTRAINT job_execution_evidence_reference CHECK (
    (kind IN ('pre_submission_rejected','graph_nodes_terminal')) = (execution_ref IS NULL)
  );
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
  graph boolean;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = NEW.job_id FOR UPDATE;
  SELECT * INTO limits FROM public.job_inputs WHERE job_id = NEW.job_id;
  IF NOT FOUND OR j.state <> 'running' OR j.claimed_at IS NULL
     OR public.job_seal_nonce(NEW.job_id) IS DISTINCT FROM NEW.invocation_nonce THEN
    PERFORM public.catalog_raise('SAC04', 'outputs close only for the running claimed invocation');
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.job_recipe_graphs WHERE job_id = NEW.job_id) INTO graph;
  IF graph AND NOT public.job_graph_settled(NEW.job_id) THEN
    PERFORM public.catalog_raise('SAC04', 'graph output closure needs settled node evidence');
  END IF;
  SELECT count(*), coalesce(sum(f.size_bytes), 0),
         count(*) FILTER (WHERE f.role = 'result_manifest'),
         count(*) FILTER (WHERE f.state NOT IN ('completed', 'verified'))
    INTO n_files, n_bytes, n_manifest, n_open
  FROM public.files f WHERE f.job_id = NEW.job_id AND f.purpose = 'output' AND public.graph_output_in_inventory(NEW.job_id,f.id,f.role);
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
    WHERE f.job_id = NEW.job_id AND f.purpose = 'output' AND public.graph_output_in_inventory(NEW.job_id,f.id,f.role)
      AND (s.slot IS NULL OR NOT public.job_output_slot_role_ok(s.slot, f.role)
           OR (NOT graph AND j.kind = 'clip_plan' AND f.role NOT IN ('recording_mp4','result_manifest'))
           OR (j.kind = 'clip_pipeline' AND f.role = 'recording_mp4')
           OR (NOT graph AND j.kind <> 'clip_plan' AND j.recipe IS NULL AND f.role IN ('segments_json', 'captions_json', 'hand_presence_json',
                                               'recording_mp4', 'diagnostic_blob')))
  ) THEN
    PERFORM public.catalog_raise('SAC03', 'output slot does not match the intended role');
  END IF;
  -- Legacy clip slots carry six distinct roles per contiguous ordinal.
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
  IF graph THEN
    SELECT count(*) INTO n_ordinals FROM public.job_recipe_node_outputs o
    JOIN public.files f ON f.id = o.file_id AND f.job_id = o.job_id
    WHERE o.job_id = NEW.job_id AND o.artifact_type = 'hand_pose@2' AND f.role = 'clip_mp4';
    n_clip_files := 6 * n_ordinals;
    max_ordinal := n_ordinals - 1;
  END IF;
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
         AND public.graph_output_in_inventory(NEW.job_id,f.id,f.role)
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

ALTER TABLE public.jobs DROP CONSTRAINT jobs_annotation_counts_accepted;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_annotation_counts_accepted CHECK (
  segment_count IS NULL OR (
    state = 'succeeded' AND (recipe IS NOT NULL OR kind IN ('cached_import', 'clip_pipeline'))
  )
);

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
                  AND public.graph_output_in_inventory(NEW.id,f.id,f.role)
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
    IF NEW.kind = 'clip_pipeline' AND EXISTS (
        SELECT 1 FROM public.job_recipe_graphs g WHERE g.job_id = NEW.id
    ) THEN
      counts := c.verified_counts;
      IF counts IS NULL OR (NEW.segment_count, NEW.failed_window_count, NEW.caption_count, NEW.caption_failed_count)
             IS DISTINCT FROM ((counts ->> 'segmentCount')::integer, (counts ->> 'failedWindowCount')::integer,
                               (counts ->> 'captionCount')::integer, (counts ->> 'captionFailedCount')::integer)
         OR NOT public.job_graph_settled(NEW.id) THEN
        PERFORM public.catalog_raise('SAC04', 'graph clip success requires verified annotations and settled execution');
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.clip_plan_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.plan_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.jobs j
    JOIN public.job_result_candidates c ON c.job_id = j.id AND c.status = 'accepted'
    LEFT JOIN public.job_output_slots s ON s.job_id = j.id AND s.file_id = NEW.original_mp4_file_id
      AND (s.slot = 'recording.mp4' OR EXISTS (
        SELECT 1 FROM public.job_recipe_node_outputs o
        WHERE o.job_id = j.id AND o.file_id = s.file_id AND o.artifact_type = 'review_video@1'
      ))
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

CREATE OR REPLACE FUNCTION public.job_execution_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  latest_call text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.catalog_raise('SAC01', 'execution evidence is append-only');
  END IF;
  SELECT * INTO j FROM public.jobs WHERE id = NEW.job_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.dispatch_admission WHERE slot = 1 AND job_id = NEW.job_id) THEN
    PERFORM public.catalog_raise('SAC04', 'evidence applies only to the job holding the admission slot');
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_recipe_graphs WHERE job_id = NEW.job_id)
     AND NEW.kind <> 'pre_submission_rejected' THEN
    IF NEW.kind <> 'graph_nodes_terminal' OR NOT public.job_graph_settled(NEW.job_id)
       OR j.controller_lease_owner IS DISTINCT FROM NEW.recorded_by
       OR j.controller_lease_expires_at <= clock_timestamp() THEN
      PERFORM public.catalog_raise('SAC04', 'graph evidence requires exact node proofs and the current lease');
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.kind = 'graph_nodes_terminal' THEN
    PERFORM public.catalog_raise('SAC04', 'job has no admitted graph');
  END IF;
  IF NEW.kind = 'pre_submission_rejected' THEN
    IF j.submission_intent_at IS NOT NULL OR j.execution_call_id IS NOT NULL
       OR j.invocation_nonce IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.job_recipe_node_claims c WHERE c.job_id = NEW.job_id)
       OR EXISTS (SELECT 1 FROM public.job_stage_claims c WHERE c.job_id = NEW.job_id) THEN
      PERFORM public.catalog_raise('SAC04', 'a submitted job cannot be released as never submitted');
    END IF;
  ELSE
    IF j.recipe IS NULL THEN
      IF j.execution_call_id IS DISTINCT FROM NEW.execution_ref THEN
        PERFORM public.catalog_raise('SAC04', 'evidence must name the exact recorded execution');
      END IF;
    ELSE
      SELECT coalesce(c.call_id, r.call_id) INTO latest_call
      FROM public.job_stage_claims c
      LEFT JOIN public.job_stage_runs r ON r.job_id = c.job_id AND r.stage = c.stage
      WHERE c.job_id = NEW.job_id
      ORDER BY public.job_stage_ord(c.stage) DESC LIMIT 1;
      IF latest_call IS NULL OR latest_call IS DISTINCT FROM NEW.execution_ref THEN
        PERFORM public.catalog_raise('SAC04', 'evidence must name the call of the latest issued stage');
      END IF;
      -- Every issued stage claim (spawn intent) has proof for its exact call
      -- (job_stage_evidence), not only the latest: no stage call can outlive
      -- the admission slot. A claim whose call is unknown blocks release.
      IF EXISTS (SELECT 1 FROM public.job_stage_claims c
                 WHERE c.job_id = NEW.job_id
                   AND NOT EXISTS (SELECT 1 FROM public.job_stage_evidence e
                                   WHERE e.job_id = c.job_id AND e.stage = c.stage
                                     AND e.execution_ref = public.job_stage_call(c.job_id, c.stage))) THEN
        PERFORM public.catalog_raise('SAC04', 'every issued stage needs terminal evidence for its call');
      END IF;
    END IF;
    IF (NEW.kind = 'local_child_reaped') IS DISTINCT FROM (j.execution_backend = 'local') THEN
      PERFORM public.catalog_raise('SAC04', 'evidence kind does not match the job execution backend');
    END IF;
  END IF;
  RETURN NEW;
END $$;


CREATE FUNCTION public.job_graph_record_presubmission_results() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.job_recipe_node_results (job_id,node_id,state,error_code)
  SELECT n.job_id,n.node_id,'skipped','never_submitted'
  FROM public.job_recipe_nodes n WHERE n.job_id = NEW.job_id
  ON CONFLICT (job_id,node_id) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.job_graph_record_presubmission_results() FROM PUBLIC;
CREATE TRIGGER job_graph_presubmission_results AFTER INSERT ON public.job_execution_evidence
  FOR EACH ROW WHEN (NEW.kind = 'pre_submission_rejected')
  EXECUTE FUNCTION public.job_graph_record_presubmission_results();


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
      AND (p.recipe IS NOT NULL OR public.job_graph_settled(p.id) OR EXISTS (
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

ALTER TABLE public.job_rerun_copies ALTER COLUMN stage DROP NOT NULL;
ALTER TABLE public.job_rerun_copies ADD COLUMN node_id text,
  ADD CONSTRAINT job_copy_scope_exactly_one CHECK ((stage IS NULL) <> (node_id IS NULL)),
  ADD FOREIGN KEY (job_id,node_id) REFERENCES public.job_recipe_nodes (job_id,node_id);

CREATE OR REPLACE FUNCTION public.job_rerun_copy_slot_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.node_id IS NOT NULL THEN
    IF split_part(NEW.slot,'/',2) IS DISTINCT FROM NEW.node_id OR NOT EXISTS (
      SELECT 1 FROM public.jobs child
      JOIN public.job_rerun_plans t ON t.job_id = child.id
      JOIN public.job_recipe_node_outputs o ON o.job_id = child.derived_from_job_id
        AND o.node_id = NEW.node_id AND o.file_id = NEW.source_file_id
      JOIN public.job_recipe_node_results r ON r.job_id = o.job_id AND r.node_id = o.node_id
      LEFT JOIN public.job_recipe_node_results basis ON basis.job_id = r.reuse_job_id AND basis.node_id = r.node_id
      JOIN public.job_output_slots s ON s.job_id = o.job_id AND s.file_id = o.file_id AND s.slot = NEW.slot
      WHERE child.id = NEW.job_id AND r.state = 'succeeded' AND o.sha256 = NEW.sha256
        AND o.size_bytes = NEW.size_bytes AND child.derived_from_job_id = NEW.source_job_id
        AND t.plan ->> 'schemaVersion' = '3'
        AND NOT (t.plan -> 'execute') ? NEW.node_id
        AND t.plan -> 'reuse' @> jsonb_build_array(jsonb_build_object(
          'nodeId',NEW.node_id,'receiptSha256',coalesce(r.receipt_sha256,basis.receipt_sha256),'fingerprintSha256',r.fingerprint_sha256))
    ) THEN
      PERFORM public.catalog_raise('SAC04', 'copy needs the confirmed graph node and exact verified origin');
    END IF;
  ELSIF NEW.stage <> (CASE
      WHEN NEW.slot = 'segments.json' THEN 'segment'
      WHEN NEW.slot = 'captions.json' THEN 'caption'
      WHEN NEW.slot LIKE 'diagnostics/%' THEN split_part(NEW.slot, '/', 2)
      ELSE 'hand_pose'
    END)
    OR NOT EXISTS (
      SELECT 1 FROM public.job_stage_reuse r
      WHERE r.job_id = NEW.job_id AND r.stage = NEW.stage AND r.state = 'succeeded'
    ) THEN
    PERFORM public.catalog_raise('SAC04', 'rerun copy requires a successful origin and its stage slot');
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION public.job_graph_reserve_copies(p_job uuid,p_owner text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  confirmed_plan jsonb;
  origin record;
  child_id uuid;
BEGIN
  PERFORM 1 FROM public.recordings r JOIN public.jobs child ON child.recording_id = r.id
  WHERE child.id = p_job FOR KEY SHARE OF r;
  SELECT * INTO j FROM public.jobs WHERE id = p_job FOR UPDATE;
  IF NOT public.job_rerun_preparation_ok(p_job,p_owner) THEN
    PERFORM public.catalog_raise('SAC04', 'graph copy reservation requires the current pre-submit lease');
  END IF;
  SELECT plan INTO confirmed_plan FROM public.job_rerun_plans WHERE job_id = p_job;
  IF confirmed_plan ->> 'schemaVersion' IS DISTINCT FROM '3' OR NOT EXISTS (
    SELECT 1 FROM public.job_recipe_graphs child JOIN public.job_recipe_graphs parent
      ON parent.job_id = j.derived_from_job_id AND parent.graph = child.graph
    WHERE child.job_id = p_job AND public.job_graph_settled(parent.job_id)
      AND child.recipe_sha256 = confirmed_plan ->> 'recipeSha256'
  ) THEN
    PERFORM public.catalog_raise('SAC04', 'retry graph changed after confirmation');
  END IF;
  FOR origin IN
    SELECT o.node_id, o.file_id, o.sha256, o.size_bytes, s.slot, f.role, f.required,
      coalesce(prior.original_job_id,o.job_id) AS original_job_id,
      coalesce(prior.original_file_id,o.file_id) AS original_file_id
    FROM public.job_recipe_node_outputs o
    JOIN public.job_output_slots s ON s.job_id = o.job_id AND s.file_id = o.file_id
    JOIN public.files f ON f.id = o.file_id AND f.job_id = o.job_id AND f.state IN ('completed','verified')
    LEFT JOIN public.job_rerun_copies prior ON prior.file_id = o.file_id
    WHERE o.job_id = j.derived_from_job_id
      AND o.node_id IN (SELECT item ->> 'nodeId' FROM jsonb_array_elements(confirmed_plan -> 'reuse') item)
      AND NOT EXISTS (SELECT 1 FROM public.job_rerun_copies c WHERE c.job_id = p_job AND c.slot = s.slot)
  LOOP
    child_id := gen_random_uuid();
    INSERT INTO public.job_rerun_copies
      (job_id,node_id,source_file_id,source_job_id,original_file_id,original_job_id,file_id,slot,role,size_bytes,sha256)
    VALUES (p_job,origin.node_id,origin.file_id,j.derived_from_job_id,
      origin.original_file_id,origin.original_job_id,child_id,origin.slot,origin.role,origin.size_bytes,origin.sha256);
    INSERT INTO public.files
      (id,recording_id,job_id,purpose,role,required,size_bytes,sha256,object_key,part_size_bytes,part_count)
    VALUES (child_id,j.recording_id,p_job,'output',origin.role,origin.required,origin.size_bytes,origin.sha256,
      'jobs/' || p_job || '/outputs/' || child_id || '/e1/' || origin.slot,origin.size_bytes,1);
    INSERT INTO public.job_output_slots(job_id,slot,file_id,request_digest)
    VALUES (p_job,origin.slot,child_id,j.source_manifest_sha256);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.job_graph_reserve_copies(uuid,text) FROM PUBLIC;

CREATE FUNCTION public.job_graph_finish_copies(p_job uuid,p_owner text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  j public.jobs;
  confirmed_plan jsonb;
  kept record;
BEGIN
  SELECT * INTO j FROM public.jobs WHERE id = p_job FOR UPDATE;
  IF NOT public.job_rerun_preparation_ok(p_job,p_owner) THEN
    PERFORM public.catalog_raise('SAC04', 'graph copy settlement requires the current pre-submit lease');
  END IF;
  SELECT plan INTO confirmed_plan FROM public.job_rerun_plans WHERE job_id = p_job;
  IF confirmed_plan ->> 'schemaVersion' IS DISTINCT FROM '3' THEN
    PERFORM public.catalog_raise('SAC04', 'job has no confirmed graph retry');
  END IF;
  FOR kept IN
    SELECT old.*
    FROM public.job_recipe_node_results old
    JOIN public.job_recipe_nodes origin USING(job_id,node_id)
    JOIN public.job_recipe_nodes target_node ON target_node.job_id = p_job AND target_node.node_id = old.node_id
      AND target_node.binding = origin.binding AND target_node.spec = origin.spec
    LEFT JOIN public.job_recipe_node_results basis ON basis.job_id = old.reuse_job_id AND basis.node_id = old.node_id
    WHERE old.job_id = j.derived_from_job_id AND old.state = 'succeeded'
      AND confirmed_plan -> 'reuse' @> jsonb_build_array(jsonb_build_object(
        'nodeId',old.node_id,'receiptSha256',coalesce(old.receipt_sha256,basis.receipt_sha256),'fingerprintSha256',old.fingerprint_sha256))
  LOOP
    IF EXISTS (SELECT 1 FROM public.job_recipe_node_results WHERE job_id = p_job AND node_id = kept.node_id) THEN
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.job_recipe_node_outputs WHERE job_id = kept.job_id AND node_id = kept.node_id
    ) OR EXISTS (
      SELECT 1 FROM public.job_recipe_node_outputs o
      WHERE o.job_id = kept.job_id AND o.node_id = kept.node_id AND NOT EXISTS (
        SELECT 1 FROM public.job_rerun_copies c
        JOIN public.files f ON f.id = c.file_id AND f.job_id = c.job_id AND f.state IN ('completed','verified')
        WHERE c.job_id = p_job AND c.node_id = o.node_id AND c.source_file_id = o.file_id AND c.target_ready
      )
    ) THEN
      PERFORM public.catalog_raise('SAC04', 'retry retained inventory is incomplete');
    END IF;
    INSERT INTO public.job_recipe_node_results
      (job_id,node_id,state,fingerprint_sha256,reuse_job_id)
    VALUES (p_job,kept.node_id,'succeeded',kept.fingerprint_sha256,coalesce(kept.reuse_job_id,kept.job_id));
    INSERT INTO public.job_recipe_node_outputs(job_id,node_id,port,artifact_type,file_id,sha256,size_bytes)
    SELECT p_job,o.node_id,o.port,o.artifact_type,c.file_id,o.sha256,o.size_bytes
    FROM public.job_recipe_node_outputs o JOIN public.job_rerun_copies c
      ON c.source_file_id = o.file_id AND c.job_id = p_job AND c.target_ready
    WHERE o.job_id = kept.job_id AND o.node_id = kept.node_id;
  END LOOP;
  IF (SELECT count(*) FROM public.job_recipe_node_results WHERE job_id = p_job AND reuse_job_id IS NOT NULL)
       <> jsonb_array_length(confirmed_plan -> 'reuse') THEN
    PERFORM public.catalog_raise('SAC04', 'confirmed retained bindings or receipts changed');
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.job_graph_finish_copies(uuid,text) FROM PUBLIC;

CREATE VIEW public.job_effective_execution_status AS
SELECT job_id,stage AS step,state FROM public.job_effective_stage_runs
UNION ALL
SELECT job_id,node_id AS step,state FROM public.job_recipe_node_results;

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
              WHERE rp.job_id = j.id AND rp.plan ->> 'schemaVersion' IN ('2','3')
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
CREATE OR REPLACE FUNCTION public.clip_rerun_may_select(
  child uuid, current_seq integer, planned_seq integer, previous uuid, parent uuid
) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT current_seq = planned_seq
    AND NOT EXISTS (
      SELECT 1 FROM public.job_effective_execution_status new_run
      WHERE new_run.job_id = child AND new_run.state IN ('failed', 'cancelled', 'skipped')
        AND NOT EXISTS (
          SELECT 1 FROM public.job_effective_execution_status prior_run
          WHERE prior_run.job_id = coalesce(previous, parent)
            AND prior_run.step = new_run.step AND prior_run.state IN ('failed', 'cancelled', 'skipped')
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.job_effective_execution_status prior_run
      WHERE prior_run.job_id = previous AND prior_run.state = 'succeeded'
        AND NOT EXISTS (
          SELECT 1 FROM public.job_effective_execution_status new_run
          WHERE new_run.job_id = child AND new_run.step = prior_run.step AND new_run.state = 'succeeded'
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
    WHERE p.job_id = NEW.job_id AND p.plan ->> 'schemaVersion' IN ('2','3');
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
