import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildReceipt,
  estimateRun,
  evaluateAlerts,
  metricsFromLog,
  parseMetricsLine,
  platformFloor,
  RateCardError,
  readJobFacts,
  readRateCard,
  readThresholds,
  ThresholdError,
  type JobFacts,
} from "../src/ops/index.js";

const JOB = "0b1f3a52-6c1e-4f6b-9a3e-2d9f6f1a7c11";
const NOW = Date.parse("2026-11-02T12:00:00Z");
const iso = (secondsAgo: number) =>
  new Date(NOW - secondsAgo * 1000).toISOString();
const REF = "local-9d4d0c3e-6f0a-4c52-8f43-0a1b2c3d4e5f";
const T = {
  queuedDelaySeconds: 600,
  heartbeatStaleSeconds: 300,
  spendAlertAmount: 1,
};

const facts = (over: Record<string, unknown> = {}): JobFacts => {
  const f = readJobFacts({
    jobId: JOB,
    state: "queued",
    backend: "local",
    executionRef: REF,
    ...over,
  });
  assert.ok(f);
  return f;
};
const line = (over: Record<string, unknown> = {}) =>
  `sa_metrics ${JSON.stringify({
    schemaVersion: 1,
    kind: "sa_metrics",
    jobId: JOB,
    backend: "local",
    executionRef: REF,
    stage: "worker",
    outcome: "returned",
    exitCode: 0,
    startupSeconds: 0.4,
    importSeconds: 1.2,
    wallSeconds: 100,
    peakRssSelfBytes: 1000,
    peakRssChildrenBytes: null,
    rssScope: "x",
    scratchHighWaterBytes: 4096,
    scratchStatus: "sampled_lower_bound",
    bytes: {},
    ...over,
  })}`;

test("unknown telemetry stays visibly unknown, never zero", () => {
  const r = buildReceipt(facts({ state: "running" }));
  assert.deepEqual(r.worker.wallSeconds, { status: "unknown" });
  assert.deepEqual(r.worker.peakRssSelfBytes, { status: "unknown" });
  assert.deepEqual(r.bytes.source.verified, { status: "unknown" });
  assert.deepEqual(r.qc, { status: "unknown" });
  assert.equal(r.worker.scratchStatus, "unknown");
  assert.deepEqual(r.queueDelaySeconds, { status: "unknown" });
});

test("receipt keeps declared/uploaded/verified bytes and RSS scopes separate", () => {
  const m = parseMetricsLine(line({ peakRssChildrenBytes: 2000 }));
  assert.ok(m);
  const r = buildReceipt(
    facts({
      state: "succeeded",
      admittedAt: iso(500),
      claimedAt: iso(400),
      finishedAt: iso(300),
      bytes: {
        source: { declared: 10, verified: 9 },
        rrd: { uploaded: 5 },
        failedOutput: { uploaded: 3 },
      },
      qc: { pass: 3, warn: 1, fail: 0, measured: 4, notEvaluated: 0 },
    }),
    m,
  );
  assert.deepEqual(r.bytes.source, {
    declared: { status: "measured", value: 10 },
    uploaded: { status: "unknown" },
    verified: { status: "measured", value: 9 },
  });
  assert.equal((r.bytes.failedOutput.uploaded as { value: number }).value, 3);
  assert.deepEqual(r.queueDelaySeconds, { status: "measured", value: 100 });
  assert.deepEqual(r.worker.peakRssSelfBytes, {
    status: "measured",
    value: 1000,
  });
  assert.deepEqual(r.worker.peakRssChildrenBytes, {
    status: "measured",
    value: 2000,
  });
  assert.equal("peakRssBytes" in r.worker, false);
});

test("redaction: hostile values in every field are dropped, not escaped", () => {
  const secret =
    "https://x.r2.dev/o?X-Amz-Signature=abc&token=sa_svc_" + "A".repeat(43);
  const hostile = {
    jobId: JOB,
    state: "failed",
    errorCode: secret,
    backend: secret,
    executionRef: `/home/u/.token/${secret}`,
    createdAt: secret,
    extra: secret,
    bytes: {
      source: { declared: secret, verified: -1 },
      "../x": { declared: 1 },
    },
    qc: { pass: secret, warn: 0, fail: 0, measured: 0, notEvaluated: 0 },
  };
  const out = JSON.stringify(buildReceipt(readJobFacts(hostile)!));
  for (const needle of [
    "X-Amz",
    "sa_svc_",
    "/home/u",
    "r2.dev",
    "token",
    "../x",
  ])
    assert.equal(out.includes(needle), false, needle);
  assert.equal(readJobFacts({ ...hostile, jobId: secret }), undefined);
  assert.equal(readJobFacts({ jobId: JOB, state: secret }), undefined);
  // The worker line: unknown keys, oversize lines and forged fields never survive.
  assert.equal(parseMetricsLine(line({ jobId: secret })), undefined);
  assert.equal(parseMetricsLine(line({ pad: "x".repeat(3000) })), undefined);
  const m = parseMetricsLine(
    line({ evil: secret, executionRef: secret, backend: "evil" }),
  )!;
  const s = JSON.stringify(m);
  assert.equal(s.includes("evil") || s.includes("X-Amz"), false);
  assert.equal(m.backend, undefined);
  assert.equal(parseMetricsLine("sa_metrics {not json"), undefined);
});

test("metricsFromLog is bounded and ignores other jobs' lines", () => {
  const other = line({
    jobId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    wallSeconds: 1,
  });
  const text = `noise https://s/x?sig=1\n${other}\n${line({ wallSeconds: 5 })}\n${line({ wallSeconds: 7 })}\n`;
  const all = metricsFromLog(text, JOB);
  assert.equal(all.length, 2);
  // Two lines for one execution are ambiguous: neither is labelled measured.
  const r = buildReceipt(facts({ state: "failed" }), all);
  assert.equal(r.workerMetricsTrust, "rejected_ambiguous");
  assert.deepEqual(r.worker.wallSeconds, { status: "unknown" });
  const one = metricsFromLog(`${other}\n${line({ wallSeconds: 7 })}\n`, JOB);
  assert.deepEqual(
    buildReceipt(facts({ state: "failed" }), one).worker.wallSeconds,
    { status: "measured", value: 7 },
  );
  assert.deepEqual(
    metricsFromLog(text, "0b1f3a52-6c1e-4f6b-9a3e-2d9f6f1a7c99"),
    [],
  );
  assert.throws(
    () => metricsFromLog("x".repeat(1024 * 1024 + 1), JOB),
    /too large/,
  );
});

test("alerts: each rule triggers deterministically; unknown evidence says unknown", () => {
  const { spendAlertAmount: _unused, ...NO_SPEND } = T;
  void _unused;
  const run = (f: JobFacts, costs = new Map()) =>
    evaluateAlerts([f], NO_SPEND, NOW, costs);
  const q = run(facts({ admittedAt: iso(601) }));
  assert.equal(q[0]?.rule, "queued_delay");
  assert.equal(q[0]?.status, "triggered");
  assert.equal(run(facts({ admittedAt: iso(599) })).length, 0);
  assert.equal(run(facts({}))[0]?.status, "unknown");
  assert.equal(
    run(facts({ state: "submit_unknown" }))[0]?.rule,
    "stuck_or_uncertain",
  );
  assert.equal(
    run(facts({ state: "needs_attention" }))[0]?.status,
    "triggered",
  );
  assert.equal(
    run(facts({ state: "running", lastHeartbeatAt: iso(301) }))[0]?.status,
    "triggered",
  );
  assert.equal(
    run(facts({ state: "running", lastHeartbeatAt: iso(10) })).length,
    0,
  );
  assert.equal(run(facts({ state: "running" }))[0]?.status, "unknown");
  assert.equal(
    run(
      facts({
        state: "running",
        lastHeartbeatAt: iso(1),
        executionDeadline: iso(1),
      }),
    )[0]?.reason,
    "execution deadline passed without terminal state",
  );
  assert.equal(
    run(facts({ state: "succeeded", executionDeadline: iso(10) })).length,
    0,
  );
  for (const errorCode of ["source_sha_mismatch", "source_checksum_mismatch"]) {
    const sha = run(facts({ state: "failed", errorCode }));
    assert.deepEqual(
      sha.map((a) => a.rule),
      ["source_hash_failure"],
    );
  }
});

test("cost: no rates means every charge unknown; no invented price", () => {
  const e = estimateRun(
    buildReceipt(facts({ state: "succeeded" }), parseMetricsLine(line())),
  );
  assert.deepEqual(e.grossKnown, { status: "unknown" });
  assert.equal(e.complete, false);
  assert.equal(e.currency, null);
  assert.ok(e.unknownCharges.includes("cpu_core_second"));
  assert.deepEqual(platformFloor().totalPerMonth, { status: "unknown" });
});

const CARD = {
  currency: "USD",
  assumptions: ["Rates are illustrative test values, not provider prices"],
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
  },
  computeMultiplier: {
    value: 3,
    reason: "operator-stated premium for non-preemptible",
  },
  platformFloor: [
    { item: "render web", amountPerMonth: 7 },
    { item: "database", amountPerMonth: 5 },
  ],
};

test("cost: gross known is a lower bound while other charges stay unknown; floor is separate", () => {
  const card = readRateCard(CARD);
  const r = buildReceipt(
    facts({ state: "succeeded" }),
    parseMetricsLine(line()),
  );
  const e = estimateRun(r, card);
  // 100 s x 2 cores x 0.001 x 3 = 0.6
  assert.equal(e.grossKnown.status, "measured");
  assert.ok(Math.abs((e.grossKnown as { value: number }).value - 0.6) < 1e-9);
  assert.equal(e.complete, false);
  assert.ok(e.unknownCharges.includes("memory_gib_second"));
  assert.deepEqual(platformFloor(card).totalPerMonth, {
    status: "measured",
    value: 12,
  });
  // Unmeasured wall: the rate exists but nothing is invented.
  const none = estimateRun(buildReceipt(facts({ state: "failed" })), card);
  assert.deepEqual(none.grossKnown, { status: "unknown" });
});

test("spend alert: triggers above amount, says incomplete and not a cap; unknown without estimate", () => {
  const card = readRateCard(CARD);
  const f = facts({ state: "succeeded" });
  const est = estimateRun(buildReceipt(f, parseMetricsLine(line())), card);
  const a = evaluateAlerts(
    [f],
    { ...T, spendAlertAmount: 0.5 },
    NOW,
    new Map([[JOB, est]]),
  );
  assert.equal(a[0]?.rule, "spend");
  assert.match(a[0]!.reason, /other charges unknown.*not a billing cap/);
  assert.equal(
    evaluateAlerts(
      [f],
      { ...T, spendAlertAmount: 5 },
      NOW,
      new Map([[JOB, est]]),
    ).length,
    0,
  );
  assert.equal(evaluateAlerts([f], T, NOW)[0]?.status, "unknown");
});

test("rate card and threshold readers fail closed without echoing input", () => {
  const bad = (c: unknown) =>
    assert.throws(() => readRateCard(c), RateCardError);
  bad({ ...CARD, currency: "usd" });
  bad({ ...CARD, extra: 1 });
  bad({
    ...CARD,
    rates: { cpu_core_second: { ...CARD.rates.cpu_core_second, amount: -1 } },
  });
  bad({
    ...CARD,
    rates: {
      cpu_core_second: { ...CARD.rates.cpu_core_second, amount: Infinity },
    },
  });
  bad({ ...CARD, rates: { gpu: CARD.rates.cpu_core_second } });
  for (const ref of [
    "http://example.com/r",
    "https://example.com/r?sig=abc",
    "https://u:p@example.com/r",
    "https://example.com/r#x",
    "javascript:alert(1)",
  ])
    bad({
      ...CARD,
      rates: {
        cpu_core_second: {
          ...CARD.rates.cpu_core_second,
          source: { ...CARD.rates.cpu_core_second.source, ref },
        },
      },
    });
  bad({ ...CARD, assumptions: ["line\nbreak"] });
  try {
    readRateCard({ ...CARD, currency: "https://x/?sig=SECRET" });
  } catch (e) {
    assert.equal(String((e as Error).message).includes("SECRET"), false);
  }
  assert.throws(
    () => readThresholds({ queuedDelaySeconds: 0, heartbeatStaleSeconds: 1 }),
    ThresholdError,
  );
  assert.throws(
    () => readThresholds({ queuedDelaySeconds: 1 }),
    ThresholdError,
  );
  assert.throws(
    () =>
      readThresholds({ queuedDelaySeconds: 1, heartbeatStaleSeconds: 1, x: 1 }),
    ThresholdError,
  );
  assert.deepEqual(readThresholds(T), T);
});
