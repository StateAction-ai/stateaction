# Output upload contract (UNPUBLISHED PROPOSAL, SA-20)

Status: proposal only. These files are **not** in `packages/contracts`, not in `catalog.v3`, and change no shared registry or lock. Publication is a catalog revision after the profile/catalog.v4 work (PR 14) merges; the root gives the go-ahead and the schemas are then moved into `packages/contracts/api/http/` unchanged apart from the `$id`.

Why: `http.upload-create.v1`/`http.upload-plan.v1` are phone source contracts (they require `recordingId` and a source role). The worker-output routes need closed output-specific equivalents using the existing `outputFileRole`, `safeRelativePath`, `fileSizeBytes` and `sha256` definitions from `common.v1`.

| Proposed id             | Route                                                                               | Shape                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `http.output-create.v1` | `POST /internal/v1/jobs/{jobId}/outputs` request                                    | `{slot, role, sizeBytes, sha256}`; the job comes from the path and the worker credential, never the body |
| `http.output-plan.v1`   | the `data` of that response and of `GET /internal/v1/jobs/{jobId}/outputs/{fileId}` | the `http.upload-plan.v1` shape with `role: outputFileRole`; no source-manifest rule                     |

Part signing and receipts reuse `http.parts-sign.v1`, `http.parts-signed.v1` and `http.parts-receipts.v1` unchanged. Server-enforced limits that the schema cannot express: 32 GiB per file, 64 GiB and 512 files per job, slot idempotency (same slot with different content is `409`).

`fixtures/` holds one valid and several invalid documents; `packages/contracts/test/output-proposal.test.ts` validates them with a private Ajv and checks that nothing is registered.
