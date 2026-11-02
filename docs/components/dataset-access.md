# Dataset APIs, sharing evidence and the read broker (SA-35)

Implemented in `packages/server/migrations/008_dataset_sharing.sql`, `packages/server/src/datasets/` and the web routes under `apps/web/app/api/v1/{datasets,clips}`. The design sources are the approved data-browser-and-datasets and [auth-and-access](auth-and-access.md) component designs; this page records what the code enforces.

## Visibility rule (one definition)

A clip is visible in dataset D to viewer V only when all of these hold in the statement that reads it:

1. V holds an enabled role (`staff`, or `customer`) in `access`, re-read from the database on every request. Sessions come from the same Better Auth instance and restricted application pool as every other route; there is no custom token and no owner credential in a request path.
2. The clip is a row of `dataset_clips` for D.
3. The clip's **latest** review is `approved`.
4. The clip belongs to its recording's `current_job_id`, that job is `succeeded`, and the recording is not deleted. A retry or deletion hides stale outputs.
5. Customers only: an enabled `dataset_access` grant for `(D, V)` that rests on **active** recipient-sharing evidence which has **cleared this clip**.

`listDatasets` counts, `listDatasetClips` pages, `getClip` and the read broker all use this one SQL fragment (`datasets/queries.ts`), so counts and hours are distinct, currently visible members, never a separate snapshot. Counts aggregate each returned dataset through the membership index with `LIMIT` paging on exact microsecond keyset cursors (default 24, maximum 100).

Customers have no catalog: `/api/v1/clips` (All clips, any recording filter) is staff only and a customer asking for any clip or dataset they are not currently granted receives the same 404 as for a missing one. Filter parameters other than `limit` and `cursor` are rejected on customer-reachable routes; any back-navigation filters are UI state.

## Approved-only membership

`dataset_clips` insert triggers (003) require the clip's latest review to be approved and the actor to be enabled staff, under the shared clip lock; a rejection removes memberships before appending, and a rejection that would leave a member is refused (`SAC02`). The API (`addDatasetMembers`) repeats this for precise errors and additionally requires the current accepted result. A forged direct insert of a pending or rejected clip fails at the database whatever the caller.

## Recipient-sharing evidence (operator only)

Capture or processing permission (`ingest_permissions`) never authorizes external inspection. Migration 008 adds:

- `dataset_sharing_permissions`: operator-recorded external-inspection cover for one recipient of one dataset (`permission_ref`, evidence reference, recorder). Identity is immutable; status moves only `active → revoked`; one active row per `(dataset, recipient)`; recipients must be enabled customers.
- `dataset_sharing_clearances`: the operator's per-clip confirmation, bound to one evidence row. Evidence never blanket-authorizes future clips. Only latest-approved clips can be cleared; rows are append-only and die with their evidence.
- `dataset_access.sharing_permission_id`: a grant can be enabled only against active evidence for the same `(dataset, recipient)` with every current approved member cleared. Legacy grants without evidence are not effective (reads join the evidence).
- A `dataset_clips` insert guard: every enabled recipient of the dataset needs active evidence **and** a clearance for that clip, or the addition fails (`SAC05`).
- Revoking evidence disables the grants resting on it in the same transaction; reads join evidence and clearance regardless, so visibility ends on the next request.

The web role has `SELECT` on these tables and no `EXECUTE` on `catalog_set_dataset_access`; there is no HTTP route for grants or evidence. The operator uses the owner credential:

```bash
pnpm --filter @stateaction/server dataset-sharing record  --ref R --dataset D --recipient USER --evidence DOCREF --by OPERATOR
pnpm --filter @stateaction/server dataset-sharing clear   --ref R --all-members --by OPERATOR   # or --clips ID,ID
pnpm --filter @stateaction/server dataset-sharing grant   --ref R --actor STAFF_USER_ID
pnpm --filter @stateaction/server dataset-sharing revoke  --ref R --by OPERATOR --reason TEXT
pnpm --filter @stateaction/server dataset-sharing disable --dataset D --recipient USER --actor STAFF_USER_ID
pnpm --filter @stateaction/server dataset-sharing list    --dataset D
```

Lock order extends catalog.md: clip locks, then dataset rows, then evidence rows `FOR SHARE`; revocation only updates the evidence row. This is a manual pilot rule with recorded references, not a policy engine or UI checkbox.

## Routes

| Route                                             | Who             | Notes                                                                                |
| ------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------ |
| `GET/POST /api/v1/datasets`                       | staff, customer | POST staff only; client-chosen `datasetId`, replay returns 200                       |
| `GET/PATCH /api/v1/datasets/{id}`                 | staff, customer | PATCH staff only, `expectedRevision`                                                 |
| `GET/POST /api/v1/datasets/{id}/clips`            | staff, customer | POST staff only; up to 100 clips, `expectedRevision`                                 |
| `GET/DELETE /api/v1/datasets/{id}/clips/{clipId}` | staff, customer | DELETE staff only, `?expectedRevision=N`                                             |
| `POST /api/v1/datasets/{id}/clips/{clipId}/reads` | staff, customer | exact dataset context                                                                |
| `GET /api/v1/clips`                               | staff           | All clips with review status                                                         |
| `GET /api/v1/clips/{clipId}`, `POST …/reads`      | staff, customer | direct links: customers are authorized through any dataset currently granted to them |

Bodies are `application/json`, at most 64 KiB, unknown fields rejected. Mutations pass the Better Auth origin/Fetch-Metadata/client-header checks. All responses are `Cache-Control: private, no-store`; failures use the `{error: {code, message, retryable}, requestId}` envelope, driver messages are replaced by generic ones, and customer-visible failures are 404 so existence is not disclosed.

## Customer-safe DTOs

Customer clip payloads are whitelisted in `datasets/queries.ts`: `clipId`, optional `datasetId`, `title`, `taskLabel`, `durationNs`, `raster`, `frameCount`, `simulation`, `media {thumbnail, viewer}`. Recording, job, collector, notes, QC, review internals, hashes and object keys never appear; staff additionally receive `recordingId`, `jobId`, `reviewRevision`, `reviewStatus` and `datasetCount`. `simulation` is non-null (`simulated`, `qualification: simulation_only`, `productionQualified: false`) for simulation-only captures: a simulated clip is never presented as hardware evidence.

## Read broker

`POST …/reads {role}` accepts only `thumbnail_jpeg` and `viewer_rrd`. The object key is taken from the clip's own thumbnail or viewer slot, which the database constrains to a completed output of the clip's job, and only after the visibility rule passes. Raw/source/other derived files, files of an unaccepted or superseded job and non-completed files have no path. The URL is a presigned `GET` from the same storage client family uploads use (`S3ReadSigner`, SeaweedFS locally, R2 hosted; credentials stay server-side), valid for at most 60 s (the default and the hard maximum; an injected TTL outside 1..60 is rejected), with `Cache-Control: private, no-store` and the role's content type in the signature. The size is bounded (thumbnail 5 MiB, RRD 128 MiB, the SA-38 limit). A URL already issued cannot be recalled before it expires; revocation stops new URLs on the next request. The browser viewer's trust rules (credential-free allowed-origin fetch of a bounded RRD) are SA-38's.

Until SA-28 lands, "accepted" means the catalog's own `succeeded` current job whose clips were inserted by `acceptProcessingResult`; test fixtures are explicitly synthetic and no fixture claims production success.

## Validation

`packages/server/test-integration/datasets*.test.ts` (restricted-role Postgres: invariants, races, counts/paging, grant/revocation, cross-customer, broker, real signed fetch), `apps/web/test-e2e/datasets.e2e.test.mjs` (production Next with real sessions). Release export, geometry, iOS and hosted deployment are out of scope.

## Atomic review command (SA-36)

Staff-only, no migration. `GET /api/v1/clips/{clipId}/review` returns the review state (immutable `jobId` + `resultManifestSha256`, current revision/decision/task label/notes, bounded history, persisted memberships with dataset revisions, and the available dataset picker context; `membershipsTruncated` / `availableDatasetsTruncated` are never silent). `POST` on the same path is one bounded command (`reviewId` = idempotency key, `expectedReviewRevision`, immutable job/result identity, `decision` approved|rejected, label ≤200, notes ≤4000, optional `datasetSelection`) executed by `catalog.appendReview` in one transaction.

- Lock order: staff role, clip lock, replay lookup, dataset rows `FOR UPDATE` sorted by UUID, recipient evidence `FOR SHARE` (`dataset_sharing_ok`, the same predicate as member add). `lock_timeout` 5 s maps to a retryable 409.
- Omitted `datasetSelection` preserves memberships; explicit `datasetIds: []` clears them all. `expectedRevisions` must name exactly the datasets the change touches (desired set plus current memberships). A stale value, blank label, changed job/result, superseded result or clearance failure changes nothing.
- Rejection (also a withdrawal of an approval; there is no separate DB decision) removes every working membership and bumps each affected dataset once; reapproval never restores them.
- Replay of an identical command (same reviewer, clip, job, hash, decision, label, notes, omitted-vs-explicit selection) returns the stored review (200) without a new revision or reapplication, even after newer reviews. Any change under the same `reviewId` is `idempotency_conflict`.
- Customers have no review route and never receive notes or internal identity. There is no per-episode customer accept/reject route.
- Contracts: `http.clip-review-command.v1`, `http.clip-review.v1`, `http.clip-review-state.v1` (catalog v10 registration pending the v9 checkpoint).
