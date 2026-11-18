import pg from "pg";
import { parseArgs } from "node:util";
import {
  buildReceipt,
  estimateRun,
  evaluateAlerts,
  loadJobFacts,
  MAX_JOBS,
  MAX_OUTPUT_BYTES,
  metricsFromLog,
  OpsInputError,
  platformFloor,
  RateCardError,
  readJobFacts,
  readLogFiles,
  readRateCard,
  readRegularFile,
  readThresholds,
  ThresholdError,
  type CostEstimate,
  type JobFacts,
  type RateCard,
  type WorkerMetrics,
} from "./ops/index.js";

/**
 * Operator-visible pipeline resource/error/spend report (SA-45). Prints ONE
 * bounded JSON document; sends nothing to Slack, email or a provider and
 * configures no provider alert.
 *
 * Fact sources (exactly one):
 *   --from-db            read-only restricted-application-role snapshot of the
 *                        durable catalog (the production source). The URL comes
 *                        only from OPS_REPORT_DATABASE_URL (local: DATABASE_URL on
 *                        loopback). It is never printed or put in the output.
 *   --facts <file>       EXPLICIT OFFLINE input (operator-supplied JSON). Not a
 *                        production fact source; the report says so.
 *
 *   ops-report (--from-db [--since-hours N] | --facts jobs.json) --thresholds t.json
 *              [--rates r.json] [--log worker.log ...] [--now ISO]
 */
const CLI_VERSION = 1;
const MAX_SINCE_HOURS = 24 * 90;

function parse() {
  try {
    return parseArgs({
      options: {
        "from-db": { type: "boolean" },
        facts: { type: "string" },
        thresholds: { type: "string" },
        rates: { type: "string" },
        log: { type: "string", multiple: true },
        now: { type: "string" },
        "since-hours": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    throw new OpsInputError("invalid arguments");
  }
}

function databaseUrl(): string {
  const env = process.env.APP_ENV ?? "local";
  const url =
    process.env.OPS_REPORT_DATABASE_URL ??
    (env === "local" ? process.env.DATABASE_URL : undefined);
  if (!url) throw new OpsInputError("OPS_REPORT_DATABASE_URL is not set");
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new OpsInputError("database URL is not valid");
  }
  if (env === "local" && !["127.0.0.1", "localhost", "[::1]"].includes(host))
    throw new OpsInputError("local tooling refuses non-loopback databases");
  return url;
}

function sinceSeconds(raw: string | undefined): number {
  const hours = raw === undefined ? 24 : Number(raw);
  if (
    !/^\d{1,4}(\.\d{1,2})?$/.test(raw ?? "24") ||
    !(hours > 0) ||
    hours > MAX_SINCE_HOURS
  )
    throw new OpsInputError("--since-hours out of range");
  return hours * 3600;
}

const strictNow = (raw: string): number => {
  const ok = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(raw);
  const ms = ok ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms))
    throw new OpsInputError("--now must be an ISO UTC time");
  return ms;
};

async function main(): Promise<void> {
  const values = parse();
  if (Boolean(values["from-db"]) === Boolean(values.facts))
    throw new OpsInputError("choose exactly one of --from-db or --facts");
  if (!values.thresholds) throw new OpsInputError("--thresholds is required");
  const thresholds = readThresholds(
    JSON.parse(readRegularFile(values.thresholds).toString("utf8")),
  );
  const card: RateCard | undefined = values.rates
    ? readRateCard(JSON.parse(readRegularFile(values.rates).toString("utf8")))
    : undefined;
  const logs = readLogFiles(values.log ?? []);

  let jobs: JobFacts[];
  let now: number;
  let unreadable = 0;
  let source: "restricted_db_read" | "offline_operator_file";
  if (values["from-db"]) {
    source = "restricted_db_read";
    const pool = new pg.Pool({
      connectionString: databaseUrl(),
      max: 1,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 1000,
      query_timeout: 15_000,
      application_name: "stateaction-ops-report",
    });
    try {
      const loaded = await loadJobFacts(pool, {
        sinceSeconds: sinceSeconds(values["since-hours"]),
      });
      jobs = loaded.jobs;
      unreadable = loaded.unreadable;
      now = values.now ? strictNow(values.now) : loaded.databaseNow;
    } finally {
      await pool.end().catch(() => undefined);
    }
  } else {
    source = "offline_operator_file";
    const raw: unknown = JSON.parse(
      readRegularFile(values.facts!).toString("utf8"),
    );
    if (!Array.isArray(raw) || raw.length > MAX_JOBS)
      throw new OpsInputError(
        `facts must be an array of at most ${MAX_JOBS} jobs`,
      );
    jobs = raw
      .map((r) => readJobFacts(r, "offline_operator_file"))
      .filter((j): j is JobFacts => j !== undefined);
    unreadable = raw.length - jobs.length;
    now = values.now ? strictNow(values.now) : Date.now();
  }

  const receipts = jobs.map((j) => {
    const lines: WorkerMetrics[] = logs.flatMap((text) =>
      metricsFromLog(text, j.jobId),
    );
    return buildReceipt(j, lines);
  });
  const costs = new Map<string, CostEstimate>(
    receipts.map((r) => [r.jobId, estimateRun(r, card)]),
  );
  const document = JSON.stringify({
    schemaVersion: CLI_VERSION,
    generatedAt: new Date(now).toISOString(),
    factsSource: source,
    skippedUnreadableJobs: unreadable,
    notices: [
      source === "offline_operator_file"
        ? "Facts came from an operator-supplied offline file, not the durable catalog; do not treat as production evidence."
        : "Facts are a read-only restricted-role snapshot of the durable catalog.",
      "Alerts are local operator evaluations, not billing hard caps or provider settings.",
      "Unknown means not measured or not recorded; it is never zero.",
      "Worker measurements count only when their backend and execution reference match the durable execution.",
      "Nothing was sent externally; provider (Modal/Render) billing alerts are not configured by this tool.",
    ],
    platformFloor: platformFloor(card),
    receipts: receipts.map((r) => ({ ...r, cost: costs.get(r.jobId) })),
    alerts: evaluateAlerts(jobs, thresholds, now, costs),
  });
  if (Buffer.byteLength(document) > MAX_OUTPUT_BYTES)
    throw new OpsInputError("report exceeds the output limit");
  console.log(document);
}

try {
  await main();
} catch (error) {
  // Field names and fixed messages only: never an input value, URL, credential or raw exception.
  const safe =
    error instanceof OpsInputError ||
    error instanceof RateCardError ||
    error instanceof ThresholdError;
  const sqlstate =
    typeof (error as { code?: unknown })?.code === "string" &&
    /^[0-9A-Z]{5}$|^E[A-Z]{3,12}$/.test((error as { code: string }).code)
      ? ` (${(error as { code: string }).code})`
      : "";
  console.error(
    `ops-report failed: ${safe ? (error as Error).message : `unreadable input or database error${sqlstate}`}`,
  );
  process.exitCode = 1;
}
