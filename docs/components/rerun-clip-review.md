# Embedded Rerun clip viewer (SA-38)

Client adapter for the **real** pinned `@rerun-io/web-viewer` 0.41.0 (matches the SA-61 `rerun-sdk` 0.41.0 RRDs). No HTML/SVG stand-in, no Rerun-hosted origin.

## Pieces (`apps/web`)

- `lib/rerun/bounded-rrd.ts`: fetches one server-issued clip URL: allowed origins only (HTTPS, or loopback HTTP), no credentials/redirects/cache, MIME allow-list, default 128 MiB cap enforced on the stream, `RRF2` magic checked on the assembled bytes. Errors are typed (`expired` for 401/403/410, `too_large`, `bad_content_type`, `not_rrd`, …).
- `lib/rerun/clip-viewer.ts`: framework-independent `createClipViewer(parent, options)` → `{ load(resolver), stop() }`. Lazy-imports the viewer (client only). `load` calls the resolver for a fresh URL and, on `expired`, asks again once (a fresh issuance re-checks access server-side). Viewer start/close/open/stop are serialized; superseded loads and `stop()` during a pending start are handled; every object URL is revoked.
- `components/rerun/clip-viewer.tsx`: React wrapper (`resolveUrl`, `allowedOrigins`), Try again on failure, quiet caption that 3D shapes are model estimates.
- `scripts/platform/rerun-assets.mjs`: run by the web `build`/`dev` scripts; verifies the package's WASM SHA-256 and copies it to git-ignored `public/rerun/0.41.0/`. `next.config.ts` serves it `immutable` and stops webpack from also bundling a 64 MB copy. Hosted Render builds get it through `pnpm build`.
- `app/dev/rerun-viewer`: test seam only; 404 unless `STATEACTION_VIEWER_HARNESS_ORIGIN` is a `http://127.0.0.1` origin and the service is not hosted (`APP_ENV=production` / `RENDER=true`).

## Seam to the signed-read broker (not built here)

The component takes `resolveUrl(signal) → Promise<string>`. The future broker (SA-35 grants) must return a short-lived URL for an authorized, clip-safe RRD whose bytes already exclude staff data; the viewer never filters entities client-side. Storage needs CORS for the app origin and `application/octet-stream`.

## Tests

- `pnpm --filter @stateaction/web test` includes `rerun-bounded-rrd` and `rerun-clip-viewer` (chunk-split magic, caps, expiry, rapid supersede, stop during pending module/start, no leaked object URLs).
- `test-e2e/rerun-viewer.e2e.test.mjs`: needs a prior build. Real `next start` production server, headless Chrome (agent-browser), loopback storage stand-in, the real SA-61 golden RRD (`test-e2e/fixtures/golden-clip.rrd`, synthetic published case) or `SA38_RRD_DIR/{a,b}.rrd`. Checks self-hosted WASM bytes/cache, no non-loopback hosts, `/rgb` entity allow-list, WebCodecs `avc1` decode without errors, sequential loads, one fresh issuance after expiry, persistent expiry + retry, unmount removes the canvas. Run the whole command inside `agent-resource run --` (the browser daemon included); it writes ignored `artifacts/sa38/qualification-*.json`.

## Not covered (explicit)

Customer/staff authorization and view grants (SA-35), staff-only data exclusion at the broker, persistent unsaved staff edits (SA-39), real SeaweedFS/R2 transfers (SA-43), Safari/Firefox/phone browsers, WASM/GPU memory (only JS heap is recorded), missing-hand clearing visual readback (the golden clip has no hands; the SA-61 spike covers it).
