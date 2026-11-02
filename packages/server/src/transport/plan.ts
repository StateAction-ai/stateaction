/**
 * Frozen multipart plan. The server derives it from the declared size; no
 * client can choose part sizes, ranges, counts or keys.
 */
export const PART_SIZE_BYTES = 67_108_864n; // 64 MiB
export const MAX_PARTS = 10_000;
export const MAX_SIGN_BATCH = 32;
export const MAX_FILE_BYTES = 107_374_182_400n; // 100 GiB transport cap
/** R2/S3 abort unfinished uploads after seven days (lifecycle from initiation). */
export const TRANSPORT_LIFETIME_MS = 7 * 24 * 3600 * 1000;
export const URL_TTL_SECONDS = 3600;

export type PartPlan = {
  sizeBytes: bigint;
  partSizeBytes: bigint;
  partCount: number;
};
export type PartRange = {
  partNumber: number;
  offsetBytes: bigint;
  lengthBytes: bigint;
};

export function planFor(sizeBytes: bigint): PartPlan {
  if (sizeBytes < 1n || sizeBytes > MAX_FILE_BYTES)
    throw new RangeError("sizeBytes is outside the transport cap");
  const partCount = Number(
    (sizeBytes + PART_SIZE_BYTES - 1n) / PART_SIZE_BYTES,
  );
  if (partCount > MAX_PARTS) throw new RangeError("Too many parts");
  return { sizeBytes, partSizeBytes: PART_SIZE_BYTES, partCount };
}

export function partRange(plan: PartPlan, partNumber: number): PartRange {
  if (
    !Number.isInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > plan.partCount
  )
    throw new RangeError(`part ${partNumber} is outside the plan`);
  const offsetBytes = BigInt(partNumber - 1) * plan.partSizeBytes;
  const remaining = plan.sizeBytes - offsetBytes;
  return {
    partNumber,
    offsetBytes,
    lengthBytes:
      remaining < plan.partSizeBytes ? remaining : plan.partSizeBytes,
  };
}

/** Provider ETags are opaque receipts: strip optional quotes, never interpret. */
export function normalizeEtag(etag: string): string {
  return etag.replace(/^"(.*)"$/, "$1");
}
