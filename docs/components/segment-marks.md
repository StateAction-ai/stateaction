# Segment marks (SA-99)

Staff mark each segment of an accepted recording result **Good**, or **Issue**
with an issue type (`boundary`, `caption`, `hand_pose`) and an optional note.
Marks are the team check that qualifies segmentation, captions and hand pose.
They are a separate append-only layer: nothing here edits a segment, a caption
or a hand-pose result.

## Data

Migration `012_segment_marks.sql` adds `segment_marks`:
`id`, `job_id`, `segments_sha256`, `segment_id`, `revision`, `reviewer_user_id`,
`verdict` (`good` | `issue`), `issue_type` (required if and only if `issue`),
`note` (at most 2000 characters), `created_at`. `UNIQUE (job_id, segment_id,
revision)`. It follows the `reviews` pattern of 003:

- Append-only: UPDATE and DELETE are refused for every writer (`SAC01`); the web
  role holds SELECT and INSERT only.
- The newest revision of a (job, segment) wins; older revisions stay as history.
  A new revision must be the latest plus one (`SAC03`).
- A mark is pinned to the exact accepted result: the job must be `succeeded`
  and own a completed `segments_json` file with exactly that digest (`SAC04`).
- The reviewer must hold an enabled staff role (`SAC05`).

## Deploy order (readers first)

Apply migration 012 before deploying the web build: the Pipeline list now
queries `segment_marks`, so the new web code fails on a database without the
table. The migration is additive and older web builds do not touch it.

## API (staff only)

| Route                                                     | Contract                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `GET /api/v1/recordings/{id}/segment-marks`               | `http.segment-marks.v1` (newest mark per segment, counts)          |
| `POST /api/v1/recordings/{id}/segments/{segmentId}/marks` | body `http.segment-mark-command.v1`, answer `http.segment-mark.v1` |

Catalog v18 adds the three contracts. The command carries `markId` (the
idempotency key), the `jobId` and `segmentsSha256` the reviewer saw, and
`expectedRevision` (0 when the segment has no mark). Outcomes: 201 stored, 200
identical replay (also after the accepted result changed: the stored mark is returned), 409 stale revision / changed result / a reused `markId` with
a different body, 404 unknown recording or a segment id that is not in the
accepted `segments.json`, 422 invalid body (an issue without a type), 403 not
staff.

The segment ids exist only in storage, so the route reads the accepted
`segments.json` through the bounded object reader (32 MiB), accepts it only when
its bytes hash to the pinned digest, and caches the id set per digest. A
failed-caption segment can still be marked: marks never look at captions.

## Review page

On `/clips/{clipId}` the selected rail card shows **Good** (`G`),
**Issue** (`B`) with the issue-type picker and an optional note, and **Next
unchecked** (`N`). The rail chips are All, Failed, Issue and Unchecked; the
header reads "n checked, m issue". Every click appends a revision against the
newest one the reviewer saw; a conflict reloads the marks instead of
overwriting them. Fixture data keeps its marks in memory only and is labelled
"Fixture data".

## Pipeline list

The Team checks column counts segments of the current job that have a mark and,
among them, those whose newest mark is an issue.

## Tests

`packages/server/test-integration/stage-runs.test.ts` (SA-99 cases: revisions,
append-only for the owner and the app role, stale revision, replay, issue
without a type, another job's digest or segment, staff only, failed-caption
segment through the HTTP routes, Pipeline counts),
`packages/server/test-integration/migrations.test.ts`, the catalog v18 policy
test and conformance fixtures in `packages/contracts`, and
`apps/web/test/review-marks.test.mjs` (keys, counts, chips, next unchecked,
command and a G, B, N flow).

## Not done here

The browser click path against a real seeded stack waits for the annotations API
and the seed (SA-96); until then the page runs on fixture data.
