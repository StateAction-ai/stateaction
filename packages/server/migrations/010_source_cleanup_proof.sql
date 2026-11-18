-- SA-73 staff-confirmed cloud source copy and original-owner cleanup proofs (migration 010).
-- Additive only: 001-009 are unchanged. Every function pins
-- search_path = pg_catalog, public, pg_temp and schema-qualifies relations.
--
-- Invariants enforced by the database (not only by application code):
--   * source_copy_confirmations: append-only, at most one per recording. A row
--     exists only if, at insert time, the confirmer holds an enabled staff role,
--     the recording is sealed, reviewable with a succeeded current job, still
--     under active ingest-permission evidence, and the evidence inventory equals
--     BOTH the sealed inventory and the live source file rows (ids, roles, sizes,
--     SHA-256, required flags; no extra, no missing).
--   * source_cleanup_proofs: append-only issuance audit. A row exists only for a
--     current confirmation of the same recording/owner/seal/manifest, for the
--     recording's original owner holding an enabled collector role, and a server
--     expiry of at most 120 seconds. There is no UPDATE/DELETE privilege on
--     either table and nothing here can delete a source file or object.
-- SQLSTATE classes reused from 003: SAC01 immutable, SAC04 lifecycle, SAC05 authorization.

-- The seal digest (recording_seals.request_sha256) is a stable identity that
-- confirmations reference together with the recording.
ALTER TABLE public.recording_seals
  ADD CONSTRAINT recording_seals_recording_request_key UNIQUE (recording_id, request_sha256);

-- ------------------------------------------------------------------ policy
-- A recording's sealed source copy may be confirmed/proved only when processing
-- was accepted AND permission evidence is still active. Reviewable is a
-- precondition, never approval.
CREATE FUNCTION public.source_cleanup_eligible(p_recording uuid) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.recordings r
    JOIN public.recording_seals s ON s.recording_id = r.id
      AND s.source_manifest_sha256 = r.source_manifest_sha256
    JOIN public.recording_registrations g ON g.recording_id = r.id AND g.owner_user_id = r.owner_user_id
    JOIN public.jobs j ON j.id = r.current_job_id AND j.recording_id = r.id
    WHERE r.id = p_recording AND r.deleted_at IS NULL AND r.status = 'reviewable'
      AND r.source_manifest_file_id IS NOT NULL AND j.state = 'succeeded'
      AND public.ingest_permission_ok(g.ingest_permission_id, r.owner_user_id, true)
  )
$$;

-- p_files (file id, role, required, size and SHA-256 evidence) must equal the
-- sealed inventory and the live source rows exactly.
CREATE FUNCTION public.source_cleanup_inventory_ok(p_recording uuid, p_files jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  seal jsonb;
  n integer;
BEGIN
  IF p_files IS NULL OR jsonb_typeof(p_files) <> 'array' THEN RETURN false; END IF;
  SELECT inventory INTO seal FROM public.recording_seals WHERE recording_id = p_recording;
  IF seal IS NULL THEN RETURN false; END IF;
  n := jsonb_array_length(seal);
  IF jsonb_array_length(p_files) <> n THEN RETURN false; END IF;
  -- Evidence ids are unique.
  IF (SELECT count(DISTINCT e ->> 'fileId') FROM jsonb_array_elements(p_files) e) <> n THEN
    RETURN false;
  END IF;
  -- Every sealed entry has identical evidence and an identical live completed row.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(seal) i
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_files) e
      WHERE e ->> 'fileId' = i ->> 'fileId' AND e ->> 'role' = i ->> 'role'
        AND e ->> 'sizeBytes' = i ->> 'sizeBytes' AND e ->> 'sha256' = i ->> 'sha256'
        AND (e ->> 'required')::boolean = (i ->> 'required')::boolean
    ) OR NOT EXISTS (
      SELECT 1 FROM public.files f
      WHERE f.id = (i ->> 'fileId')::uuid AND f.recording_id = p_recording AND f.purpose = 'source'
        AND f.state IN ('completed', 'verified') AND f.role = i ->> 'role'
        AND f.size_bytes = (i ->> 'sizeBytes')::bigint AND f.sha256 = i ->> 'sha256'
        AND f.required = (i ->> 'required')::boolean
        AND f.observed_size_bytes = f.size_bytes
    )
  ) THEN RETURN false; END IF;
  -- No other live source file exists for the recording.
  IF (SELECT count(*) FROM public.files f
      WHERE f.recording_id = p_recording AND f.purpose = 'source'
        AND f.state NOT IN ('cancelled', 'failed', 'expired')) <> n THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;

-- ----------------------------------------------------------- confirmations
CREATE TABLE public.source_copy_confirmations (
  id uuid PRIMARY KEY,
  recording_id uuid NOT NULL UNIQUE,
  owner_user_id text NOT NULL,
  seal_sha256 public.sha256_hex NOT NULL,
  source_manifest_file_id uuid NOT NULL,
  source_manifest_sha256 public.sha256_hex NOT NULL,
  file_count integer NOT NULL CHECK (file_count BETWEEN 3 AND 2000),
  total_bytes bigint NOT NULL CHECK (total_bytes >= 3),
  -- Per file: fileId, role, required, sizeBytes, sha256 (all re-hashed from
  -- the stored object bytes at EOF before this row could be written).
  files jsonb NOT NULL CHECK (
    jsonb_typeof(files) = 'array'
    AND jsonb_array_length(files) BETWEEN 3 AND 2000
    AND octet_length(files::text) <= 1048576
  ),
  confirmed_by_user_id text NOT NULL REFERENCES public."user" ("id") ON DELETE RESTRICT,
  verified_at timestamptz NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, recording_id, owner_user_id, seal_sha256, source_manifest_sha256),
  FOREIGN KEY (recording_id, owner_user_id) REFERENCES public.recordings (id, owner_user_id),
  FOREIGN KEY (recording_id, seal_sha256)
    REFERENCES public.recording_seals (recording_id, request_sha256),
  FOREIGN KEY (recording_id, source_manifest_sha256)
    REFERENCES public.recordings (id, source_manifest_sha256),
  FOREIGN KEY (source_manifest_file_id, recording_id, source_manifest_sha256)
    REFERENCES public.files (id, recording_id, sha256)
);
CREATE TRIGGER source_copy_confirmations_immutable BEFORE UPDATE OR DELETE ON public.source_copy_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();

CREATE FUNCTION public.source_copy_confirmations_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  n_bytes bigint;
BEGIN
  IF NOT public.catalog_has_role(NEW.confirmed_by_user_id, 'staff') THEN
    PERFORM public.catalog_raise('SAC05', 'confirming a source copy needs an enabled staff role');
  END IF;
  IF NOT public.source_cleanup_eligible(NEW.recording_id) THEN
    PERFORM public.catalog_raise('SAC04', 'the recording is not reviewable with accepted processing and active permission evidence');
  END IF;
  IF NOT public.source_cleanup_inventory_ok(NEW.recording_id, NEW.files) THEN
    PERFORM public.catalog_raise('SAC04', 'the confirmation evidence does not equal the sealed inventory and live source files');
  END IF;
  SELECT sum((e ->> 'sizeBytes')::bigint) INTO n_bytes FROM jsonb_array_elements(NEW.files) e;
  IF NEW.file_count <> jsonb_array_length(NEW.files) OR NEW.total_bytes <> n_bytes
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.files) e
                    WHERE e ->> 'fileId' = NEW.source_manifest_file_id::text
                      AND e ->> 'role' = 'source_manifest'
                      AND e ->> 'sha256' = NEW.source_manifest_sha256) THEN
    PERFORM public.catalog_raise('SAC04', 'the confirmation totals or manifest identity do not match its evidence');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_copy_confirmations_guard BEFORE INSERT ON public.source_copy_confirmations
  FOR EACH ROW EXECUTE FUNCTION public.source_copy_confirmations_guard();

-- ------------------------------------------------------------------ proofs
CREATE TABLE public.source_cleanup_proofs (
  id uuid PRIMARY KEY,
  confirmation_id uuid NOT NULL,
  recording_id uuid NOT NULL,
  owner_user_id text NOT NULL,
  seal_sha256 public.sha256_hex NOT NULL,
  source_manifest_sha256 public.sha256_hex NOT NULL,
  -- The only freshness mode: every included object was streamed and hashed again.
  verification text NOT NULL CHECK (verification = 'rehash'),
  file_count integer NOT NULL CHECK (file_count BETWEEN 3 AND 2000),
  total_bytes bigint NOT NULL CHECK (total_bytes >= 3),
  files jsonb NOT NULL CHECK (
    jsonb_typeof(files) = 'array'
    AND jsonb_array_length(files) BETWEEN 3 AND 2000
    AND octet_length(files::text) <= 1048576
  ),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '120 seconds'),
  FOREIGN KEY (confirmation_id, recording_id, owner_user_id, seal_sha256, source_manifest_sha256)
    REFERENCES public.source_copy_confirmations (id, recording_id, owner_user_id, seal_sha256, source_manifest_sha256)
);
CREATE INDEX source_cleanup_proofs_recording_idx ON public.source_cleanup_proofs (recording_id, issued_at DESC);
CREATE TRIGGER source_cleanup_proofs_immutable BEFORE UPDATE OR DELETE ON public.source_cleanup_proofs
  FOR EACH ROW EXECUTE FUNCTION public.catalog_forbid_change();

CREATE FUNCTION public.source_cleanup_proofs_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c public.source_copy_confirmations;
BEGIN
  IF NOT public.catalog_has_role(NEW.owner_user_id, 'collector') THEN
    PERFORM public.catalog_raise('SAC05', 'a cleanup proof needs the original owner to hold an enabled collector role');
  END IF;
  SELECT * INTO c FROM public.source_copy_confirmations WHERE id = NEW.confirmation_id;
  IF c.id IS NULL OR c.recording_id <> NEW.recording_id OR c.owner_user_id <> NEW.owner_user_id THEN
    PERFORM public.catalog_raise('SAC04', 'a cleanup proof needs the recording''s staff confirmation');
  END IF;
  IF NOT public.source_cleanup_eligible(NEW.recording_id) THEN
    PERFORM public.catalog_raise('SAC04', 'the recording is no longer eligible for a cleanup proof');
  END IF;
  -- The live sealed copy is still exactly what staff confirmed, and the freshly
  -- hashed evidence equals the confirmed evidence.
  IF NOT public.source_cleanup_inventory_ok(NEW.recording_id, c.files)
     OR NOT public.source_cleanup_inventory_ok(NEW.recording_id, NEW.files)
     OR NEW.file_count <> c.file_count OR NEW.total_bytes <> c.total_bytes THEN
    PERFORM public.catalog_raise('SAC04', 'the cleanup proof does not match the confirmed sealed inventory');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_cleanup_proofs_guard BEFORE INSERT ON public.source_cleanup_proofs
  FOR EACH ROW EXECUTE FUNCTION public.source_cleanup_proofs_guard();

-- ------------------------------------------------------------- privileges
CREATE FUNCTION public.stateaction_grant_source_cleanup(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.source_copy_confirmations, public.source_cleanup_proofs FROM %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT ON TABLE public.source_copy_confirmations, public.source_cleanup_proofs TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_source_cleanup(name) FROM PUBLIC;
