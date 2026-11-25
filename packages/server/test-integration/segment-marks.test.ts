import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { validateValue } from "@stateaction/contracts";
import { advanceResult } from "../src/acceptance/service.js";
import { datasetRoutes } from "../src/datasets/http.js";
import {
  getSegmentMarks,
  recordSegmentMark,
  storedSegmentIds,
} from "../src/datasets/marks.js";
import { parsePipelineQuery } from "../src/pipeline/model.js";
import { listPipelineRecordings } from "../src/pipeline/queries.js";
import { TransportError } from "../src/transport/errors.js";
import type { AcceptanceDb } from "./acceptance-harness.js";
import {
  captionsDoc,
  jobFacts,
  recipeJob as recipeJobWith,
  runRecipe,
  seal,
  segmentsDoc,
} from "./recipe-harness.js";

/**
 * SA-99 segment marks (migration 012) on real PostgreSQL rows (restricted
 * application role, owner role for the trigger and CHECK probes) and real
 * object storage: a recipe job runs through the real services, is accepted,
 * and marks are recorded against its pinned segments.json digest.
 */
const open: AcceptanceDb[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});
const recipeJob = () => recipeJobWith({}, (db) => open.push(db));

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) =>
      error instanceof TransportError
        ? error.code
        : ((error as { code?: string }).code ?? `unexpected:${String(error)}`),
  );

// ------------------------------------------------- SA-99 segment marks (012)

/** An accepted recipe job plus a mark helper bound to its pinned result. */
async function acceptedForMarks() {
  const s = await recipeJob();
  const r = await runRecipe(s);
  await seal(s, r);
  assert.equal(
    (await advanceResult(s.accept, s.jobId))?.candidateStatus,
    "accepted",
  );
  const ids = segmentsDoc(s).rows.map(
    (row: { segment_id: string }) => row.segment_id,
  );
  const segFile = r.files.find((f) => f.role === "segments_json")!;
  const segmentsSha = segFile.sha;
  const segmentsFileId = segFile.fileId;
  const source = storedSegmentIds(s.db.app, s.accept.reader);
  const staff = s.db.actors.staff;
  const mark = (
    segment: string,
    over: Record<string, unknown> = {},
    by = staff,
  ) =>
    recordSegmentMark(s.db.app, source, {
      recordingId: s.recordingId,
      segmentId: segment,
      reviewerUserId: by,
      command: {
        markId: randomUUID(),
        jobId: s.jobId,
        segmentsSha256: segmentsSha,
        expectedRevision: 0,
        verdict: "good",
        ...over,
      } as never,
    });
  return { s, ids, segmentsSha, segmentsFileId, source, staff, mark };
}

test("marks append revisions, the newest wins, history stays and counts follow", async () => {
  const { s, ids, staff, mark } = await acceptedForMarks();
  const first = await mark(ids[0]!);
  assert.deepEqual(
    [first.revision, first.verdict, first.issueType, first.replayed],
    [1, "good", null, false],
  );
  const issue = await mark(ids[0]!, {
    expectedRevision: 1,
    verdict: "issue",
    issueType: "boundary",
    note: "  Starts late ",
  });
  assert.deepEqual(
    [issue.revision, issue.verdict, issue.issueType, issue.note],
    [2, "issue", "boundary", "  Starts late "],
  );
  await mark(ids[1]!, { verdict: "issue", issueType: "caption" });
  const listing = await getSegmentMarks(s.db.app, {
    viewerUserId: staff,
    recordingId: s.recordingId,
  });
  assert.equal(validateValue("http.segment-marks.v1", listing).valid, true);
  assert.deepEqual(
    [listing.segmentCount, listing.checkedCount, listing.issueCount],
    [3, 2, 2],
  );
  assert.equal(listing.marks.find((m) => m.segmentId === ids[0])?.revision, 2);
  // Append-only: both revisions of segment 0 are still stored.
  const rows = await s.db.owner.query(
    "SELECT count(*)::int AS n FROM segment_marks WHERE segment_id = $1",
    [ids[0]],
  );
  assert.equal(rows.rows[0].n, 2);
  // The Pipeline list shows the real team-check counts.
  const pipeline = await listPipelineRecordings(
    s.db.app,
    staff,
    parsePipelineQuery({}),
  );
  const item = pipeline.items.find((i) => i.id === s.recordingId);
  assert.deepEqual([item?.counts.teamChecks, item?.counts.teamIssues], [2, 2]);
  // Model output is untouched: no mark writes to jobs, files or counts.
  assert.equal((await jobFacts(s)).segment_count, 3);
});

test("a stale expectedRevision conflicts and an identical markId replays", async () => {
  const { ids, mark, s } = await acceptedForMarks();
  const markId = randomUUID();
  const first = await mark(ids[0]!, { markId });
  const replay = await mark(ids[0]!, { markId });
  assert.deepEqual(
    [replay.replayed, replay.revision, replay.markId],
    [true, 1, first.markId],
  );
  // Same id, different body.
  assert.equal(
    await code(
      mark(ids[0]!, { markId, verdict: "issue", issueType: "caption" }),
    ),
    "idempotency_conflict",
  );
  // A second reviewer acting on revision 0 loses the race.
  assert.equal(await code(mark(ids[0]!, { expectedRevision: 0 })), "conflict");
  assert.equal(await code(mark(ids[0]!, { expectedRevision: 5 })), "conflict");
  const n = await s.db.owner.query(
    "SELECT count(*)::int AS n FROM segment_marks WHERE segment_id = $1",
    [ids[0]],
  );
  assert.equal(n.rows[0].n, 1);
});

test("mark replay survives changes to the live pointer and recording retirement", async () => {
  const { ids, mark, s, staff } = await acceptedForMarks();
  const markId = randomUUID();
  const first = await mark(ids[0]!, { markId });
  // Only the live pointer changes. The accepted result is still selected.
  await s.db.owner.query(
    "UPDATE recordings SET current_job_id = NULL WHERE id = $1",
    [s.recordingId],
  );
  const replay = await mark(ids[0]!, { markId });
  assert.deepEqual([replay.replayed, replay.markId], [true, first.markId]);
  assert.equal(
    await code(
      mark(ids[0]!, { markId, verdict: "issue", issueType: "caption" }),
    ),
    "idempotency_conflict",
  );
  const next = await mark(ids[0]!, { expectedRevision: 1 });
  assert.equal(next.revision, 2);

  await s.db.owner.query(
    "UPDATE recordings SET deleted_at = now() WHERE id = $1",
    [s.recordingId],
  );
  assert.equal((await mark(ids[0]!, { markId })).replayed, true);
  assert.equal(await code(mark(ids[0]!, { expectedRevision: 2 })), "not_found");
  assert.ok(staff);
});

test("an issue without a type, a good with one and an oversized note are rejected", async () => {
  const { ids, mark, s, segmentsSha, segmentsFileId } =
    await acceptedForMarks();
  assert.equal(
    await code(mark(ids[0]!, { verdict: "issue" })),
    "invalid_request",
  );
  assert.equal(
    await code(mark(ids[0]!, { verdict: "good", issueType: "caption" })),
    "invalid_request",
  );
  assert.equal(
    await code(mark(ids[0]!, { note: "n".repeat(2001) })),
    "invalid_request",
  );
  // The database refuses the same shapes for every writer, owner included.
  for (const [verdict, issueType, note] of [
    ["issue", null, null],
    ["good", "caption", null],
    ["good", null, "n".repeat(2001)],
  ] as const)
    assert.equal(
      await code(
        s.db.owner.query(
          `INSERT INTO segment_marks (id, job_id, segments_sha256, segments_file_id, segment_id, revision,
             reviewer_user_id, verdict, issue_type, note)
           VALUES ($1, $2, $3, $9, $4, 1, $5, $6, $7, $8)`,
          [
            randomUUID(),
            s.jobId,
            segmentsSha,
            ids[0],
            s.db.actors.staff,
            verdict,
            issueType,
            note,
            segmentsFileId,
          ],
        ),
      ),
      "23514",
    );
});

test("marks are append-only for every writer and staff only", async () => {
  const { ids, mark, s } = await acceptedForMarks();
  const stored = await mark(ids[0]!);
  for (const sql of [
    "UPDATE segment_marks SET verdict = 'issue', issue_type = 'caption'",
    "DELETE FROM segment_marks",
  ]) {
    assert.equal(await code(s.db.owner.query(sql)), "SAC01", sql);
    assert.equal(await code(s.db.app.query(sql)), "42501", sql);
  }
  // PostgreSQL requires the referencing table in the same statement before
  // the segment_marks BEFORE TRUNCATE trigger can run.
  await assert.rejects(
    s.db.owner.query("TRUNCATE segment_marks, caption_corrections"),
    { code: "SAC01", message: "segment_marks rows are immutable (TRUNCATE)" },
  );
  await assert.rejects(s.db.owner.query("TRUNCATE caption_corrections"), {
    code: "SAC01",
    message: "caption_corrections rows are immutable (TRUNCATE)",
  });
  const { rows } = await s.db.app.query(
    `SELECT has_table_privilege('public.segment_marks', 'TRUNCATE') AS marks,
            has_table_privilege('public.caption_corrections', 'TRUNCATE') AS corrections`,
  );
  assert.deepEqual(rows, [{ marks: false, corrections: false }]);
  for (const who of [
    s.db.actors.collector,
    s.db.actors.customer,
    s.db.actors.outsider,
  ])
    assert.equal(await code(mark(ids[1]!, {}, who)), "forbidden");
  assert.equal(
    await code(
      getSegmentMarks(s.db.app, {
        viewerUserId: s.db.actors.customer,
        recordingId: s.recordingId,
      }),
    ),
    "forbidden",
  );
  assert.equal(stored.revision, 1);
});

test("a mark for a segment or digest of another result is rejected", async () => {
  const { ids, mark, s, segmentsSha, segmentsFileId } =
    await acceptedForMarks();
  // A segment id that is not in this job's segments.json.
  assert.equal(await code(mark(randomUUID())), "not_found");
  // Another job id or digest does not match the recording's accepted result.
  assert.equal(await code(mark(ids[0]!, { jobId: randomUUID() })), "conflict");
  assert.equal(
    await code(mark(ids[0]!, { segmentsSha256: "0".repeat(64) })),
    "conflict",
  );
  // The database pins the digest and the job state for every writer too.
  assert.equal(
    await code(
      s.db.owner.query(
        `INSERT INTO segment_marks (id, job_id, segments_sha256, segments_file_id, segment_id,
           revision, reviewer_user_id, verdict) VALUES ($1, $2, $3, $6, $4, 1, $5, 'good')`,
        [
          randomUUID(),
          s.jobId,
          "0".repeat(64),
          ids[0],
          s.db.actors.staff,
          segmentsFileId,
        ],
      ),
    ),
    "SAC04",
  );
  assert.equal(
    await code(
      s.db.owner.query(
        `INSERT INTO segment_marks (id, job_id, segments_sha256, segments_file_id, segment_id,
           revision, reviewer_user_id, verdict) VALUES ($1, $2, $3, $6, $4, 2, $5, 'good')`,
        [
          randomUUID(),
          s.jobId,
          segmentsSha,
          ids[0],
          s.db.actors.staff,
          segmentsFileId,
        ],
      ),
    ),
    "SAC03",
  );
  const n = await s.db.owner.query(
    "SELECT count(*)::int AS n FROM segment_marks",
  );
  assert.equal(n.rows[0].n, 0);
});

test("a failed-caption segment can still be marked, through the HTTP routes", async () => {
  const { s, segmentsSha, source, staff } = await acceptedForMarks();
  const routes = datasetRoutes({
    pool: s.db.app,
    signer: { presignRead: async () => "https://objects.test/x" },
    segmentIds: source,
    authenticate: async (request, need) => {
      const userId = request.headers.get("x-test-user");
      const { rows } = await s.db.owner.query(
        "SELECT 1 FROM access WHERE user_id = $1 AND role = 'staff' AND enabled",
        [userId],
      );
      return userId && (need !== "staff" || rows.length)
        ? { ok: true, principal: { userId } }
        : {
            ok: false,
            response: Response.json(
              { error: { code: "forbidden" } },
              { status: 403 },
            ),
          };
    },
  });
  // This segment's caption failed (a recorded failure, not an empty result).
  const segments = segmentsDoc(s);
  const failedRow = captionsDoc(s, segments, segmentsSha).rows.find(
    (row: { status: string }) => row.status === "failed",
  );
  assert.ok(failedRow, "the captions fixture has a failed row");
  const failedSegment: string = failedRow.segment_id;
  const post = (segment: string, body: unknown, user = staff) =>
    routes.postSegmentMark(
      new Request("http://web.test/x", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": user },
        body: JSON.stringify(body),
      }),
      s.recordingId,
      segment,
    );
  const command = {
    markId: randomUUID(),
    jobId: s.jobId,
    segmentsSha256: segmentsSha,
    expectedRevision: 0,
    verdict: "issue",
    issueType: "caption",
  };
  const created = await post(failedSegment, command);
  assert.equal(created.status, 201);
  const body = (await created.json()) as { data: unknown };
  assert.equal(validateValue("http.segment-mark.v1", body.data).valid, true);
  assert.equal((await post(failedSegment, command)).status, 200);
  assert.equal(
    (
      await post(failedSegment, {
        ...command,
        markId: randomUUID(),
        issueType: undefined,
      })
    ).status,
    422,
  );
  assert.equal(
    (await post(failedSegment, { ...command, markId: randomUUID() })).status,
    409,
  );
  assert.equal(
    (await post(failedSegment, command, s.db.actors.customer)).status,
    403,
  );
  const listed = await routes.getSegmentMarks(
    new Request("http://web.test/x", { headers: { "x-test-user": staff } }),
    s.recordingId,
  );
  const data = (
    (await listed.json()) as {
      data: { checkedCount: number; issueCount: number };
    }
  ).data;
  assert.deepEqual([data.checkedCount, data.issueCount], [1, 1]);
});

test("the same markId sent twice at once appends one revision and replays", async () => {
  const { ids, mark } = await acceptedForMarks();
  const markId = randomUUID();
  const both = await Promise.all([
    mark(ids[0]!, { markId }),
    mark(ids[0]!, { markId }),
  ]);
  assert.deepEqual(
    both.map((m) => m.revision),
    [1, 1],
  );
  assert.deepEqual(both.map((m) => m.replayed).sort(), [false, true]);
});

test("a markId is bound to its recording, and a multi-byte note counts code points", async () => {
  const { s, ids, mark, source, segmentsSha, staff } = await acceptedForMarks();
  const markId = randomUUID();
  await mark(ids[0]!, { markId });
  const other = await recordSegmentMark(s.db.app, source, {
    recordingId: randomUUID(),
    segmentId: ids[0]!,
    reviewerUserId: staff,
    command: {
      markId,
      jobId: s.jobId,
      segmentsSha256: segmentsSha,
      expectedRevision: 0,
      verdict: "good",
    } as never,
  }).then(
    () => "ok",
    (error: { code?: string }) => error.code,
  );
  assert.equal(other, "idempotency_conflict");
  // 2000 emoji are 2000 code points (4000 UTF-16 units): accepted; 2001 are not.
  const emoji = (n: number) => "\u{1F600}".repeat(n);
  assert.equal((await mark(ids[1]!, { note: emoji(2000) })).note?.length, 4000);
  assert.equal(
    await code(mark(ids[2]!, { note: emoji(2001) })),
    "invalid_request",
  );
});
