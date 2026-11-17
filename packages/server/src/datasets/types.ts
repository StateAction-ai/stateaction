import type {
  ClipRead,
  ClipReadRole,
  ClipSimulationMarker,
  DatasetClipView,
  DatasetView,
  StaffClipView,
} from "@stateaction/contracts";

/**
 * Wire shapes of the SA-35 dataset/clip read and member operations. They are
 * the catalog.v8 contract types (@stateaction/contracts); customer shapes are
 * explicit whitelists built in queries.ts, never spread from a database row.
 */
export type {
  ClipRead as ReadGrantView,
  ClipReadRole as ReadRole,
  ClipSimulationMarker as ClipSimulation,
  DatasetClipView,
  DatasetView,
  StaffClipView,
};
export type Page<T> = { items: T[]; nextCursor: string | null };
export const READ_ROLES: readonly ClipReadRole[] = [
  "thumbnail_jpeg",
  "viewer_rrd",
];
