# Shared Rerun clip review

Updated: 2026-10-31. Implementation target, not a running web integration. [Data browser](data-browser-and-datasets.md) owns navigation/membership; [contracts](../contracts.md) owns wire fields; [processing](cloud-processing.md) owns observations.

## One page and one viewer

Use `/clips/[clipId]` for both staff and customers. Open it from the Data browser grid; show a friendly title and parent breadcrumb, without a raw path/UUID chip or a Clip review sidebar item. The UUID identifies immutable RGB, observations and mapping from one accepted processing result. Labels and reviews remain outside the RRD, so a label change never requires rerunning inference.

Staff watch, edit the task label if needed, and **Approve or Reject**. Notes are optional; approval needs a nonblank label and current review revision. No inspection checkbox, acknowledgement, rejection dialog, other-clips section or large yellow callout. Customers get the same viewer with the currently authorized approved task label and no review mutations, internal notes or internal QC. Server capabilities control responses and mutations; hiding controls is insufficient.

## Packages, assets and license

Pin Python **`rerun-sdk==0.22.1`** and framework-independent **`@rerun-io/web-viewer@0.22.1`** initially, matching the existing local processing environment. Own a small browser-only React adapter in `apps/web`: dynamically import the package in an effect, construct `WebViewer`, call `start(url, element, {width, height})`, and call `stop()` on unmount/replacement. Handle effect cleanup during async startup and React development remounts; allow one active instance. The [versioned README](https://raw.githubusercontent.com/rerun-io/rerun/0.22.1/rerun_js/web-viewer/README.md) specifies these APIs and requires matching viewer/SDK versions. Upgrade them together after replay tests.

Avoid the 0.22.1 React wrapper: its [package dependencies](https://raw.githubusercontent.com/rerun-io/rerun/0.22.1/rerun_js/web-viewer-react/package.json) include React 18 as a runtime dependency, creating an unnecessary conflict with a newer Next.js React stack. The framework-independent adapter keeps our chosen React version.

Bundle/self-host the pinned JavaScript and WASM with Next.js; no external `app.rerun.io` iframe, hosted Rerun service or live Python viewer server is needed. The package uses relative dynamic imports and WASM loading, so a real production build must qualify asset paths, `application/wasm`, cache headers and browser support. Its roughly 27.6 MiB uncompressed WASM is a separate initial-load cost from media. The pinned code provides [MIT](https://github.com/rerun-io/rerun/blob/0.22.1/LICENSE-MIT) and [Apache-2.0](https://github.com/rerun-io/rerun/blob/0.22.1/LICENSE-APACHE) licenses; preserve applicable notices and audit bundled dependencies.

## Worker artifact and bounded reads

Inside the existing `process_recording` invocation, write **one customer-safe `viewer.rrd` per clip**, plus a thumbnail. No new workflow stage or GPU is required. Start with a maximum 60-second clip, 128 MiB RRD and spatial review proxy at most 1280×720; these are proposed qualification limits, not measured capacity. Preserve native frame cadence and exact frame mapping. Shorten clip boundaries when necessary to meet byte limits; do not silently drop review frames. Keep native-resolution RGB/pose arrays separately for export.

Allowlist only clip RGB encoded images, corresponding 2D points/edges, model-relative 3D estimates and safe missingness indicators. Log one RGB entity with overlays as children, rather than duplicating the image for each view. Use separate left/right model-local 3D panes; their distance is not measured inter-hand geometry. Clear missing entities at every frame and omit edges with invalid endpoints, preventing stale hand drawings. Use clip-relative time/frame index in the viewer and retain exact integer native clocks/transforms in the frame-map file. Quietly label the 3D pane **Model-relative 3D estimate**.

Reuse reviewed topology/conversion patterns from [the local visualizer](../../scripts/geometry_visualizer.py), not its complete audit RRD: existing diagnostics can duplicate images and contain staff-only metadata. No collector identity, internal note, raw source path, unrelated clip or hidden QC entity belongs in the shared RRD. A hidden Rerun panel is not an access boundary. Required outputs are hashed/API-completed/sealed with the other job artifacts. Retain RRDs/thumbnails while clips remain referenced; they are review assets, not a dependency of the portable training format.

The API authorizes the clip, then issues a short-lived direct R2 GET URL for the exact allocated RRD. Storage CORS permits the application origin. This viewer version has no custom bearer-header option, and its [HTTP loader](https://github.com/rerun-io/rerun/blob/0.22.1/crates/store/re_log_encoding/src/stream_rrd_from_http.rs) incrementally decodes a sequential response; do not promise HTTP Range seeking or safe two-hour browser loads. A **Reload viewer** action reauthorizes and replaces an expired/failed connection; keep form edits intact. No signed URL appears in the shareable page URL or logs.

## Automatic quality checks

Below the staff viewer, show a compact neutral **Automatic quality checks** panel populated from actual worker results. Each row has a name, status, measurement where relevant and short explanation:

| Check | What it establishes |
| --- | --- |
| Source checksum | Computed SHA-256 matches the sealed source declaration |
| MCAP / RGB decode | Source and required video frames decoded without declared errors |
| Frame mapping | Every output frame has its required source-frame/PTS mapping; not verified cross-clock synchronization |
| Landmark arrays | Expected 21-point shape, finite coordinates where valid, explicit masks for missing observations |
| Hand-detection coverage / missing frames | Frames with at least one detected hand versus all decoded RGB frames, plus separate side counts if available; percentages use this explicit denominator and are not anatomical accuracy |

Statuses are `pass`, `warn`, `fail`, `measured`, `not_evaluated`. A percentage alone is **measured**, not automatically a quality pass. Any threshold-based warning records its configured rule revision. Integrity/decode failures block result acceptance; the Pipeline shows their errors. A failed-preview mock illustrates recovery, not a reviewable accepted corrupt result. Anatomical accuracy, metric 3D and unqualified synchronization remain not evaluated. Customers receive none of this internal panel. Model/code provenance stays in durable manifests rather than substituting for check results.

## Integration acceptance

Prove real local worker RRD → authenticated API → private object storage → production Next.js bundle → embedded viewer, including missing-frame clearing, raster transforms, browser capability errors, URL expiry/reload and `stop()` cleanup. Test staff/customer on the same URL; reject direct URLs for unapproved/unshared clips, revoked users and arbitrary file IDs. Measure artifact bytes, peak worker/browser memory, frame cadence and viewer startup time on representative footage before admitting long inputs. The offline mock is an HTML/SVG stand-in; desktop Rerun sample success does not establish this web integration.
