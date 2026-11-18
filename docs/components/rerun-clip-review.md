# Embedded Rerun clip viewer (SA-38)

The shared viewer loads worker RRDs with the pinned `@rerun-io/web-viewer` and
`rerun-sdk` 0.41.0. The Next build serves one versioned WASM file with immutable
caching. `scripts/platform/rerun-assets.mjs` verifies the file checksum before
copying it into `public/rerun/0.41.0/`.

`ClipViewer` receives the selected `clipId`, an optional `datasetId`, and
the allowed storage origins from trusted configuration. It requests only
`viewer_rrd` from the [dataset read broker](dataset-access.md). Dataset context
scopes the grant when provided. The broker rechecks access on every request,
including renewal. The viewer expects the worker to export clip-safe bytes and
renders the RRD it receives.

`createClipViewer` owns the request, viewer instance, and object URL.
Selection changes abort pending fetches and close the previous recording.
The adapter serializes viewer operations and revokes the object URL after
closing its recording or stopping the viewer. `fetchBoundedRrd` checks origin,
MIME, RRD magic, and a streaming byte limit of 128 MiB by default. It fetches
storage without credentials or redirects. An expired storage response prompts
one fresh broker request. The UI offers a manual retry and labels 3D hand
shapes as model estimates.

## Local evidence

The production-build browser test exercises real Better Auth sessions, the
dataset broker, the bounded S3 fixture, and the published synthetic SA-61 RRD.
A loopback proxy adds CORS headers and simulates expiry. The test checks WASM
integrity and caching, the clip's entity paths, H.264 WebCodecs decode, sequential
loads, cancellation, revoked access, and teardown. The harness returns 404 in
hosted environments and requires an explicit loopback origin for local tests.

Run `pnpm --filter @stateaction/web test` for the fetch and lifecycle unit tests.
The browser test runs in the full local CI suite. A focused run needs a guarded
production build, the bounded fixtures, and Chrome. It writes
startup, transfer, and JavaScript heap samples to ignored
`artifacts/sa38/qualification-*.json`.

Persistent staff edits belong to SA-39. The golden clip has no hands, so it
does not exercise visual clearing of a prior hand overlay. Real R2 CORS and
signed renewal, additional desktop and phone browsers, and WASM/GPU memory
measurement remain qualification work in SA-78.
