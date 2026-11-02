import { readFile } from "node:fs/promises";

export const ROLES = ["collector", "staff", "customer"] as const;
export type Role = (typeof ROLES)[number];

/** One operator-managed grant row, as stored by the catalog `access` table. */
export type AccessGrant = { role: Role; enabled: boolean };

/**
 * Typed boundary to the operator-managed pilot role store. Implementations
 * read server state only; nothing here accepts roles from a request.
 */
export interface AccessStore {
  grantsFor(userId: string): Promise<AccessGrant[]>;
}

export type AccessStatus = "active" | "pending" | "disabled";
export type AccessDecision = { status: AccessStatus; roles: Role[] };

/**
 * `pending`: signed in, but an operator has not granted any role yet.
 * `disabled`: grants exist and every one is disabled.
 * `active`: at least one enabled role; only enabled roles are returned.
 */
export function decideAccess(grants: readonly AccessGrant[]): AccessDecision {
  const roles = ROLES.filter((role) =>
    grants.some((g) => g.role === role && g.enabled),
  );
  if (roles.length > 0) return { status: "active", roles };
  return { status: grants.length > 0 ? "disabled" : "pending", roles: [] };
}

function isRole(value: unknown): value is Role {
  return (
    typeof value === "string" && (ROLES as readonly string[]).includes(value)
  );
}

export type Queryable = {
  query<R extends Record<string, unknown>>(
    text: string,
    values: unknown[],
  ): Promise<{ rows: R[] }>;
};

/**
 * Reads the SA-13 catalog `access(user_id, role, enabled, ...)` table. The
 * table and its migration are owned by the catalog; this adapter only reads
 * it. Unknown role values fail closed instead of being ignored.
 */
export class CatalogAccessStore implements AccessStore {
  constructor(private readonly db: Queryable) {}
  async grantsFor(userId: string): Promise<AccessGrant[]> {
    const { rows } = await this.db.query<{ role: unknown; enabled: unknown }>(
      "SELECT role, enabled FROM access WHERE user_id = $1",
      [userId],
    );
    return rows.map((row) => {
      if (!isRole(row.role) || typeof row.enabled !== "boolean")
        throw new Error("Unexpected access row");
      return { role: row.role, enabled: row.enabled };
    });
  }
}

/**
 * TEST-ONLY eligibility store. Reads `{ "<userId>": [{role, enabled}] }` from
 * a JSON file on every lookup so tests can grant, disable and revoke between
 * requests. `authConfig` allows it only with APP_ENV=test; it is not catalog,
 * seed or production access evidence.
 */
export class TestFixtureAccessStore implements AccessStore {
  constructor(private readonly file: string) {}
  async grantsFor(userId: string): Promise<AccessGrant[]> {
    const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("Invalid test access fixture");
    const entry = (parsed as Record<string, unknown>)[userId];
    if (entry === undefined) return [];
    if (!Array.isArray(entry)) throw new Error("Invalid test access fixture");
    return entry.map((g: unknown) => {
      const grant = g as { role?: unknown; enabled?: unknown };
      if (!isRole(grant.role) || typeof grant.enabled !== "boolean")
        throw new Error("Invalid test access fixture");
      return { role: grant.role, enabled: grant.enabled };
    });
  }
}
