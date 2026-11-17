-- SA-35 recipient-sharing evidence for dataset view grants (migration 008;
-- 001-007 are immutable).
--
-- Additive only. An operator (owner credential, never the web role) records
-- permission for EXTERNAL INSPECTION of one dataset by one named recipient.
-- Evidence is separate from capture/processing permission (ingest_permissions):
-- capture-only evidence, a UI checkbox or a client claim can never create it.
-- Evidence never blanket-authorizes future clips: the operator also records a
-- per-clip CLEARANCE (dataset_sharing_clearances) bound to that evidence row.
-- A view grant (dataset_access) can only be enabled against ACTIVE evidence for
-- the same (dataset, recipient) with every current approved member cleared; a
-- clip can only join a dataset if EVERY enabled recipient's evidence is active
-- and has cleared that clip; and customer reads join evidence + clearance on
-- every request, so revoking evidence hides the data on the next read.
--
-- Lock order (extends docs/components/catalog.md): 1. clip locks (sorted);
-- 2. dataset rows (FOR UPDATE; the sharing guard takes FOR SHARE so direct
-- inserts also serialize with grants); 3. evidence rows FOR SHARE. Revocation
-- only updates the evidence row, so it waits for holders of FOR SHARE and
-- cannot deadlock with them. SQLSTATE classes are those of 003.

-- 1. dataset_sharing_permissions: operator-recorded evidence. Identity and
-- coverage are immutable; status moves one way, active -> revoked. A renewed
-- approval is a new row with a new permission_ref.
CREATE TABLE public.dataset_sharing_permissions (
  id uuid PRIMARY KEY,
  permission_ref text NOT NULL UNIQUE
    CHECK (permission_ref ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
  dataset_id uuid NOT NULL REFERENCES public.datasets (id),
  recipient_user_id text NOT NULL REFERENCES public."user" ("id") ON DELETE RESTRICT,
  -- Must be true: the row exists only to record external-inspection cover.
  covers_external_inspection boolean NOT NULL CHECK (covers_external_inspection),
  -- Reference to the operator's evidence document (never the document itself).
  evidence_ref text NOT NULL CHECK (length(btrim(evidence_ref)) BETWEEN 1 AND 500),
  recorded_by text NOT NULL CHECK (length(btrim(recorded_by)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revoked_by text CHECK (length(btrim(revoked_by)) BETWEEN 1 AND 200),
  revocation_reason text CHECK (length(revocation_reason) <= 1000),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, dataset_id, recipient_user_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_by IS NOT NULL))
);
-- One live approval per (dataset, recipient).
CREATE UNIQUE INDEX dataset_sharing_permissions_one_active_idx
  ON public.dataset_sharing_permissions (dataset_id, recipient_user_id)
  WHERE status = 'active';
CREATE INDEX dataset_sharing_permissions_recipient_idx
  ON public.dataset_sharing_permissions (recipient_user_id, dataset_id);

CREATE FUNCTION public.dataset_sharing_permissions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.catalog_raise('SAC01', 'sharing permission evidence is retained (revoke instead)');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.revoked_at IS NOT NULL THEN
      PERFORM public.catalog_raise('SAC04', 'sharing permissions are recorded active');
    END IF;
    IF NOT public.catalog_has_role(NEW.recipient_user_id, 'customer') THEN
      PERFORM public.catalog_raise('SAC05', 'sharing permission recipients are enabled customers');
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.permission_ref, NEW.dataset_id, NEW.recipient_user_id,
      NEW.covers_external_inspection, NEW.evidence_ref, NEW.recorded_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.permission_ref, OLD.dataset_id, OLD.recipient_user_id,
      OLD.covers_external_inspection, OLD.evidence_ref, OLD.recorded_by, OLD.created_at) THEN
    PERFORM public.catalog_raise('SAC01', 'sharing permission identity and coverage are immutable');
  END IF;
  IF OLD.status = 'revoked' OR NEW.status <> 'revoked' THEN
    PERFORM public.catalog_raise('SAC04', 'sharing permission status only moves from active to revoked');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dataset_sharing_permissions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.dataset_sharing_permissions
  FOR EACH ROW EXECUTE FUNCTION public.dataset_sharing_permissions_guard();

-- 1b. dataset_sharing_clearances: the operator's per-clip confirmation that
-- one approved clip is cleared for the recipient of ONE evidence row. Append
-- only; it dies with its evidence (revocation) because every read and every
-- addition also requires the evidence row to be active.
CREATE TABLE public.dataset_sharing_clearances (
  permission_id uuid NOT NULL REFERENCES public.dataset_sharing_permissions (id),
  clip_id uuid NOT NULL REFERENCES public.clips (id),
  cleared_by text NOT NULL CHECK (length(btrim(cleared_by)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (permission_id, clip_id)
);
CREATE INDEX dataset_sharing_clearances_clip_idx
  ON public.dataset_sharing_clearances (clip_id, permission_id);

CREATE FUNCTION public.dataset_sharing_clearances_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  evidence_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.catalog_raise('SAC01', 'sharing clearances are append-only (revoke the evidence instead)');
  END IF;
  -- Lock order: clip lock first, then the evidence row.
  PERFORM public.catalog_lock_clip(NEW.clip_id);
  IF public.catalog_latest_decision(NEW.clip_id) IS DISTINCT FROM 'approved' THEN
    PERFORM public.catalog_raise('SAC02', 'only clips whose latest review is approved can be cleared for sharing');
  END IF;
  SELECT status INTO evidence_status FROM public.dataset_sharing_permissions
  WHERE id = NEW.permission_id FOR SHARE;
  IF evidence_status IS DISTINCT FROM 'active' THEN
    PERFORM public.catalog_raise('SAC05', 'clearance needs active recipient-sharing permission');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dataset_sharing_clearances_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.dataset_sharing_clearances
  FOR EACH ROW EXECUTE FUNCTION public.dataset_sharing_clearances_guard();

-- 2. dataset_access now points at its evidence. Nullable so earlier rows stay
-- readable to operators, but a grant without active evidence is never
-- effective: reads join the evidence row and the guard below refuses to
-- enable such a grant.
ALTER TABLE public.dataset_access ADD COLUMN sharing_permission_id uuid;
ALTER TABLE public.dataset_access ADD FOREIGN KEY (sharing_permission_id, dataset_id, user_id)
  REFERENCES public.dataset_sharing_permissions (id, dataset_id, recipient_user_id);
CREATE INDEX dataset_access_permission_idx ON public.dataset_access (sharing_permission_id)
  WHERE sharing_permission_id IS NOT NULL;

CREATE FUNCTION public.dataset_access_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  evidence_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.dataset_id, NEW.user_id, NEW.created_at)
     IS DISTINCT FROM (OLD.dataset_id, OLD.user_id, OLD.created_at) THEN
    PERFORM public.catalog_raise('SAC01', 'dataset grant identity is immutable');
  END IF;
  IF NEW.enabled THEN
    IF NEW.sharing_permission_id IS NULL THEN
      PERFORM public.catalog_raise('SAC05', 'a view grant needs recorded recipient-sharing permission');
    END IF;
    -- FOR SHARE serializes with a concurrent revocation of this evidence.
    SELECT status INTO evidence_status FROM public.dataset_sharing_permissions
    WHERE id = NEW.sharing_permission_id AND dataset_id = NEW.dataset_id
      AND recipient_user_id = NEW.user_id FOR SHARE;
    IF evidence_status IS DISTINCT FROM 'active' THEN
      PERFORM public.catalog_raise('SAC05', 'recipient-sharing permission must be active to enable a view grant');
    END IF;
    IF NOT public.catalog_has_role(NEW.user_id, 'customer') THEN
      PERFORM public.catalog_raise('SAC05', 'dataset access is granted to enabled customers');
    END IF;
    -- Serialize with membership writes, then require every currently
    -- approved member to be cleared by this exact evidence.
    PERFORM 1 FROM public.datasets WHERE id = NEW.dataset_id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM public.dataset_clips dc
      WHERE dc.dataset_id = NEW.dataset_id
        AND public.catalog_latest_decision(dc.clip_id) = 'approved'
        AND NOT EXISTS (
          SELECT 1 FROM public.dataset_sharing_clearances sc
          WHERE sc.permission_id = NEW.sharing_permission_id AND sc.clip_id = dc.clip_id)
    ) THEN
      PERFORM public.catalog_raise('SAC05', 'every current approved member must be cleared for this recipient before granting');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dataset_access_guard BEFORE INSERT OR UPDATE ON public.dataset_access
  FOR EACH ROW EXECUTE FUNCTION public.dataset_access_guard();

-- Revoking evidence disables every grant that rests on it, in the same
-- statement transaction. (Reads also join the evidence row, so visibility is
-- gone even before this runs.)
CREATE FUNCTION public.dataset_sharing_permissions_revoked() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status = 'revoked' THEN
    UPDATE public.dataset_access SET enabled = false, updated_at = now()
    WHERE sharing_permission_id = NEW.id AND enabled;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER dataset_sharing_permissions_revoked
  AFTER UPDATE ON public.dataset_sharing_permissions
  FOR EACH ROW EXECUTE FUNCTION public.dataset_sharing_permissions_revoked();

-- 3. The staff-callable grant routine now needs evidence: p_evidence_ref is
-- the permission_ref of an ACTIVE evidence row for exactly this
-- (dataset, recipient); the dataset_access guard additionally requires every
-- current approved member to be cleared. The web role no longer holds EXECUTE (see
-- stateaction_grant_datasets): grants are an operator action with the owner
-- credential, naming the enabled staff member on whose behalf it is made.
-- Disabling needs no evidence and keeps the recorded reference.
CREATE OR REPLACE FUNCTION public.catalog_set_dataset_access(
  p_dataset_id uuid, p_user_id text, p_enabled boolean,
  p_actor_user_id text, p_evidence_ref text
) RETURNS public.dataset_access
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  result public.dataset_access;
  evidence uuid;
BEGIN
  IF NOT public.catalog_has_role(p_actor_user_id, 'staff') THEN
    PERFORM public.catalog_raise('SAC05', 'only enabled staff may change dataset access');
  END IF;
  -- Serializes with membership writes (lock order step 2, no clip locks).
  PERFORM 1 FROM public.datasets WHERE id = p_dataset_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'dataset not found';
  END IF;
  IF p_enabled THEN
    IF NOT public.catalog_has_role(p_user_id, 'customer') THEN
      PERFORM public.catalog_raise('SAC05', 'dataset access is granted to enabled customers');
    END IF;
    SELECT id INTO evidence FROM public.dataset_sharing_permissions
    WHERE dataset_id = p_dataset_id AND recipient_user_id = p_user_id
      AND permission_ref = p_evidence_ref AND status = 'active' FOR SHARE;
    IF evidence IS NULL THEN
      PERFORM public.catalog_raise('SAC05',
        'record active recipient-sharing permission for this dataset and recipient before granting');
    END IF;
  END IF;
  INSERT INTO public.dataset_access AS d
    (dataset_id, user_id, enabled, granted_by, permission_evidence_ref, sharing_permission_id)
  VALUES (p_dataset_id, p_user_id, p_enabled, p_actor_user_id, p_evidence_ref, evidence)
  ON CONFLICT (dataset_id, user_id) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        granted_by = EXCLUDED.granted_by,
        permission_evidence_ref = CASE WHEN EXCLUDED.enabled
          THEN EXCLUDED.permission_evidence_ref ELSE d.permission_evidence_ref END,
        sharing_permission_id = CASE WHEN EXCLUDED.enabled
          THEN EXCLUDED.sharing_permission_id ELSE d.sharing_permission_id END,
        updated_at = now()
  RETURNING d.* INTO result;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.catalog_set_dataset_access(uuid, text, boolean, text, text) FROM PUBLIC;

-- 4. Additions to an already shared dataset need current evidence AND a
-- clearance of this exact clip for EVERY enabled recipient. SECURITY DEFINER
-- because FOR SHARE needs a table privilege the web role must not hold; it
-- locks and reads, returning a boolean.
CREATE FUNCTION public.dataset_sharing_ok(p_dataset uuid, p_clip uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.datasets WHERE id = p_dataset FOR SHARE;
  PERFORM 1 FROM public.dataset_sharing_permissions p
    JOIN public.dataset_access da ON da.sharing_permission_id = p.id
    WHERE da.dataset_id = p_dataset AND da.enabled
    FOR SHARE OF p;
  RETURN NOT EXISTS (
    SELECT 1 FROM public.dataset_access da
    LEFT JOIN public.dataset_sharing_permissions p ON p.id = da.sharing_permission_id
    WHERE da.dataset_id = p_dataset AND da.enabled
      AND (p.id IS NULL OR p.status <> 'active'
           OR NOT EXISTS (
             SELECT 1 FROM public.dataset_sharing_clearances sc
             WHERE sc.permission_id = p.id AND sc.clip_id = p_clip))
  );
END $$;
REVOKE ALL ON FUNCTION public.dataset_sharing_ok(uuid, uuid) FROM PUBLIC;

CREATE FUNCTION public.dataset_clips_sharing_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.dataset_sharing_ok(NEW.dataset_id, NEW.clip_id) THEN
    PERFORM public.catalog_raise('SAC05',
      'this dataset is shared: every enabled recipient needs active sharing permission clearing this clip before it is added');
  END IF;
  RETURN NEW;
END $$;
-- Fires after dataset_clips_insert_guard (alphabetical), i.e. after the clip
-- lock and approved-only check, matching lock order step 1 -> 2 -> 3.
CREATE TRIGGER dataset_clips_sharing_guard BEFORE INSERT ON public.dataset_clips
  FOR EACH ROW EXECUTE FUNCTION public.dataset_clips_sharing_guard();

-- ------------------------------------------------------------- privileges
-- Feature helper called by the migrator after the baseline helper. The web
-- role reads evidence (customer reads join it) but never writes it, and loses
-- the staff-callable grant routine: grants are operator-only.
CREATE FUNCTION public.stateaction_grant_datasets(app_role name) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE public.dataset_sharing_permissions, public.dataset_sharing_clearances FROM %I', app_role);
  EXECUTE format('GRANT SELECT ON TABLE public.dataset_sharing_permissions, public.dataset_sharing_clearances TO %I', app_role);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.dataset_sharing_ok(uuid, uuid) TO %I', app_role);
  EXECUTE format('REVOKE ALL ON FUNCTION public.catalog_set_dataset_access(uuid, text, boolean, text, text) FROM %I', app_role);
END $$;
REVOKE ALL ON FUNCTION public.stateaction_grant_datasets(name) FROM PUBLIC;
