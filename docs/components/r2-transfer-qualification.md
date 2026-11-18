# R2 transfer qualification harness (SA-43)

Status, 2026-11-02: **harness source only. No provider call has been made by this harness yet.** It is an explicit opt-in tool for the root to run once against an already-existing private R2 dev bucket. It produces observed pass/fail/not-run evidence. It does not qualify the physical phone, a real browser Rerun load, Modal/hosted compute or hosted CI.

## What it reuses

The harness imports the **built** `packages/server/dist` modules and does not re-implement transport:

- `transport/provider.js` `S3MultipartProvider`: create, `ListParts`, complete, abort, HEAD, `readObject` (full EOF and ranges), exact-key upload listing, `presignUploadPart` (signed `content-length`).
- `transport/plan.js` `planFor`/`partRange`: the 64 MiB part plan.
- `storage.js` `storageClient` and `presignObject` (short presigned GET).

Two things use the SDK directly because the provider cannot express them: the `ListParts` `MaxParts=1` pagination probe (the provider always asks for 1,000) and exact-key `DeleteObject` during cleanup. The pagination result is compared with `provider.listParts`.

## Running

```sh
pnpm --filter @stateaction/server build              # no auto-build
node scripts/platform/qualify-r2-transfers.mjs --config <file>            # dry run: validate + print plan, no network
node scripts/platform/qualify-r2-transfers.mjs --config <file> --execute  # real transfers
```

Exit codes: `0` pass, `1` fail, `2` incomplete (a required case did not execute), `3` config refused, `4` watchdog.

## Config (`stateaction.r2-qualification-config.v1`)

The only input. Nothing is read from `~/.config`, `.env`, `AWS_*` or any credential store. The file must be a regular, non-symlink file owned by the caller with mode `0600`. Unknown keys are refused.

| Key                                          | Rule                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`, `optIn`                            | exact constants; `optIn` is `stateaction-sa43-real-r2-transfer`                                                                                                                                   |
| `provider.endpoint`, `endpointAllowlist`     | endpoint origin must be in the allowlist and be `https://*.r2.cloudflarestorage.com` (loopback allowed only for a local fixture)                                                                  |
| `provider.bucket`, `region`                  | an **existing** bucket; the harness never creates, lists the whole bucket or deletes it                                                                                                           |
| `credentials.accessKeyId`, `secretAccessKey` | held in memory only                                                                                                                                                                               |
| `runPrefix`                                  | agreed unique per run, e.g. `qualification/sa-43/run-<id>/`; relative, ends in `/`, no `..`, starts with `qualification`                                                                          |
| `budgets`                                    | `maxUploadBytes` (<= 150 MiB), `maxDownloadBytes` (<= 512 MiB), `operationTimeoutMs`, `putTimeoutMs`, `runDeadlineMs` (<= 30 min), `cleanupDeadlineMs`. Planned uploads must fit before any call. |
| `fixture` (optional)                         | `tailBytes`, `smallBytes`, `abortBytes` (defaults 1 MiB, 1 MiB, 256 KiB)                                                                                                                          |
| `presign` (optional)                         | `partUrlTtlSeconds` (<= 900), `getTtlSeconds` (5-60), `pollIntervalMs`, `expiryGraceSeconds`                                                                                                      |
| `cors.allowedOrigin`, `deniedOrigin`         | exact origins, no wildcard                                                                                                                                                                        |
| `rrd` (optional)                             | `{path, sha256, sizeBytes}` of a genuine RRD supplied by the root                                                                                                                                 |
| `cleanup`                                    | `delete-owned` (default) or `keep-owned`                                                                                                                                                          |
| `evidenceDir`                                | absolute and **must not exist**; inside the repo only under ignored `artifacts/`                                                                                                                  |

## Safety properties

- **Hard preconditions, not assertions.** A first case `preflight.keys-unused` requires every owned key (main, lost-reply, abort, RRD) to have no object (HEAD 404) **and** no in-flight upload before anything mutates; every create re-checks its key. A collision fails the run with zero create/PUT/abort/delete calls and never touches pre-existing data. A unique prefix is not authority. Required steps use `require` (stop the case) rather than a recorded-and-continue check; RRD size and SHA-256 are verified from a single descriptor before any upload, and the file identity (inode, size, mtime) is rechecked after.
- **Config read hardening.** The config is opened with `O_NOFOLLOW`, owner/mode are checked on the open descriptor (`fstat`) and read from that same descriptor (no check/use gap). It holds real credentials.
- **Abortable, settled operations.** Every SDK call made through the control client inherits the active operation's `AbortSignal`; on timeout the signal is aborted and the harness waits (`settleMs`) for the call to settle before the next case or cleanup. If it does not settle, the operation is recorded as `uncertain`, later cases do not start, owned state is retained for the seven-day lifecycle and cleanup is reported `uncertain` (verdict `fail`), never `pass`. An upload in `completing` state (outcome unknown) is never aborted or deleted by cleanup.
- **One run.** `evidenceDir` is created exclusively and doubles as the run lock. A re-run needs a new config.
- **No retry of ambiguous creation.** `createUpload` is called once per key; a throw is recorded as `ambiguous-create`, the exact-key listing is recorded, and nothing is aborted or deleted on a guess.
- **Cleanup authority** is only keys this run positively created and upload IDs `createUpload` returned. Ambiguous creates, aliases and lost acknowledgements are never deletion authority (left to the seven-day lifecycle). Cleanup verifies absence via HEAD and exact-key listing and fails the run if state remains. `ledger.json` records owned IDs as they are created so an operator can inspect a crashed run.
- **Deadlines.** Every operation is bounded by `min(operationTimeoutMs, remaining run time)`, plus a watchdog at `runDeadlineMs + cleanupDeadlineMs + 30 s`.
- **Budgets.** Uploads are reserved before each PUT, including stale and failed attempts (a refused body still counts); downloads count actual bytes. Probe, unsigned and preflight response bodies are read through a bounded reader (<= 64 KiB, probes 4 KiB) and cancelled, so a server that ignores `Range` cannot stream a whole object.
- **No secrets in evidence.** Errors keep only class, HTTP status and provider code. Signed URLs stay in memory. The report is scanned for signature parameters and credential values before it is written (`0600`).
- **No private data.** Fixtures are deterministic synthetic bytes (AES-CTR keystream); only an explicitly supplied RRD is read.

## Matrix

| Case                                       | Observes                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mpu.create-out-of-order-upload`           | prefix unused; one create; exact 64 MiB part 1 plus small tail uploaded **2 then 1** by presigned PUTs; ETag receipts; part PUT sent with `Origin` (ETag exposure evidence)                                                                                                                                                                |
| `mpu.list-parts-maxparts-1`                | `ListParts` with `MaxParts=1` takes two pages, parts ordered 1,2, sizes and ETags equal the receipts, and `provider.listParts` agrees. This does **not** claim a 1,000-page listing                                                                                                                                                        |
| `mpu.complete-head-eof-ranges`             | provider complete; HEAD size/ETag/parts count; no in-flight upload; `ListParts` after complete (observed); full-EOF byte count and SHA-256; ranges at start, across the 64 MiB boundary and at EOF; range past EOF refused (416)                                                                                                           |
| `stale.part-url-after-complete`            | old tail part URL PUT with different same-length bytes is refused with an HTTP error (status >= 400; a transport failure is a case failure); HEAD identity unchanged **and full-EOF SHA unchanged**                                                                                                                                        |
| `mpu.lost-client-reply-reconcile`          | a separate one-part object; the provider call really completes and its response is observed, then the **local** acknowledgement is suppressed (controlled injection; this is not real provider ack loss). Reconcile uses HEAD, exact-key listing and full-EOF SHA (HEAD/ETag alone prove nothing about content); exactly one complete sent |
| `stale.part-url-after-complete-small`      | same stale-URL assertion on the lost-reply object, again with a full hash                                                                                                                                                                                                                                                                  |
| `mpu.abort-stale-url`                      | abort (idempotent twice), no in-flight upload, `ListParts` gone, old part URL refused, **no object materialized**                                                                                                                                                                                                                          |
| `access.unsigned-denied`                   | unsigned exact-key GET, unsigned object listing (no `<Key>` enumerated) and unsigned upload listing are denied (401/403/404, or R2's measured missing-Authorization 400, see below)                                                                                                                                                        |
| `presign.short-get-expiry-renewal`         | `getTtlSeconds` (default 10 s) GET: fresh URL works, first denial measured within ttl + grace by bounded polling, a renewed URL works. No long-TTL claim                                                                                                                                                                                   |
| `cors.exact-origin-etag-preflight`         | HTTP-only: preflights echo the exact origin (never `*`), a different origin is not allowed, part PUT response exposes `ETag`. **Not a browser qualification**                                                                                                                                                                              |
| `rrd.immutable-key-private-get` (optional) | a root-supplied genuine RRD uploaded to a content-hash key, EOF hash equals the supplied hash, unsigned GET denied, presigned ranged GET with CORS. Not-run (and not required) without an `rrd` section                                                                                                                                    |

Every case needs at least one assertion to pass. A case whose dependency failed is `not-run`, never passed. The report verdict is `pass` only if every required case passed and cleanup was clean; `incomplete` if a required case did not execute; `fail` otherwise.

## Report

`<evidenceDir>/report.json` (`stateaction.r2-qualification-report.v1`): verdict, case list with assertions and observations, byte/operation usage, cleanup result and `pendingGates`. Opaque keys, upload IDs, sizes, SHA-256, statuses, timings and receipts only.

## Still not qualified by this harness

Physical Android and iOS background upload, a real-browser Rerun viewer load, Modal or hosted workers, hosted CI, a 1,000-page `ListParts`, concurrent upload-creation races (deliberately not raced against R2) and long-TTL presigned GETs. The report lists these as `not-run` pending gates.

## Tests

`r2-qualification.test.mjs` covers config validation (including the symlink/permission read), budgets, deadlines, redaction and verdict rules. `r2-qualification-run.test.mjs` drives the real `runQualification()` against an in-memory S3-like store: happy path with cleanup of owned state only, one-run lock, key collisions (zero create/PUT/abort/delete), a provider that ignores `Range`, an unsigned GET that leaks data (cancelled at the body cap), an unsettled completion and an abort-signal timeout (ledger retained, cleanup `uncertain`) and a stale PUT that mutates bytes (caught by the full hash). No network (`nx run tooling:test`). Layout: `qualify-r2-transfers.mjs` (CLI + production wiring), `r2-qualification-run.mjs` (flow, injected I/O), `r2-qualification-lib.mjs` (pure helpers).

## Measured unsigned-request behaviour

The first real run showed R2 answering unsigned GET/list/uploads/RRD requests with HTTP 400, `Content-Type: application/xml` and exactly `<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidArgument</Code><Message>Authorization</Message></Error>`. That is an explicit missing-`Authorization` rejection, not public access, and the original 401/403/404-only classifier wrongly failed it. The classifier (`classifyUnsignedDenial`) now accepts 401/403/404 and a 400 **only** with that exact bounded (untruncated) XML body and content type, and never when the body lists keys. Any other 400 (different message, malformed or truncated body, generic text) and any 2xx still fail. Only curated facts (status, reason, error code; the report guard forbids the word `Authorization` in evidence, so the message text is not stored) are recorded, never the raw body, signed URLs or secrets. The full-SHA signed read of the same known object still gates the unsigned assertions. Privacy expectations are unchanged. That first run failed because of this classifier.
