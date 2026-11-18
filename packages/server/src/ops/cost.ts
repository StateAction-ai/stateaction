import { UNKNOWN, wrap, type Measured } from "./redact.js";
import type { OpsReceipt } from "./receipt.js";

/**
 * Gross per-run estimate from OPERATOR-SUPPLIED or primary-source-cited rates.
 * No rate, multiplier or price is defined in code: without a card every charge
 * is unknown. The result is an estimate, never an invoice, and spend alerts
 * built on it are not billing hard caps.
 */
export const RATE_ITEMS = [
  "cpu_core_second",
  "memory_gib_second",
  "disk_gib_second",
  "transfer_gb",
  "storage_gb_month",
] as const;
export type RateItem = (typeof RATE_ITEMS)[number];

/**
 * The exact unit each rate item is priced in. A rate whose declared unit is not
 * this string is rejected: a "per minute" or "per hour" amount must be converted
 * by the operator (and stated in assumptions), never silently priced per second.
 * Gigabytes are decimal (10^9 bytes); GiB are binary.
 */
export const RATE_UNITS: Record<RateItem, string> = {
  cpu_core_second: "core-second",
  memory_gib_second: "GiB-second",
  disk_gib_second: "GiB-second",
  transfer_gb: "GB",
  storage_gb_month: "GB-month",
};

/** Every charge category an operator should know about; rated or listed as unknown. */
export const CHARGE_CATEGORIES = [
  "cpu_core_second",
  "memory_gib_second",
  "disk_gib_second",
  "transfer_gb",
  "storage_gb_month",
  "provider_request_fees",
  "transfer_retries",
  "viewer_fetch",
  "render_workflow_compute",
  "database",
] as const;

export type RateCard = {
  currency: string;
  /**
   * Operator-supplied free text (NOT log data): bounded printable ASCII, rejected
   * when it looks like a credential or URL query, echoed back only as operator data.
   */
  assumptions: string[];
  rates: Partial<
    Record<
      RateItem,
      {
        amount: number;
        unit: string;
        source: {
          kind: "operator" | "provider_doc";
          ref: string;
          retrievedAt: string;
        };
      }
    >
  >;
  /** Applied to cpu+memory only when the operator states one (e.g. a documented premium). */
  computeMultiplier?: { value: number; reason: string };
  allocation?: { cpuCores: number; memoryGiB: number; diskGiB: number };
  /** Fixed platform floor: reported separately from per-run usage, never summed into it. */
  platformFloor: { item: string; amountPerMonth: number }[];
  storageMonths?: number;
};

export class RateCardError extends Error {
  constructor(readonly field: string) {
    super(`invalid rate card field: ${field}`);
  }
}

const TEXT = /^[\x20-\x7e]{1,200}$/;
/** Credential/signed-URL shapes that must never be stored or echoed (defence in depth). */
const SECRETISH =
  /(?:^|[^a-z])(?:sig|signature|token|secret|password|passwd|cookie|credential|apikey|api[_-]?key|authorization|bearer|x-amz-[a-z-]+)\s*[=:]|[?&][a-z0-9_-]+=|sa_(?:svc|tok|key)_|:\/\/[^/\s]*@|[A-Za-z0-9+\/_-]{32,}/i;
const ITEM = /^[a-z0-9][a-z0-9_ -]{0,63}$/i;
const MAX_RATE = 1e6;

const num = (v: unknown, field: string, max = MAX_RATE): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max)
    throw new RateCardError(field);
  return v;
};
const text = (v: unknown, field: string): string => {
  if (typeof v !== "string" || !TEXT.test(v) || SECRETISH.test(v))
    throw new RateCardError(field);
  return v;
};
const obj = (v: unknown, field: string): Record<string, unknown> => {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new RateCardError(field);
  return v as Record<string, unknown>;
};
/** https URL without credentials, query or fragment (signed URLs cannot pass). */
function cleanRef(v: unknown, field: string): string {
  const s = text(v, field);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new RateCardError(field);
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    s.includes("?") ||
    s.includes("#")
  )
    throw new RateCardError(field);
  return s;
}

/** A real calendar date (YYYY-MM-DD), 2020-01-01 or later, not in the future. */
function validDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return (
    Number.isFinite(ms) &&
    new Date(ms).toISOString().startsWith(v) &&
    ms >= Date.parse("2020-01-01T00:00:00Z") &&
    ms <= Date.now() + 86_400_000
  );
}

/** Strict, closed reader. Throws a RateCardError naming a field only, never the value. */
export function readRateCard(raw: unknown): RateCard {
  const r = obj(raw, "card");
  const allowed = new Set([
    "currency",
    "assumptions",
    "rates",
    "computeMultiplier",
    "allocation",
    "platformFloor",
    "storageMonths",
  ]);
  if (Object.keys(r).some((k) => !allowed.has(k)))
    throw new RateCardError("card");
  const currency = text(r.currency, "currency");
  if (!/^[A-Z]{3}$/.test(currency)) throw new RateCardError("currency");
  const assumptions = Array.isArray(r.assumptions) ? r.assumptions : [];
  if (assumptions.length > 20) throw new RateCardError("assumptions");
  const rates: RateCard["rates"] = {};
  const given = obj(r.rates ?? {}, "rates");
  for (const [item, v] of Object.entries(given)) {
    if (!(RATE_ITEMS as readonly string[]).includes(item))
      throw new RateCardError("rates");
    const e = obj(v, `rates.${item}`);
    const src = obj(e.source, `rates.${item}.source`);
    const kind = src.kind;
    if (kind !== "operator" && kind !== "provider_doc")
      throw new RateCardError(`rates.${item}.source.kind`);
    const retrievedAt = text(
      src.retrievedAt,
      `rates.${item}.source.retrievedAt`,
    );
    if (!validDate(retrievedAt))
      throw new RateCardError(`rates.${item}.source.retrievedAt`);
    if (e.unit !== RATE_UNITS[item as RateItem])
      throw new RateCardError(`rates.${item}.unit`);
    rates[item as RateItem] = {
      amount: num(e.amount, `rates.${item}.amount`),
      unit: RATE_UNITS[item as RateItem],
      source: {
        kind,
        ref: cleanRef(src.ref, `rates.${item}.source.ref`),
        retrievedAt,
      },
    };
  }
  const card: RateCard = {
    currency,
    assumptions: assumptions.map((a, i) => text(a, `assumptions.${i}`)),
    rates,
    platformFloor: [],
  };
  if (r.computeMultiplier !== undefined) {
    const m = obj(r.computeMultiplier, "computeMultiplier");
    card.computeMultiplier = {
      value: num(m.value, "computeMultiplier.value", 100),
      reason: text(m.reason, "computeMultiplier.reason"),
    };
  }
  if (r.allocation !== undefined) {
    const a = obj(r.allocation, "allocation");
    card.allocation = {
      cpuCores: num(a.cpuCores, "allocation.cpuCores", 1024),
      memoryGiB: num(a.memoryGiB, "allocation.memoryGiB", 4096),
      diskGiB: num(a.diskGiB, "allocation.diskGiB", 65536),
    };
  }
  if (r.storageMonths !== undefined)
    card.storageMonths = num(r.storageMonths, "storageMonths", 1200);
  const floor = Array.isArray(r.platformFloor) ? r.platformFloor : [];
  if (floor.length > 20) throw new RateCardError("platformFloor");
  card.platformFloor = floor.map((f, i) => {
    const e = obj(f, `platformFloor.${i}`);
    const item = text(e.item, `platformFloor.${i}.item`);
    if (!ITEM.test(item)) throw new RateCardError(`platformFloor.${i}.item`);
    return {
      item,
      amountPerMonth: num(
        e.amountPerMonth,
        `platformFloor.${i}.amountPerMonth`,
      ),
    };
  });
  return card;
}

/**
 * What a quantity actually is. Never blurred:
 * - `allocated_x_measured_wall`: configured billing allocation times the
 *   worker's measured wall seconds. Allocation is not process RSS or scratch use,
 *   and wall excludes provisioning/cold start, so it is a lower bound.
 * - `retained_bytes_<basis>`: bytes persisted/declared for sealed objects. This
 *   is not measured network transfer; retries and viewer fetches are unknown.
 */
export type QuantityKind =
  | "allocated_x_measured_wall"
  | "retained_bytes_verified"
  | "retained_bytes_uploaded"
  | "retained_bytes_declared"
  | "unknown";

export type CostLine = {
  item: (typeof CHARGE_CATEGORIES)[number];
  quantity: Measured<number>;
  quantityKind: QuantityKind;
  /** True when the true quantity is at least this (unknown extra usage exists). */
  lowerBound: boolean;
  unit: string | null;
  rate: Measured<number>;
  amount: Measured<number>;
  basis: string;
};

export type CostEstimate = {
  kind: "gross_estimate_not_billing";
  currency: string | null;
  lines: CostLine[];
  /** Sum of the computable lines. A lower bound while any charge is unknown. */
  grossKnown: Measured<number>;
  unknownCharges: string[];
  complete: boolean;
  /** Operator-supplied text from the rate card, echoed as data (not log content). */
  operatorAssumptions: string[];
};

const GB = 1_000_000_000; // decimal gigabyte; stated so the unit is unambiguous

type Bytes = { value: Measured<number>; kind: QuantityKind };

/** One basis for a role, strongest available; the basis is reported, never hidden. */
function retained(
  receipt: OpsReceipt,
  role: "output" | "rrd" | "source",
): Bytes {
  for (const basis of ["verified", "uploaded", "declared"] as const) {
    const v = receipt.bytes[role][basis];
    if (v.status === "measured")
      return { value: v, kind: `retained_bytes_${basis}` };
  }
  return { value: UNKNOWN, kind: "unknown" };
}

const WEAKEST: QuantityKind[] = [
  "retained_bytes_declared",
  "retained_bytes_uploaded",
  "retained_bytes_verified",
];

function combine(parts: Bytes[], scale = 1): Bytes {
  if (parts.some((p) => p.value.status !== "measured"))
    return { value: UNKNOWN, kind: "unknown" };
  const kind = parts
    .map((p) => p.kind)
    .sort((x, y) => WEAKEST.indexOf(x) - WEAKEST.indexOf(y))[0]!;
  const total = parts.reduce(
    (sum, p) => sum + (p.value.status === "measured" ? p.value.value : 0),
    0,
  );
  return { value: wrap((total / GB) * scale), kind };
}

export function estimateRun(
  receipt: OpsReceipt,
  card?: RateCard,
): CostEstimate {
  const lines: CostLine[] = [];
  const wall = receipt.worker.wallSeconds;
  const add = (
    item: CostLine["item"],
    quantity: Measured<number>,
    quantityKind: QuantityKind,
    basis: string,
    lowerBound: boolean,
  ) => {
    const rate = item in RATE_UNITS ? card?.rates[item as RateItem] : undefined;
    const common = { item, quantity, quantityKind, lowerBound, basis };
    if (!rate || quantity.status !== "measured") {
      lines.push({
        ...common,
        unit: rate?.unit ?? null,
        rate: rate ? wrap(rate.amount) : UNKNOWN,
        amount: UNKNOWN,
      });
      return;
    }
    const mult =
      item === "cpu_core_second" || item === "memory_gib_second"
        ? (card?.computeMultiplier?.value ?? 1)
        : 1;
    lines.push({
      ...common,
      unit: rate.unit,
      rate: wrap(rate.amount),
      amount: wrap(quantity.value * rate.amount * mult),
    });
  };
  const alloc = card?.allocation;
  const per = (n: number | undefined): Measured<number> =>
    wall.status === "measured" && n !== undefined
      ? wrap(wall.value * n)
      : UNKNOWN;
  const compute = (n: number | undefined) =>
    per(n).status === "measured" ? "allocated_x_measured_wall" : "unknown";
  const wallBasis = (what: string) =>
    `measured worker wall x configured ${what} allocation (billing allocation, not process RSS/CPU/scratch use; wall excludes provisioning)`;
  add(
    "cpu_core_second",
    per(alloc?.cpuCores),
    compute(alloc?.cpuCores),
    wallBasis("CPU"),
    true,
  );
  add(
    "memory_gib_second",
    per(alloc?.memoryGiB),
    compute(alloc?.memoryGiB),
    wallBasis("memory"),
    true,
  );
  add(
    "disk_gib_second",
    per(alloc?.diskGiB),
    compute(alloc?.diskGiB),
    wallBasis("scratch disk"),
    true,
  );
  const transfer = combine([
    retained(receipt, "source"),
    retained(receipt, "output"),
    retained(receipt, "rrd"),
  ]);
  add(
    "transfer_gb",
    transfer.value,
    transfer.kind,
    "retained source + output + RRD bytes counted once (assumption; not measured transfer: retries and viewer fetches are separate unknown lines)",
    true,
  );
  const stored = [retained(receipt, "output"), retained(receipt, "rrd")];
  const storage =
    card?.storageMonths === undefined
      ? ({ value: UNKNOWN, kind: "unknown" } as Bytes)
      : combine(stored, card.storageMonths);
  add(
    "storage_gb_month",
    storage.value,
    storage.kind,
    "retained output + RRD bytes x operator-stated storageMonths (assumption)",
    false,
  );
  for (const item of [
    "provider_request_fees",
    "transfer_retries",
    "viewer_fetch",
    "render_workflow_compute",
    "database",
  ] as const)
    lines.push({
      item,
      quantity: UNKNOWN,
      quantityKind: "unknown",
      lowerBound: false,
      unit: null,
      rate: UNKNOWN,
      amount: UNKNOWN,
      basis: "not modelled; unknown charge",
    });
  const known = lines.filter((l) => l.amount.status === "measured");
  const unknownCharges = lines
    .filter((l) => l.amount.status !== "measured")
    .map((l) => l.item);
  return {
    kind: "gross_estimate_not_billing",
    currency: card?.currency ?? null,
    lines,
    grossKnown:
      known.length === 0
        ? UNKNOWN
        : wrap(
            known.reduce(
              (s, l) =>
                s + (l.amount.status === "measured" ? l.amount.value : 0),
              0,
            ),
          ),
    unknownCharges,
    complete: unknownCharges.length === 0 && known.every((l) => !l.lowerBound),
    operatorAssumptions: card?.assumptions ?? [],
  };
}

/** Fixed monthly platform floor, kept apart from any per-run figure. */
export function platformFloor(card?: RateCard): {
  currency: string | null;
  items: RateCard["platformFloor"];
  totalPerMonth: Measured<number>;
  note: string;
} {
  const items = card?.platformFloor ?? [];
  return {
    currency: card?.currency ?? null,
    items,
    totalPerMonth: items.length
      ? wrap(items.reduce((s, i) => s + i.amountPerMonth, 0))
      : UNKNOWN,
    note: "Operator-supplied fixed floor; listed items only. Not per-run usage and not an invoice.",
  };
}
