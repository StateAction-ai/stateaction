-- SA-19 ingest admission: operator-recorded pilot permission evidence,
-- registration/seal idempotency records and validated admission evidence.
-- Additive only: 001-003 are unchanged. Every function pins
-- search_path = pg_catalog, public, pg_temp and schema-qualifies relations.
--
-- Lock order (extends docs/components/catalog.md): 1. recording row FOR UPDATE;
-- 2. (source file rows); 3. ingest_permissions row FOR SHARE. Revocation only
-- updates the permission row, so it serializes with any registration or
-- admission holding FOR SHARE and can never deadlock with them.
-- SQLSTATE classes reused from 003: SAC01 immutable, SAC04 lifecycle,
-- SAC05 not authorized.

-- (recording, owner) pair so dependent rows can pin the immutable owner.
ALTER TABLE public.recordings ADD CONSTRAINT recordings_id_owner_key UNIQUE (id, owner_user_id);

-- 1. ingest_permissions: pilot permission evidence recorded by an operator
-- (owner credential only) before collection is enabled. Coverage must include
-- both capture and automated processing for admission. Identity is immutable;
-- status moves one way from active to revoked. A renewed approval is a new row
-- with a new permission_ref.
CREATE TABLE public.ingest_permissions (
  id uuid PRIMARY KEY,
  permission_ref text NOT NULL UNIQUE
    CHECK (permission_ref ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
  owner_user_id text NOT NULL REFERENCES public."user" ("id") ON DELETE RESTRICT,
  pilot_scope text NOT NULL CHECK (length(btrim(pilot_scope)) BETWEEN 1 AND 120),
  covers_capture boolean NOT NULL,
  covers_processing boolean NOT NULL,
  -- Reference to the operator's evidence document (never the document itself).
  evidence_ref text NOT NULL CHECK (length(btrim(evidence_ref)) BETWEEN 1 AND 500),
  recorded_by text NOT NULL CHECK (length(btrim(recorded_by)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revoked_by text CHECK (length(btrim(revoked_by)) BETWEEN 1 AND 200),
  revocation_reason text CHECK (length(revocation_reason) <= 1000),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_user_id, permission_ref),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_by IS NOT NULL))
);
-- Registration binds the owner's single active approval.
CREATE UNIQUE INDEX ingest_permissions_one_active_per_owner_idx
  ON public.ingest_permissions (owner_user_id) WHERE status = 'active';

CREATE FUNCTION public.ingest_permissions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.catalog_raise('SAC01', 'ingest permission evidence is retained (revoke instead)');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.revoked_at IS NOT NULL THEN
      PERFORM public.catalog_raise('SAC04', 'ingest permissions are recorded active');
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.permission_ref, NEW.owner_user_id, NEW.pilot_scope, NEW.covers_capture,
      NEW.covers_processing, NEW.evidence_ref, NEW.recorded_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.permission_ref, OLD.owner_user_id, OLD.pilot_scope, OLD.covers_capture,
      OLD.covers_processing, OLD.evidence_ref, OLD.recorded_by, OLD.created_at) THEN
    PERFORM public.catalog_raise('SAC01', 'ingest permission identity and coverage are immutable');
  END IF;
  IF OLD.status = 'revoked' OR NEW.status <> 'revoked' THEN
    PERFORM public.catalog_raise('SAC04', 'ingest permission status only moves from active to revoked');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ingest_permissions_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ingest_permissions
  FOR EACH ROW EXECUTE FUNCTION public.ingest_permissions_guard();

-- Locks the permission row FOR SHARE (serializing with revocation) and checks
-- it is active, owned by the owner and covers the requested scope. SECURITY
-- DEFINER only because FOR SHARE needs a table privilege the web role must
-- not hold; it reads and locks one row and returns a boolean.
CREATE FUNCTION public.ingest_permission_ok(
  p_permission uuid, p_owner text, p_need_processing boolean
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  found_row public.ingest_permissions;
BEGIN
  SELECT * INTO found_row FROM public.ingest_permissions
  WHERE id = p_permission AND owner_user_id = p_owner FOR SHARE;
  RETURN found_row.id IS NOT NULL AND found_row.status = 'active' AND found_row.covers_capture
    AND (NOT p_need_processing OR found_row.covers_processing);
END $$;
REVOKE ALL ON FUNCTION public.ingest_permission_ok(uuid, text, boolean) FROM PUBLIC;

-- 2. recording_registrations: the sa-cjson-v1 digest of the exact create
-- request and the approval bound at registration. Immutable.
CREATE TABLE public.recording_registrations (
  recording_id uuid PRIMARY KEY,
  owner_user_id text NOT NULL,
  request_sha256 public.sha256_hex NOT NULL,
  ingest_permission_id uuid NOT NULL,
  permission_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (recording_id, owner_user_id)
    REFERENCES public.recordings (id, owner_user_id),
  FOREIGN KEY (ingest_permission_id, owner_user_id, permission_ref)
    REFERENCES public.ingest_permissions (id, owner_user_id, permission_ref)
);
CREATE INDEX recording_registrations_permission_idx
  ON public.recording_registrations (ingest_permission_id);

CREATE FUNCTION public.recording_registrations_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.ingest_permission_ok(NEW.ingest_permission_id, NEW.owner_user_id, false) THEN
    PERFORM public.catalog_raise('SAC05', 'registration needs active capture permission evidence for the owner');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recording_registrations_guard BEFORE INSERT ON public.recording_registrations
  FOR EACH ROW EXECUTE FUNCTION public.recording_registrations_guard();
CREATE TRIGGER recording_registrations_immutable BEFORE UPDATE OR DELETE ON public.recording_registrations
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();

-- 3. recording_seals: the normalized (fileId-sorted) seal inventory and its
-- sa-cjson-v1 digest, so a replay in any order succeeds and a changed seal
-- conflicts. Inserted in the sealing transaction, after the pointer is set.
CREATE TABLE public.recording_seals (
  recording_id uuid PRIMARY KEY,
  request_sha256 public.sha256_hex NOT NULL,
  source_manifest_sha256 public.sha256_hex NOT NULL,
  inventory jsonb NOT NULL CHECK (
    jsonb_typeof(inventory) = 'array'
    AND jsonb_array_length(inventory) BETWEEN 3 AND 2000
    AND octet_length(inventory::text) <= 1048576
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (recording_id) REFERENCES public.recording_registrations (recording_id),
  FOREIGN KEY (recording_id, source_manifest_sha256)
    REFERENCES public.recordings (id, source_manifest_sha256)
);
CREATE TRIGGER recording_seals_immutable BEFORE UPDATE OR DELETE ON public.recording_seals
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();

-- 4. recording_admissions: one durable outcome per sealed recording. An
-- admitted row carries the validated source-declaration evidence and names the
-- only admissible first job; it is written in the same transaction as, and
-- before, that job (the jobs trigger requires it). A rejected row carries a
-- stable code and is written only for a deterministic defect of manifest
-- bytes whose digest matches the pinned seal digest. Immutable.
CREATE TABLE public.recording_admissions (
  recording_id uuid PRIMARY KEY,
  source_manifest_sha256 public.sha256_hex NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('admitted', 'rejected')),
  rejection_code text CHECK (rejection_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  job_id uuid UNIQUE,
  ingest_permission_id uuid,
  permission_ref text,
  capture_format text,
  rgb_profile text,
  capture_config_sha256 public.sha256_hex,
  close_status text CHECK (close_status IN ('closed_clean', 'closed_after_recovery')),
  -- Bounded copies of the declaration evidence (no media, no sample arrays).
  clock_domains jsonb CHECK (clock_domains IS NULL OR (
    jsonb_typeof(clock_domains) = 'array' AND jsonb_array_length(clock_domains) BETWEEN 1 AND 16)),
  declared_files jsonb CHECK (declared_files IS NULL OR (
    jsonb_typeof(declared_files) = 'array' AND jsonb_array_length(declared_files) BETWEEN 2 AND 2000
    AND octet_length(declared_files::text) <= 1048576)),
  calibration_file_ids uuid[] CHECK (cardinality(calibration_file_ids) <= 2000),
  counts jsonb CHECK (counts IS NULL OR (jsonb_typeof(counts) = 'object' AND octet_length(counts::text) <= 1024)),
  channel_count integer CHECK (channel_count BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (recording_id) REFERENCES public.recording_seals (recording_id),
  FOREIGN KEY (recording_id, source_manifest_sha256)
    REFERENCES public.recordings (id, source_manifest_sha256),
  CHECK (
    (outcome = 'admitted' AND job_id IS NOT NULL AND rejection_code IS NULL
      AND ingest_permission_id IS NOT NULL AND permission_ref IS NOT NULL
      AND capture_format IS NOT NULL AND rgb_profile IS NOT NULL
      AND capture_config_sha256 IS NOT NULL AND close_status IS NOT NULL
      AND clock_domains IS NOT NULL AND declared_files IS NOT NULL
      AND calibration_file_ids IS NOT NULL AND counts IS NOT NULL AND channel_count IS NOT NULL)
    OR (outcome = 'rejected' AND job_id IS NULL AND rejection_code IS NOT NULL)
  )
);

CREATE FUNCTION public.recording_admissions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  reg public.recording_registrations;
BEGIN
  IF NEW.outcome = 'admitted' THEN
    SELECT * INTO reg FROM public.recording_registrations WHERE recording_id = NEW.recording_id;
    IF reg.recording_id IS NULL
       OR reg.ingest_permission_id IS DISTINCT FROM NEW.ingest_permission_id
       OR reg.permission_ref IS DISTINCT FROM NEW.permission_ref
       OR NOT public.ingest_permission_ok(reg.ingest_permission_id, reg.owner_user_id, true) THEN
      PERFORM public.catalog_raise('SAC05', 'admission needs the registered, active capture and processing permission');
    END IF;
    IF EXISTS (SELECT 1 FROM public.jobs WHERE recording_id = NEW.recording_id) THEN
      PERFORM public.catalog_raise('SAC04', 'admission precedes the first job of a recording');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recording_admissions_guard BEFORE INSERT ON public.recording_admissions
  FOR EACH ROW EXECUTE FUNCTION public.recording_admissions_guard();
CREATE TRIGGER recording_admissions_immutable BEFORE UPDATE OR DELETE ON public.recording_admissions
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();

-- Fail closed for every job insert, whatever credential or helper issues it:
-- the recording must have a registration bound to permission evidence that is
-- active and covers capture and processing (locked FOR SHARE, serializing with
-- revocation) and an admitted admission. The first attempt must be exactly
-- the admitted job with the admitted source digest; retries need the same
-- admitted recording. Records created before 004 (or by the SA-13 helper)
-- without this evidence stay readable but cannot be processed until an
-- explicit operator/fixture step establishes it; nothing is auto-adopted.
CREATE FUNCTION public.jobs_ingest_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  reg public.recording_registrations;
  adm public.recording_admissions;
BEGIN
  -- Other kinds are rejected by the jobs CHECK constraint itself.
  IF NEW.kind IS DISTINCT FROM 'process_recording' THEN
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
     OR (NEW.previous_job_id IS NULL AND adm.job_id IS DISTINCT FROM NEW.id) THEN
    PERFORM public.catalog_raise('SAC04', 'processing needs validated admission evidence for this job');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_ingest_guard BEFORE INSERT ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_ingest_guard();

-- ------------------------------------------------------------- privileges
-- The 003 helper keeps its body; the public name now also covers 004 tables.
-- The migrator keeps calling stateaction_grant_app_role(role) after every run.
ALTER FUNCTION public.stateaction_grant_app_role(name) RENAME TO stateaction_grant_app_role_003;
REVOKE ALL ON FUNCTION public.stateaction_grant_app_role_003(name) FROM PUBLIC;

CREATE FUNCTION public.stateaction_grant_app_role(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  t text;
BEGIN
  PERFORM public.stateaction_grant_app_role_003(app_role);
  FOREACH t IN ARRAY ARRAY[
    'ingest_permissions', 'recording_registrations', 'recording_seals', 'recording_admissions'
  ] LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', t, app_role);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO %I', t, app_role);
  END LOOP;
  -- Evidence is operator-managed: the web role only reads ingest_permissions.
  EXECUTE format('GRANT INSERT ON TABLE public.recording_registrations, public.recording_seals, public.recording_admissions TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.ingest_permission_ok(uuid, text, boolean) TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_app_role(name) FROM PUBLIC;
