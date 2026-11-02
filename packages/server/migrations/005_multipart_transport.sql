-- SA-20 multipart transport journal (migration 005; 001-004 are immutable).
--
-- Additive only. The `files` row (SA-13) already carries the logical identity,
-- never-reused object key, epoch, provider upload ID and frozen plan; this adds
-- the durable per-part receipt journal, an init claim (so provider creation is
-- serialized outside DB transactions and an uncertain creation is reconciled
-- for the exact key rather than repeated) and idempotent worker output slots.

-- Expected byte length of one part of a frozen plan (final part may be short).
CREATE FUNCTION transport_part_length(size_bytes bigint, part_size bigint, part_no integer)
RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT LEAST(part_size, size_bytes - (part_no - 1)::bigint * part_size)
$$;

CREATE TABLE file_part_receipts (
  file_id uuid NOT NULL REFERENCES files (id),
  transport_epoch integer NOT NULL CHECK (transport_epoch >= 1),
  part_number integer NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  -- Provider receipt without quotes; NOT a content digest.
  etag text NOT NULL CHECK (length(etag) BETWEEN 1 AND 128 AND etag ~ '^[A-Za-z0-9-]+$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  -- Set when ListParts confirmed this exact ETag and size at the provider.
  corroborated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, transport_epoch, part_number)
);

CREATE FUNCTION file_part_receipts_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  f public.files%ROWTYPE;
BEGIN
  SELECT * INTO f FROM public.files WHERE id = NEW.file_id FOR SHARE;
  IF NOT FOUND THEN
    PERFORM public.catalog_raise('SAC04', 'receipt for an unknown file');
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.file_id, NEW.transport_epoch, NEW.part_number, NEW.size_bytes, NEW.created_at)
       IS DISTINCT FROM
       (OLD.file_id, OLD.transport_epoch, OLD.part_number, OLD.size_bytes, OLD.created_at) THEN
      PERFORM public.catalog_raise('SAC01', 'receipt identity and size are immutable');
    END IF;
    IF NEW.etag IS DISTINCT FROM OLD.etag AND NEW.corroborated_at <= OLD.corroborated_at THEN
      PERFORM public.catalog_raise('SAC01', 'a replaced ETag needs fresh provider corroboration');
    END IF;
  END IF;
  -- Receipts exist only for the current epoch of an uploading file, within its
  -- frozen plan, with the exact planned length: independent of the service.
  IF f.state <> 'uploading' OR f.transport_epoch <> NEW.transport_epoch
     OR f.provider_upload_id IS NULL THEN
    PERFORM public.catalog_raise('SAC04', 'file is not accepting receipts for this epoch');
  END IF;
  IF NEW.part_number > f.part_count
     OR NEW.size_bytes <> public.transport_part_length(f.size_bytes, f.part_size_bytes, NEW.part_number) THEN
    PERFORM public.catalog_raise('SAC03', 'receipt does not match the frozen part plan');
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER file_part_receipts_guard BEFORE INSERT OR UPDATE ON file_part_receipts
  FOR EACH ROW EXECUTE FUNCTION file_part_receipts_guard();

-- The provider upload ID is write-once within a transport epoch.
CREATE FUNCTION files_provider_upload_once() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.provider_upload_id IS NOT NULL AND NEW.transport_epoch = OLD.transport_epoch
     AND NEW.provider_upload_id IS DISTINCT FROM OLD.provider_upload_id THEN
    PERFORM public.catalog_raise('SAC01', 'provider upload ID is write-once per epoch');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER files_provider_upload_once BEFORE UPDATE ON files
  FOR EACH ROW EXECUTE FUNCTION files_provider_upload_once();

CREATE TABLE file_transport_claims (
  file_id uuid PRIMARY KEY REFERENCES files (id),
  transport_epoch integer NOT NULL,
  claim_token uuid NOT NULL,
  expires_at timestamptz NOT NULL
);

-- Server-chosen output slot (a safe relative path unique within the job) is the
-- idempotency identity of a worker output; the worker never picks keys.
CREATE TABLE job_output_slots (
  job_id uuid NOT NULL REFERENCES jobs (id),
  slot text NOT NULL CHECK (
    length(slot) <= 255 AND slot ~ '^[A-Za-z0-9._-]{1,128}(/[A-Za-z0-9._-]{1,128}){0,7}$'
    AND slot !~ '(^|/)\.{1,2}(/|$)'
  ),
  file_id uuid NOT NULL UNIQUE REFERENCES files (id),
  request_digest sha256_hex NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, slot)
);

CREATE FUNCTION stateaction_grant_transport(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.file_part_receipts, public.file_transport_claims, public.job_output_slots FROM %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT ON TABLE public.file_part_receipts, public.job_output_slots TO %I', app_role);
  EXECUTE format('GRANT UPDATE (etag, corroborated_at, updated_at) ON TABLE public.file_part_receipts TO %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.file_transport_claims TO %I', app_role);
END $$;
REVOKE ALL ON FUNCTION stateaction_grant_transport(name) FROM PUBLIC;
