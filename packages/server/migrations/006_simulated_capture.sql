-- SA-71 explicitly labelled simulated capture (migration 006; 001-005 are immutable).
--
-- Additive only. Allows the emulator profile h264_mcap_simulation_v1 beside
-- the hardware profile h264_mcap_v1, and carries the simulation marker
-- (artifacts.simulation-provenance.v1 camelCase form, http.simulation-provenance.v1)
-- on the recording and on its immutable admission evidence. A simulated
-- recording ALWAYS has a marker; a hardware recording NEVER has one, so the
-- database cannot relabel one as the other. Whether a server may accept
-- simulated input at all is runtime configuration (APP_ENV local/development
-- plus ALLOW_SIMULATED_CAPTURE_INPUTS), not a schema property: hosted servers
-- simply never admit a row with this profile.

ALTER TABLE public.recordings DROP CONSTRAINT recordings_rgb_profile_check;
ALTER TABLE public.recordings ADD COLUMN simulation jsonb;
ALTER TABLE public.recordings ADD CONSTRAINT recordings_rgb_profile_check CHECK (
  (rgb_profile = 'h264_mcap_v1' AND simulation IS NULL)
  OR (rgb_profile = 'h264_mcap_simulation_v1' AND simulation IS NOT NULL
      AND jsonb_typeof(simulation) = 'object' AND octet_length(simulation::text) <= 4096)
);

-- The simulation marker is part of the immutable capture identity.
CREATE FUNCTION public.recordings_simulation_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.simulation IS DISTINCT FROM OLD.simulation THEN
    PERFORM public.catalog_raise('SAC01', 'recording simulation marker is immutable');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recordings_simulation_guard BEFORE UPDATE ON public.recordings
  FOR EACH ROW EXECUTE FUNCTION public.recordings_simulation_guard();

-- Admission evidence: the marker declared by the validated source manifest.
ALTER TABLE public.recording_admissions ADD COLUMN simulation jsonb;
ALTER TABLE public.recording_admissions ADD CONSTRAINT recording_admissions_simulation_check CHECK (
  outcome <> 'admitted'
  OR (rgb_profile = 'h264_mcap_v1' AND simulation IS NULL)
  OR (rgb_profile = 'h264_mcap_simulation_v1' AND simulation IS NOT NULL
      AND jsonb_typeof(simulation) = 'object' AND octet_length(simulation::text) <= 4096)
);
