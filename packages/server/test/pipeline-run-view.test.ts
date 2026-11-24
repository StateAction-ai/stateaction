import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { DagRunV1 } from "@stateaction/contracts";
import {
  buildRunStages,
  buildRunSummary,
  dagRunFilename,
  dagRunJson,
  formatDuration,
  formatRate,
  formatUsd,
  stageReason,
  gpuUsdPerHour,
} from "../src/pipeline/run-view.js";

type Fixture = { cases: { name: string; input: { document: DagRunV1 } }[] };
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/conformance/fixtures/contracts/http.dag-run.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Fixture;
const caseNamed = (re: RegExp) =>
  fixture.cases.find((c) => re.test(c.name))!.input.document;

test("rows: one per recipe stage with GPU object, counts and error code", () => {
  const run = caseNamed(/failed caption stage/);
  const rows = buildRunStages(run, {
    "gpu_second:RTX-PRO-6000": { amount: 0.001 },
  });
  assert.deepEqual(
    rows.map((r) => r.stage),
    ["segment", "caption", "hand_pose"],
  );
  const seg = rows[0]!;
  assert.deepEqual(seg.gpu, {
    kind: "gpu",
    requestedType: "RTX-PRO-6000",
    observedType: "NVIDIA RTX PRO 6000 Blackwell Server Edition",
    vramGb: 96,
    usdPerHour: 3.6,
  });
  assert.equal(seg.durationSeconds, 192.25);
  assert.deepEqual(
    seg.counts.map((c) => [c.label, c.value, c.failed]),
    [
      ["segments", 4, false],
      ["failed windows", 1, true],
    ],
  );
  const cap = rows[1]!;
  assert.equal(cap.state, "failed");
  assert.equal(cap.errorCode, "stage_timeout");
  assert.equal(cap.gpu?.observedType, null);
  assert.equal(rows[2]!.gpu, null);
});

test("rate is unknown without an operator card; never guessed", () => {
  const run = caseNamed(/failed caption stage/);
  assert.equal(buildRunStages(run)[0]!.gpu?.usdPerHour, null);
  assert.equal(gpuUsdPerHour("RTX-PRO-6000", {}), null);
  assert.equal(formatRate(null), "Rate unknown");
  assert.equal(formatRate(3.6), "$3.60/h");
});

test("not_run stage keeps its reason and no duration", () => {
  const run = caseNamed(/disabled caption stage/);
  const cap = buildRunStages(run)[1]!;
  assert.equal(cap.state, "not_run");
  assert.equal(cap.reason, "Disabled in this recipe");
  assert.equal(cap.durationSeconds, null);
  assert.equal(cap.enabled, false);
});

test("summary: failed counts stay separate; accepted counts win; unknown stays null", () => {
  const run = caseNamed(/failed caption stage/);
  const fromReceipts = buildRunSummary(run, null);
  assert.equal(fromReceipts.segments, 4);
  assert.equal(fromReceipts.failedWindows, 1);
  assert.equal(fromReceipts.captions, null);
  assert.equal(fromReceipts.maxJobCostUsd, "3.00");
  assert.equal(fromReceipts.costUsd, "0.41");
  const accepted = buildRunSummary(run, {
    segments: 3,
    failedWindows: 1,
    captions: 2,
    captionsFailed: 1,
  });
  assert.equal(accepted.segments, 3);
  assert.equal(accepted.captions, 2);
  assert.equal(accepted.captionsFailed, 1);
  assert.equal(fromReceipts.wallSeconds, 1200);
});

test("summary: unaccepted captions stay null, never zero", () => {
  const run = caseNamed(/failed caption stage/);
  const s = buildRunSummary(run, {
    segments: 3,
    failedWindows: 0,
    captions: null,
    captionsFailed: null,
  });
  assert.equal(s.captions, null);
  assert.equal(s.captionsFailed, null);
});

test("dag-run panel text is the exact document", () => {
  const run = caseNamed(/failed caption stage/);
  assert.deepEqual(JSON.parse(dagRunJson(run)), run);
  assert.equal(dagRunFilename(run), `dag-run-${run.jobId}.json`);
  assert.equal(formatDuration(null), "—");
  assert.equal(formatDuration(3661), "1h 01m");
  assert.equal(formatDuration(192.25), "3m 12s");
});

test("partial stage results remain failures in the display", () => {
  const run = structuredClone(caseNamed(/failed caption stage/));
  const seg = run.stages[0]!;
  assert.equal(seg.state, "succeeded");
  const rows = buildRunStages(run);
  assert.equal(rows[0]!.stateLabel, "Needs attention");
  assert.equal(rows[1]!.reason, "The stage exceeded its time limit.");
});

test("caption failures in either recorded count format prevent a green stage", () => {
  for (const key of ["captions_failed", "failed_captions"]) {
    const run = structuredClone(caseNamed(/failed caption stage/));
    const cap = run.stages[1]!;
    cap.state = "succeeded";
    cap.counts = { [key]: 1 };
    assert.equal(buildRunStages(run)[1]!.displayState, "needs_attention");
    cap.counts[key] = 0;
    assert.equal(buildRunStages(run)[1]!.displayState, "succeeded");
  }
});

test("only recorded costs and known stage failure reasons are formatted", () => {
  assert.equal(formatUsd(null), "Not recorded");
  assert.equal(formatUsd("0.00"), "$0.00");
  assert.equal(
    stageReason("terminated_before_start"),
    "The worker stopped before starting this stage.",
  );
  assert.equal(stageReason("constructor"), null);
});
