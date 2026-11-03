import {
  HARDWARE_RGB_PROFILE,
  SIMULATION_RGB_PROFILE,
  parseContract,
  type SimulationProvenance,
  type TaskInputV2,
} from "@stateaction/contracts";
import type { Queryable } from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";

/**
 * SA-71 downstream seam: the jobs.task-input.v2 document for one admitted
 * process_recording job. The capture profile and, for simulated captures, the
 * explicit simulation marker are read from the immutable admission evidence of
 * THIS job (never from a client claim or the live recording row), so a worker
 * can never treat simulated input as hardware and unknown provenance stays
 * explicit. The worker still verifies the marker against the actual MCAP
 * profile; this document is the server's admitted claim, not worker proof.
 */
export async function processRecordingTaskInputV2(
  q: Queryable,
  jobId: string,
): Promise<TaskInputV2> {
  const { rows } = await q.query<{
    id: string;
    recording_id: string;
    source_manifest_sha256: string;
    profile_revision: string;
    rgb_profile: string;
    simulation: SimulationProvenance | null;
  }>(
    `SELECT j.id, j.recording_id, j.source_manifest_sha256, j.profile_revision,
            a.rgb_profile, a.simulation
     FROM jobs j JOIN recording_admissions a
       ON a.recording_id = j.recording_id AND a.outcome = 'admitted'
          AND a.source_manifest_sha256 = j.source_manifest_sha256
     WHERE j.id = $1 AND j.kind = 'process_recording'`,
    [jobId],
  );
  const row = rows[0];
  if (!row) throw new CatalogError("not_found", "Job not found");
  const base = {
    schemaVersion: 2,
    jobId: row.id,
    targetId: row.recording_id,
    profileRevision: row.profile_revision,
    kind: "process_recording",
    sourceManifestSha256: row.source_manifest_sha256,
  };
  const input =
    row.rgb_profile === SIMULATION_RGB_PROFILE
      ? {
          ...base,
          rgbProfile: SIMULATION_RGB_PROFILE,
          simulation: row.simulation,
        }
      : { ...base, rgbProfile: HARDWARE_RGB_PROFILE };
  return parseContract<TaskInputV2>("jobs.task-input.v2", input);
}
