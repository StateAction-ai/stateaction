// Ownership ledger for the bounded external fixtures (see
// scripts/platform/local-fixtures.mjs). When the local gate prepared a run
// directory, every database/bucket the integration harness creates carries the
// run id in its name and is recorded in the 0600 per-run ledger BEFORE it is
// created, so the launcher removes exactly those IDs and nothing else.
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export type LedgerRun = { dir: string; runId: string };

export function ledgerRun(): LedgerRun | null {
  const dir = process.env.STATEACTION_FIXTURE_RUN_DIR;
  const runId = process.env.STATEACTION_FIXTURE_RUN_ID;
  if (!dir) return null;
  if (!runId || !/^[0-9a-f]{12}$/.test(runId))
    throw new Error("STATEACTION_FIXTURE_RUN_ID missing or malformed");
  return { dir, runId };
}

export function recordCreated(
  run: LedgerRun,
  kind: "database" | "bucket" | "role" | "template",
  name: string,
  owner?: string,
): void {
  appendFileSync(
    join(run.dir, "ledger.jsonl"),
    `${JSON.stringify({ event: "created", kind, name, runId: run.runId, ts: Date.now(), owner })}\n`,
  );
}

export const marker = (run: LedgerRun) =>
  `stateaction-local-fixture:${run.runId}`;

export function databaseName(run: LedgerRun | null): string {
  return run
    ? `sa_cat_${run.runId}_${randomBytes(6).toString("hex")}`
    : `catalog_${randomUUID().replaceAll("-", "")}`;
}

export function bucketName(run: LedgerRun | null): string {
  return run
    ? `sa-${run.runId}-${randomBytes(6).toString("hex")}`
    : `it-${randomBytes(6).toString("hex")}`;
}

/**
 * Roles are cluster-global, so a role a test makes the migrator create must be
 * removed after its database. Record it before the test, then `claimRole`
 * marks it (server-side proof of ownership) before the launcher reaps it.
 */
export function expectRole(name: string): void {
  const run = ledgerRun();
  if (run) recordCreated(run, "role", name);
}

export async function claimRole(
  owner: { query(sql: string): Promise<unknown> },
  name: string,
): Promise<void> {
  const run = ledgerRun();
  if (!run) return;
  if (!/^sa_[a-z0-9_]{3,56}$/.test(name)) throw new Error("unsafe role name");
  await owner
    .query(`COMMENT ON ROLE ${name} IS '${marker(run)}'`)
    .catch(() => undefined);
}
