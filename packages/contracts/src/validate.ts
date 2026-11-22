import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { isWellFormed } from "./canonical.js";
import { RULES } from "./rules.js";
import {
  catalog,
  commonSchema,
  contractSchemas,
  sharedSchemas,
} from "./schemas.js";

export type ContractError = { path: string; message: string };
export type ValidationResult =
  | { valid: true; value: unknown }
  | { valid: false; code: string; errors: ContractError[] };

type Version = { field: string; accepted: unknown[] } | { path: string } | null;
type Entry = {
  schema: string;
  id: string;
  casing: string;
  version: Version;
  maxBytes: number;
  rules: string[];
};

const entries = catalog.contracts as Record<string, Entry>;
export const contractIds: readonly string[] = Object.freeze(
  Object.keys(entries).sort(),
);
const MAX_DEPTH = catalog.maxDepth;

// strict mode fails closed on unknown keywords, formats and ambiguous types.
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
  validateFormats: false,
});
ajv.addSchema(commonSchema);
for (const shared of sharedSchemas) ajv.addSchema(shared);
// Register every contract first so cross-contract $refs resolve by absolute $id.
for (const id of contractIds) ajv.addSchema(contractSchemas[id]!);
const compiled = new Map<string, ValidateFunction>();
for (const id of contractIds) {
  const entry = entries[id]!;
  for (const rule of entry.rules)
    if (!(rule in RULES)) throw new Error(`Unknown rule ${rule} for ${id}`);
  const validate = ajv.getSchema(entry.id);
  if (!validate) throw new Error(`Unresolvable schema ${entry.id} for ${id}`);
  compiled.set(id, validate);
}

const fail = (code: string, path = "", message = code): ValidationResult => ({
  valid: false,
  code,
  errors: [{ path, message }],
});

/** Reject values a strict JSON reader in every adapter language would reject. */
function wellFormed(value: unknown, depth: number): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return isWellFormed(value);
  if (value === null || typeof value === "boolean") return true;
  if (depth >= MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.every((x) => wellFormed(x, depth + 1));
  return Object.entries(value as object).every(
    ([k, x]) => isWellFormed(k) && wellFormed(x, depth + 1),
  );
}

function entry(contract: string): Entry {
  const found = entries[contract];
  if (!found) throw new RangeError(`Unknown contract ${contract}`);
  return found;
}

/** Validate an already-parsed JSON value (version → schema → rules). */
export function validateValue(
  contract: string,
  value: unknown,
): ValidationResult {
  const meta = entry(contract);
  if (!wellFormed(value, 0)) return fail("malformed_json");
  const version = meta.version;
  if (version && "field" in version && typeof value === "object" && value) {
    const field = version.field;
    if (field in value) {
      const found = (value as Record<string, unknown>)[field];
      if (!version.accepted.some((accepted) => accepted === found))
        return fail("unsupported_version", `/${field}`);
    }
  }
  const validate = compiled.get(contract)!;
  if (!validate(value))
    return {
      valid: false,
      code: "schema_violation",
      errors: (validate.errors ?? []).map((e) => ({
        path: e.instancePath,
        message: `${e.keyword}: ${e.message ?? "invalid"}`,
      })),
    };
  for (const rule of meta.rules) {
    const violation = RULES[rule]!(value as Record<string, unknown>);
    if (violation) return fail(violation.code, violation.path, rule);
  }
  return { valid: true, value };
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Validate exact received/stored bytes, enforcing the contract byte bound first. */
export function validateBytes(
  contract: string,
  bytes: Uint8Array,
): ValidationResult {
  const meta = entry(contract);
  if (bytes.byteLength > meta.maxBytes) return fail("document_too_large");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return fail("malformed_json", "", "byte order mark");
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return fail("malformed_json");
  }
  return validateValue(contract, value);
}

/** Parse-or-throw helper for route handlers and workers. */
export class ContractViolation extends TypeError {
  constructor(
    readonly contract: string,
    readonly code: string,
    readonly errors: ContractError[],
  ) {
    super(`${contract}: ${code}`);
  }
}

export function parseContract<T>(contract: string, value: unknown): T {
  const result = validateValue(contract, value);
  if (!result.valid)
    throw new ContractViolation(contract, result.code, result.errors);
  return result.value as T;
}

export function contractMaxBytes(contract: string): number {
  return entry(contract).maxBytes;
}
