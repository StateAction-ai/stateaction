# Pipeline execution and data movement

Updated: 2026-10-31. Canonical MVP stage/handoff table. One shared Render workflow controller invokes the fixed processing function; a follow-up controller adds whole-dataset export, replacing the earlier distributed stage DAG. [Processing](cloud-processing.md) owns extraction/model semantics; [jobs](job-orchestration.md) owns execution/recovery.

## Where each stage runs

| Step / location | Reads | Writes / next handoff |
| --- | --- | --- |
| 1. Flutter/native phone | Hardware H.264 + independent sensor events inside generic MCAP, final metadata/sidecars and owner-bound journal | Native EOS/closed-file acknowledgement precedes byte hashing/seal. Direct multipart parts go to private R2; API receives only metadata. Retain originals under verified cleanup policy. |
| 2. Next.js API / Render Postgres | Authenticated owner, sealed required-file inventory, completed object metadata | Atomically create a `process_recording` job and set recording's current job. Request the corresponding workflow after commit; cron repairs lost dispatch. Task payload is IDs/digests, never video bytes. |
| 3. Render Workflows / Node controllers | Durable job state through the API | Claim the admitted controller run/lease, persist compute-submission intent, spawn/poll the private Modal function and finalize through the API. Minute cron repairs lost dispatch/abandoned controllers. |
| 4a. Modal CPU / extraction | Scoped reads of sealed mixed-schema H.264 MCAP/sidecars or explicit legacy JPEG; native clocks/calibration/frame maps | Stream/hash/parse once. Native H.264 access units remux into IDR-safe MP4 clips; one decoder feeds 4b/inference and proxy encoding. Bounded sensor/frame shards go to the job prefix. |
| 4b. Same Modal invocation / hands and preview | The current decoded frame plus bounded model/encoder state | Mandatory 21-point MediaPipe inference; NPZ observations/masks, RGB clips, safe bounded Rerun RRDs, thumbnails and frame mappings. Close/upload shards progressively. No second network video download between extraction, inference and preview. |
| 4c. Same invocation / inline QC | Source hash, counts/mappings, completed shards and their hashes | Bounded manifest/QC, API-completed output uploads and sealed inventory. Candidate result is provisional until known execution terminates and the API accepts current refs. |
| 5. Shared Data browser / Render Next.js | Dataset membership, authorized clip metadata and staff-only QC from API; thumbnails/RRD bytes directly from R2 | Staff review accepted clips from All clips, also linked by Review clips on a completed recording’s Pipeline detail page. Approval and chosen Dataset memberships commit together; Dataset members are approved-only, and rejection removes working memberships. Customers inspect only approved clips in granted datasets, on the same clip URL. No worker runs during human review. |
| 6. Follow-up Modal CPU / export | One whole frozen dataset and its approved reviews, labels and referenced RGB/pose/mapping files from R2 | Stream inputs into one bounded TAR on worker scratch, close/hash it, then multipart-upload archive/manifest/checksums into a unique release prefix. API completes/seals output; known terminal execution and current frozen refs yield `ready`. |
| 7. Follow-up dataset version / customer UI | Exact ready archive/manifest and named recipient grants | Staff publishes. Customer inspects and downloads all approved package bytes directly from R2; no model recomputation or Next.js media proxy. |

The [platform diagram](../figures/render-platform.md) shows hosting boundaries; the [processing diagram](../figures/processing-stages.md) shows the fixed sequence. Each implemented stage uses the same contract locally, using the official Render local Workflows runner with Postgres/MinIO and LocalExecutor. [Local qualification ladder](local-development.md)

## Intermediate state and repeated reads

Inside `process_recording`, intermediate state is a bounded local frame/shard window. Completed outputs live in private object storage; Postgres stores clip/dataset membership/access and file/job/review references. Pass manifests and file IDs between API, workers and exporter. No raw frames or big arrays enter job arguments, HTTP callbacks or database rows.

A fresh processing attempt streams the raw source once. The parser/model/encoders share decoded frames; they do not redownload the video for each conceptual step. There is no durable per-stage checkpoint in the pilot: failure may restart the whole recording under a new job ID. That tradeoff saves implementation complexity; measure retry cost before adding checkpoints.

The follow-up exporter necessarily reads selected completed clips/arrays again to build the delivery archive. Customer viewing and future download are additional reads. Record actual per-stage read/write bytes; do not promise zero rereads or assume a warm container cache. Avoid retaining another permanent raw copy solely for local scratch.

## Boundedness and visibility

Bound raw bytes/duration/dimensions, per-clip duration/bytes, open downloads, decoder/model buffers, array shard sizes, manifest entries and archive size. These are profile/config limits with sizing evidence, not optional defaults. A two-hour recording must never become a two-hour in-memory array.

A manual retry gets new output keys and cannot alter previous approved/published objects. All writes use consumed multipart IDs controlled by the API; job sealing prevents allocation/completion of new outputs. Human review references a successful immutable result manifest by hash. Published customer artifacts have no hidden scratch, expiring dependency or mutable `latest` reference.

Inline QC covers hashes, structures, counts and provenance. It cannot establish independent geometry accuracy. The agreed pilot includes image landmarks and labelled 3D estimates; unsupported timing/metric fields stay masked.
