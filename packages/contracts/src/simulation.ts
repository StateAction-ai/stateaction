import type {
  SimulationProvenance,
  SimulationProvenanceArtifact,
} from "./types.js";

/** Emulator-only RGB profile (SA-71). Never hardware evidence. */
export const SIMULATION_RGB_PROFILE = "h264_mcap_simulation_v1" as const;
/** The only profile the frozen v1 create/source contracts accept. */
export const HARDWARE_RGB_PROFILE = "h264_mcap_v1" as const;

/** Source contract id for a sealed recording-source document `schema` value. */
export function recordingSourceContractFor(schema: unknown): string {
  // Anything else is validated by v1, which reports unsupported_version.
  return schema === "stateaction.recording_source.v2"
    ? "artifacts.recording-source.v2"
    : "artifacts.recording-source.v1";
}

/** Create contract id for a request body; v1 bodies carry no `schema`. */
export function recordingCreateContractFor(body: unknown): string {
  return typeof body === "object" && body !== null && "schema" in body
    ? "http.recording-create.v2"
    : "http.recording-create.v1";
}

/** snake_case manifest form -> camelCase HTTP/job form (same facts). */
export function simulationFromArtifact(
  value: SimulationProvenanceArtifact,
): SimulationProvenance {
  return {
    schema: value.schema,
    qualification: value.qualification,
    mappedTimelineSemantics: value.mapped_timeline_semantics,
    productionQualified: value.production_qualified,
    provenance: {
      camera: { ...value.provenance.camera },
      encoder: { ...value.provenance.encoder },
      clock: { ...value.provenance.clock },
    },
  };
}

/** camelCase HTTP/job form -> snake_case manifest form (same facts). */
export function simulationToArtifact(
  value: SimulationProvenance,
): SimulationProvenanceArtifact {
  return {
    schema: value.schema,
    qualification: value.qualification,
    mapped_timeline_semantics: value.mappedTimelineSemantics,
    production_qualified: value.productionQualified,
    provenance: {
      camera: { ...value.provenance.camera },
      encoder: { ...value.provenance.encoder },
      clock: { ...value.provenance.clock },
    },
  };
}
