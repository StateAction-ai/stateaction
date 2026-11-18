import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  asCode,
  asExecutionRef,
  buildReceipt,
  CHUNK_BYTES,
  estimateRun,
  loadJobFacts,
  MAX_LOG_FILES,
  OpsInputError,
  parseMetricsLine,
  RateCardError,
  readBoundedFd,
  readJobFacts,
  readLogFiles,
  readRateCard,
  readRegularFile,
  type JobFacts,
} from "../src/ops/index.js";

const JOB = "0b1f3a52-6c1e-4f6b-9a3e-2d9f6f1a7c11";
const LOCAL = "local-9d4d0c3e-6f0a-4c52-8f43-0a1b2c3d4e5f";
const MODAL = "fc-01HZABCDEF1234567890XYZ";
const facts = (over: Record<string, unknown> = {}): JobFacts =>
  readJobFacts({
    jobId: JOB,
    state: "failed",
    backend: "modal",
    executionRef: MODAL,
    ...over,
  })!;
const line = (over: Record<string, unknown> = {}) =>
  `sa_metrics ${JSON.stringify({
    schemaVersion: 1,
    kind: "sa_metrics",
    jobId: JOB,
    backend: "modal",
    executionRef: MODAL,
    outcome: "returned",
    exitCode: 0,
    wallSeconds: 12,
    peakRssSelfBytes: 5,
    bytes: {},
    ...over,
  })}`;

test("a measured line must match the durable backend AND execution reference", () => {
  const ok = buildReceipt(facts(), parseMetricsLine(line()));
  assert.equal(ok.workerMetricsTrust, "matched_execution");
  assert.deepEqual(ok.worker.wallSeconds, { status: "measured", value: 12 });
  const wrongBackend = buildReceipt(
    facts(),
    parseMetricsLine(line({ backend: "local", executionRef: LOCAL })),
  );
  const wrongRef = buildReceipt(
    facts(),
    parseMetricsLine(line({ executionRef: "fc-OTHER" })),
  );
  const noRef = buildReceipt(
    facts(),
    parseMetricsLine(line({ executionRef: null })),
  );
  for (const r of [wrongBackend, wrongRef, noRef]) {
    assert.equal(r.workerMetricsTrust, "rejected_identity_mismatch");
    assert.deepEqual(r.worker.wallSeconds, { status: "unknown" });
    assert.deepEqual(r.worker.peakRssSelfBytes, { status: "unknown" });
  }
  // Durable identity unknown: the line cannot be verified, so it is never "measured".
  const unverifiable = buildReceipt(
    facts({ executionRef: undefined }),
    parseMetricsLine(line()),
  );
  assert.equal(
    unverifiable.workerMetricsTrust,
    "rejected_identity_unverifiable",
  );
  assert.deepEqual(unverifiable.executionRef, { status: "unknown" });
  assert.deepEqual(unverifiable.worker.wallSeconds, { status: "unknown" });
  // Identity is never taken from the worker line.
  assert.equal(
    buildReceipt(
      facts({ backend: undefined, executionRef: undefined }),
      parseMetricsLine(line()),
    ).backend.status,
    "unknown",
  );
  assert.equal(buildReceipt(facts()).workerMetricsTrust, "none");
});

test("identifiers use backend-specific forms; error codes use a closed vocabulary", () => {
  assert.equal(asExecutionRef("local", LOCAL), LOCAL);
  assert.equal(asExecutionRef("modal", MODAL), MODAL);
  const hostile = [
    "sa_svc_" + "A".repeat(43),
    "local-" + "A".repeat(40),
    "token-abc.def:ghi",
    "fc-" + "A".repeat(78),
    "fc-ab\nfc-cd",
    `${LOCAL}\n`,
    "fc-a_b",
    "https://x/y?sig=1",
    "../etc/passwd",
  ];
  for (const h of hostile) {
    assert.equal(asExecutionRef("local", h), undefined, h);
    assert.equal(asExecutionRef("modal", h), undefined, h);
  }
  assert.equal(asExecutionRef("local", MODAL), undefined);
  assert.equal(asExecutionRef("modal", LOCAL), undefined);
  assert.equal(asExecutionRef(undefined, LOCAL), undefined);
  assert.equal(asCode("source_sha_mismatch"), "source_sha_mismatch");
  for (const c of [
    "sa_svc_abcdefghij",
    "valueerror",
    "token_" + "a".repeat(40),
    "x",
  ])
    assert.equal(asCode(c), undefined, c);
  const r = buildReceipt(
    facts({
      errorCode: "sa_svc_" + "a".repeat(40),
      executionRef: "sa_svc_" + "A".repeat(43),
    }),
  );
  assert.deepEqual(r.errorCode, { status: "unknown" });
  assert.deepEqual(r.executionRef, { status: "unknown" });
  assert.equal(JSON.stringify(r).includes("sa_svc_"), false);
});

const CARD = {
  currency: "USD",
  assumptions: ["operator test values only"],
  allocation: { cpuCores: 2, memoryGiB: 4, diskGiB: 10 },
  rates: {
    cpu_core_second: {
      amount: 0.001,
      unit: "core-second",
      source: {
        kind: "operator",
        ref: "https://example.com/rates",
        retrievedAt: "2026-11-02",
      },
    },
    transfer_gb: {
      amount: 0.1,
      unit: "GB",
      source: {
        kind: "operator",
        ref: "https://example.com/rates",
        retrievedAt: "2026-11-02",
      },
    },
  },
  platformFloor: [],
};
const withRate = (item: string, patch: Record<string, unknown>) => ({
  ...CARD,
  rates: {
    ...CARD.rates,
    [item]: { ...(CARD.rates as Record<string, object>)[item], ...patch },
  },
});

test("rate units must match the documented item units exactly; dates and text fail closed", () => {
  readRateCard(CARD);
  for (const unit of [
    "core-minute",
    "core-hour",
    "USD/core-second",
    "core second",
    "GB-second",
    "",
    "per second",
  ])
    assert.throws(
      () => readRateCard(withRate("cpu_core_second", { unit })),
      RateCardError,
      unit,
    );
  assert.throws(
    () => readRateCard(withRate("transfer_gb", { unit: "GiB" })),
    RateCardError,
  );
  const src = (retrievedAt: string) => ({
    source: { kind: "operator", ref: "https://example.com/r", retrievedAt },
  });
  for (const d of [
    "2026-02-30",
    "2026-13-01",
    "2999-01-01",
    "1999-01-01",
    "2026-1-1",
    "2026-11-02T00:00:00Z",
  ])
    assert.throws(
      () => readRateCard(withRate("cpu_core_second", src(d))),
      RateCardError,
      d,
    );
  for (const a of [
    "token=abcdef",
    "see https://u:p@host/x",
    "Authorization: Bearer abc",
    "sig=1&x=2",
    "sa_svc_" + "a".repeat(10),
    "A".repeat(40),
    "X-Amz-Signature=deadbeef",
  ])
    assert.throws(
      () => readRateCard({ ...CARD, assumptions: [a] }),
      RateCardError,
      a,
    );
  assert.throws(
    () =>
      readRateCard({
        ...CARD,
        platformFloor: [{ item: "db", amountPerMonth: 1e12 }],
      }),
    RateCardError,
  );
  assert.throws(
    () =>
      readRateCard({
        ...CARD,
        computeMultiplier: { value: 1000, reason: "x" },
      }),
    RateCardError,
  );
});

test("cost quantities state their kind; allocation, retained bytes and unknown fees stay distinct", () => {
  const card = readRateCard(CARD);
  const receipt = buildReceipt(
    facts({
      backend: "modal",
      executionRef: MODAL,
      state: "succeeded",
      bytes: {
        source: { declared: 3e9, uploaded: 2e9 },
        output: { declared: 1e9, verified: 1e9 },
        rrd: { declared: 5e8 },
      },
    }),
    parseMetricsLine(line({ wallSeconds: 100 })),
  );
  const e = estimateRun(receipt, card);
  const get = (item: string) => e.lines.find((l) => l.item === item)!;
  assert.equal(
    get("cpu_core_second").quantityKind,
    "allocated_x_measured_wall",
  );
  assert.equal(get("cpu_core_second").lowerBound, true);
  assert.equal(get("cpu_core_second").unit, "core-second");
  // Weakest basis wins and is reported: rrd is only declared.
  assert.equal(get("transfer_gb").quantityKind, "retained_bytes_declared");
  assert.deepEqual(get("transfer_gb").quantity, {
    status: "measured",
    value: 3.5,
  });
  for (const item of [
    "transfer_retries",
    "viewer_fetch",
    "provider_request_fees",
    "database",
  ])
    assert.deepEqual(get(item).amount, { status: "unknown" }, item);
  assert.equal(e.complete, false);
  assert.deepEqual(e.operatorAssumptions, ["operator test values only"]);
  assert.equal("assumptions" in e, false);
});

test("bounded reader rejects a file that grows past the cap, from one descriptor", () => {
  const MAX = 10_000;
  let reads = 0;
  // Simulates a file that keeps growing: every read returns more bytes, never EOF.
  const growing = (
    _fd: number,
    buf: Uint8Array,
    _o: number,
    length: number,
  ) => {
    reads += 1;
    buf.fill(65, 0, length);
    return length;
  };
  assert.throws(() => readBoundedFd(0, MAX, growing), OpsInputError);
  assert.ok(reads <= Math.ceil((MAX + 1) / CHUNK_BYTES) + 1);
  // Exactly at the cap is accepted; one byte over is rejected.
  const finite = (size: number) => {
    let left = size;
    return (_fd: number, buf: Uint8Array, _o: number, length: number) => {
      const n = Math.min(left, length);
      buf.fill(66, 0, n);
      left -= n;
      return n;
    };
  };
  assert.equal(readBoundedFd(0, MAX, finite(MAX)).length, MAX);
  assert.throws(() => readBoundedFd(0, MAX, finite(MAX + 1)), /too large/);
  assert.equal(readBoundedFd(0, MAX, finite(0)).length, 0);
});

test("file and log intake: regular files only, size, count and total are rejected not truncated", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-reader-"));
  try {
    const small = join(dir, "a.log");
    writeFileSync(small, "hello");
    assert.equal(readRegularFile(small).toString(), "hello");
    const big = join(dir, "big.log");
    writeFileSync(big, Buffer.alloc(2000, 65));
    assert.throws(() => readRegularFile(big, 1999), /too large/);
    const link = join(dir, "link.log");
    symlinkSync(small, link);
    assert.throws(() => readRegularFile(link), /not a regular file/);
    assert.throws(() => readRegularFile(dir), /not a regular file/);
    assert.throws(
      () =>
        readLogFiles(Array.from({ length: MAX_LOG_FILES + 1 }, () => small)),
      /too many/,
    );
    assert.deepEqual(readLogFiles([small, small]), ["hello", "hello"]);
    // Total budget: eight 1 MiB logs exceed the 4 MiB cap and are rejected.
    const full = join(dir, "full.log");
    writeFileSync(full, Buffer.alloc(1024 * 1024, 65));
    assert.throws(
      () => readLogFiles(Array.from({ length: 5 }, () => full)),
      OpsInputError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loader refuses out-of-range bounds before touching the database", async () => {
  const pool = { connect: async () => assert.fail("must not connect") };
  for (const o of [
    { sinceSeconds: 0 },
    { sinceSeconds: 1e12 },
    { sinceSeconds: 10, limit: 0 },
    { sinceSeconds: 10, limit: 201 },
    { sinceSeconds: 10, timeoutMs: 5 },
  ])
    await assert.rejects(loadJobFacts(pool as never, o), OpsInputError);
});

test("CLI errors never echo input values or credentials", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-cli-"));
  try {
    const secret =
      "https://x.example/o?X-Amz-Signature=SECRETVALUE&token=sa_svc_" +
      "A".repeat(43);
    const thresholds = join(dir, "t.json");
    writeFileSync(
      thresholds,
      JSON.stringify({ queuedDelaySeconds: 60, heartbeatStaleSeconds: 60 }),
    );
    const facts = join(dir, "f.json");
    writeFileSync(facts, "[]");
    const rates = join(dir, "r.json");
    writeFileSync(rates, JSON.stringify({ ...CARD, currency: secret }));
    const run = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(
        process.execPath,
        [
          "--conditions=react-server",
          "--import",
          "tsx",
          "src/ops-report-cli.ts",
          ...args,
        ],
        {
          cwd: join(import.meta.dirname, ".."),
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", ...env },
          timeout: 60_000,
        },
      );
    const cases = [
      run(["--facts", facts, "--thresholds", thresholds, "--rates", rates]),
      run(["--facts", facts, "--thresholds", thresholds, `--bogus=${secret}`]),
      run(["--facts", facts, "--thresholds", thresholds, "--now", secret]),
      run(["--from-db", "--thresholds", thresholds], {
        OPS_REPORT_DATABASE_URL: `postgres://u:${secret}@db.example:5432/x`,
        APP_ENV: "local",
      }),
      run(["--from-db", "--facts", facts, "--thresholds", thresholds]),
    ];
    for (const r of cases) {
      assert.equal(r.status, 1);
      const out = `${r.stdout}${r.stderr}`;
      for (const n of [
        "SECRETVALUE",
        "sa_svc_",
        "X-Amz",
        "db.example",
        "postgres://",
      ])
        assert.equal(out.includes(n), false, n);
      assert.match(r.stderr, /^ops-report failed: /);
    }
    const ok = run(["--facts", facts, "--thresholds", thresholds]);
    assert.equal(ok.status, 0);
    const doc = JSON.parse(ok.stdout);
    assert.equal(doc.factsSource, "offline_operator_file");
    assert.match(doc.notices[0], /offline file, not the durable catalog/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
