import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PIPELINE_MAX_PAGE,
  deriveStages,
  noJobControl,
  parsePipelineQuery,
  parseRecordingId,
  pipelineErrorSummary,
  pipelineQueryString,
  reviewClipsHref,
  type JobState,
  type StageEvidence,
} from "../src/pipeline/model.js";
import {
  pipelineActionsFor,
  type PipelineDetail,
} from "../src/pipeline/queries.js";

const evidence = (over: Partial<StageEvidence>): StageEvidence => ({
  sealed: true,
  recordingStatus: "sealed",
  admissionRejected: false,
  jobState: null,
  jobSubmitted: false,
  uploadedBytes: null,
  totalBytes: null,
  clipCount: null,
  ...over,
});
const states = (e: Partial<StageEvidence>) =>
  deriveStages(evidence(e)).map((s) => s.state);

test("query parsing is bounded and falls back safely", () => {
  assert.deepEqual(parsePipelineQuery({}), { q: "", status: null, page: 1 });
  const q = parsePipelineQuery({
    q: ["  hello \n\t world ", "ignored"],
    status: "failed",
    page: "3",
  });
  assert.deepEqual(q, { q: "hello world", status: "failed", page: 3 });
  assert.equal(parsePipelineQuery({ status: "bogus" }).status, null);
  assert.equal(parsePipelineQuery({ page: "-1" }).page, 1);
  assert.equal(parsePipelineQuery({ page: "99999" }).page, 1);
  assert.equal(parsePipelineQuery({ page: "9999" }).page, PIPELINE_MAX_PAGE);
  assert.equal(parsePipelineQuery({ q: "x".repeat(500) }).q.length, 80);
  assert.equal(pipelineQueryString(q), "q=hello+world&status=failed&page=3");
  assert.equal(pipelineQueryString({ q: "", status: null, page: 1 }), "");
});

test("recording ids are canonical UUIDs only", () => {
  const id = "0a1b2c3d-0000-4000-8000-123456789abc";
  assert.equal(parseRecordingId(id.toUpperCase()), id);
  for (const bad of ["", "abc", `${id}/x`, `../${id}`, undefined])
    assert.equal(parseRecordingId(bad), null);
});

test("review clips link carries only the recording id", () => {
  const id = "0a1b2c3d-0000-4000-8000-123456789abc";
  assert.equal(reviewClipsHref(id), `/data-browser?recordingId=${id}`);
  assert.doesNotMatch(reviewClipsHref(id), /reviewStatus/);
});

test("stages never assume unrecorded evidence", () => {
  // Uploading: only confirmed bytes are shown.
  assert.deepEqual(states({ sealed: false, recordingStatus: "uploading" }), [
    "active",
    "not_started",
    "not_started",
    "not_started",
    "not_started",
  ]);
  // Sealed, no job yet.
  assert.deepEqual(states({ jobState: null }), [
    "done",
    "active",
    "not_started",
    "not_started",
    "not_started",
  ]);
  // Running: quality checks are unknown (no worker telemetry), not passed.
  assert.deepEqual(states({ jobState: "running", jobSubmitted: true }), [
    "done",
    "done",
    "active",
    "unknown",
    "not_started",
  ]);
  // Uncertain submission stays unknown.
  assert.deepEqual(states({ jobState: "submit_unknown" }), [
    "done",
    "unknown",
    "unknown",
    "unknown",
    "not_started",
  ]);
  // Failure does not invent a passing quality check or ready state.
  assert.deepEqual(states({ jobState: "failed", jobSubmitted: true }), [
    "done",
    "done",
    "failed",
    "unknown",
    "blocked",
  ]);
  assert.equal(states({ jobState: "failed" })[1], "unknown");
  // Succeeded.
  const done = deriveStages(
    evidence({ jobState: "succeeded", jobSubmitted: true, clipCount: 3 }),
  );
  assert.deepEqual(
    done.map((s) => s.state),
    ["done", "done", "done", "done", "done"],
  );
  assert.equal(done[4]?.detail, "3 clips");
  assert.equal(
    deriveStages(evidence({ jobState: "succeeded", clipCount: 0 }))[4]?.detail,
    "No clips were generated",
  );
  // Rejected admission blocks everything after Queued.
  assert.deepEqual(states({ admissionRejected: true }), [
    "done",
    "failed",
    "blocked",
    "blocked",
    "blocked",
  ]);
  // Cancelled during upload.
  assert.deepEqual(states({ sealed: false, recordingStatus: "cancelled" }), [
    "cancelled",
    "blocked",
    "blocked",
    "blocked",
    "blocked",
  ]);
});

test("every job state yields five labelled stages", () => {
  const all: JobState[] = [
    "queued",
    "submitting",
    "submit_unknown",
    "running",
    "result_pending",
    "succeeded",
    "failed",
    "cancel_requested",
    "cancelled",
    "needs_attention",
  ];
  for (const jobState of all) {
    const stages = deriveStages(evidence({ jobState }));
    assert.deepEqual(
      stages.map((s) => s.label),
      ["Upload", "Queued", "Processing", "Quality checks", "Ready for review"],
    );
  }
});

test("only recognized codes produce a staff error summary", () => {
  assert.equal(
    pipelineErrorSummary("source_checksum_mismatch"),
    "Source checksum mismatch",
  );
  for (const code of [null, "", "private_tenant_label", "constructor"])
    assert.equal(pipelineErrorSummary(code), null);
});

const detail = (over: Partial<PipelineDetail>): PipelineDetail => ({
  id: "0a1b2c3d-0000-4000-8000-123456789abc",
  title: "t",
  startedAt: "2026-11-01T00:00:00.000Z",
  startedLabel: "x",
  collector: "c",
  status: "completed",
  statusNote: null,
  error: null,
  stages: [],
  source: { format: null, size: null, duration: null, hash: null },
  jobId: "job",
  jobState: "succeeded",
  clipCount: 2,
  ...over,
});

test("actions: review clips only for an accepted result; no fake controls", async () => {
  const ok = await pipelineActionsFor(detail({}));
  assert.equal(
    ok.reviewClipsHref,
    "/data-browser?recordingId=0a1b2c3d-0000-4000-8000-123456789abc",
  );
  assert.deepEqual(ok.control, []);
  for (const over of [
    { clipCount: 0 },
    { jobId: null },
    { jobState: "running" as const, status: "processing" as const },
    { status: "failed" as const, jobState: "failed" as const },
  ])
    assert.equal(
      (await pipelineActionsFor(detail(over))).reviewClipsHref,
      null,
    );
  assert.deepEqual(
    await noJobControl.forJob({
      recordingId: "r",
      jobId: "j",
      state: "failed",
    }),
    [],
  );
});

test("actions: provider output for another job or stale state is dropped", async () => {
  const provider = {
    async forJob() {
      return [
        {
          kind: "cancel" as const,
          jobId: "job",
          expectedState: "running" as const,
        },
        {
          kind: "retry" as const,
          jobId: "older",
          expectedState: "running" as const,
        },
        {
          kind: "retry" as const,
          jobId: "job",
          expectedState: "failed" as const,
        },
      ];
    },
  };
  const out = await pipelineActionsFor(
    detail({ status: "processing", jobState: "running", clipCount: null }),
    provider,
  );
  assert.deepEqual(
    out.control.map((a) => a.kind),
    ["cancel"],
  );
});
