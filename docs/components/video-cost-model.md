# Video pipeline cost model

Updated: 2026-10-26. USD planning estimates, before tax/credits. **No deployment or paid processing performed.** Render Next.js/Better Auth/Postgres/Workflows is now the selected application stack; R2 media and Modal processing remain external. [Hosting choices](hosting-evaluation.md), [machine-readable assumptions and calculations](../validation/video-cost-model-20261026.json).

For matched Render/Supabase/AWS scenarios, including S3 same-region transfers and private CloudFront delivery, read the [platform comparison](platform-cost-comparison.md).

## Workload and uncertainty

Budget by **all uploaded bytes per recording hour**, not video resolution alone. The recorder source targets 15Mbps for a 1080p MP4, about 6.75 decimal GB/hour. However, the current Pixel acquisition path embeds individual JPEG frames plus sensors in MCAP. Two existing captures contain 64,029,630 bytes over 17.239 seconds and 37,696,852 bytes over 12.575 seconds: extrapolated rates of **13.37 and 10.79 GB/hour**. These short samples establish neither sustained two-hour size nor a peak bound. They also do not establish that both an MCAP and a separate original MP4 must be uploaded. [Acquisition evidence](../pixel-v3-physical-validation.md)

Use **12.5GB/hour**, or **25GB per two-hour capture**, as a provisional raw-bundle assumption. Include every required sidecar and any separately recorded video when measuring the final app. For storage, assume raw plus all retained prepared sources, Lance/history/checkpoints, previews, arrays and delivery copies total **twice raw bytes**, retained for **three months**. This is an unmeasured multiplier, not a guarantee. Multiple exports, dense arrays and permanent releases can increase it substantially.

## Keep media off the application host

| Transfer | Data path | Charge to budget |
| --- | --- | --- |
| Collector upload | Phone directly to private R2 using resumable multipart | R2 writes/storage; collector's internet/mobile data |
| Processing reads/retries | R2 directly to Modal | R2 GET/Range requests; no R2 Standard download/egress fee; worker time during I/O |
| Intermediate/results/export writes | Modal directly to R2 | R2 writes/storage **and Modal outbound transfer** |
| Internal review | R2 directly to browser via short-lived authorized URLs | R2 GET/Range requests; use preview video where sufficient |
| Customer delivery | R2 directly to customer downloader, with authorized resumable access | R2 GET/Range requests; count all release shards and repeated downloads |
| Control traffic | App/API/workflow exchanges IDs, manifests and receipts | Small Render bandwidth/task state; no video in workflow arguments |

R2 Standard lists $0.015/GB-month, free internet egress, $4.50/million writes and $0.36/million reads; monthly free allowances are 10GB-month, one million writes and ten million reads. Request billing rounds to the next million. Re-reading still consumes requests and billed worker time. Use shard files, not one object per decoded frame. At 15fps, 1,000 hours would produce 54 million frame objects—about $239 in PUT charges alone above the write allowance if each frame were uploaded separately. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

Render charges **$0.15/GB** for public-internet outbound traffic above 5GB/month on Hobby or 25GB/month on Pro. A redirect/signed URL leaves the media transfer at R2; proxying the response through Next.js incurs Render bandwidth. Upload ingress to Render is unbilled, but forwarding those bytes to R2 would create Render outbound usage. Same-region service-initiated S3/GCS traffic has a documented exemption; do not generalize it to R2 or customer responses. [Render bandwidth rules](https://render.com/docs/outbound-bandwidth)

For **1TB (1,000GB) of customer downloads in a month**, bandwidth alone is approximately $146 on Render Pro after its 25GB allowance, versus $0 R2 egress plus requests. Supabase Pro's uncached storage/API egress would be about $68 after its 250GB allowance; cached egress has a separate allowance/rate, which must not be assumed for private bulk downloads. These omit each platform's subscription and storage. [Supabase rates](https://supabase.com/pricing)

Modal Starter includes **1TiB/month outbound**, then **$0.04/GiB**. Result uploads to R2 and direct container-to-container network traffic count; Modal Volume I/O does not. The scenarios below assume total Modal network output equals one raw-bundle copy; repeated intermediate writes, retries and distributed traffic must be measured separately. R2's free outbound does not waive Modal's outbound charge. [Modal egress](https://modal.com/docs/guide/network-egress-billing)

## Monthly scenarios

These are **steady-state bills after retaining three months**, with a rolling deletion policy. First-month storage averages lower as data arrives. Retention cannot delete artifacts still required by a release, policy or active recovery; indefinite raw/release retention means the storage bill keeps growing.

| Per month | Small pilot | Pilot | Growing collection |
| --- | ---: | ---: | ---: |
| Recorded hours | 20 | 100 | 1,000 |
| New raw uploads | 250GB | 1.25TB | 12.5TB |
| Raw + derived retained at steady state | 1.5TB | 7.5TB | 75TB |
| Render app/API + DB + workspace/disk allowance | $72 | $72 | $72 |
| R2 storage, approximately | $22 | $112 | $1,125 |
| Modal output transfer | $0 | $6 | $425 |
| CPU preparation/validation/export, with headroom | $11 | $56 | $555 |
| Workflow/scheduling/state allowance | $3 | $5 | $32 |
| **Subtotal before optional GPU stages** | **$108** | **$251** | **$2,209** |
| Optional GPU sensitivity, with headroom | $20–79 | $99–395 | $988–3,954 |
| **Illustrative total** | **$128–187** | **$349–646** | **$3,197–6,163** |

The fixed $72 uses Next.js/API 2GB RAM $25, Render Postgres 1GB RAM $19, Pro workspace $25 and $3 DB-disk allowance. A single infrastructure operator on a Hobby workspace saves $25; our app's users do not require Render seats. An API/DB shape capable of 1,000 recording hours is plausible because bytes bypass it, but **not load-tested**. [Render service/DB pricing](https://render.com/pricing), [workspace pricing](https://render.com/changelog/updated-plans-for-render-workspaces)

Compute/workflow assumptions are deliberately explicit:

- Aggregate CPU preparation, validation and export take one worker-hour per recording-hour at four physical cores/32GiB RAM: about **$0.444/worker-hour**.
- Optional GPU processing takes **0.25–1 total L40S worker-hours per recording-hour**, across the selected GPU stages. L40S plus four physical cores/128GiB host RAM costs about **$3.163/worker-hour**. This follows the conservative caption-profile host-RAM allowance; it is not a measured throughput range or proof that the model fits. L4 embedding and other profiles require their own measured rates.
- Both compute lines include 25% planning headroom for startup/retries. This is not a hard spend cap or a worst-case bound. Dense hand inference/captioning can take longer, and an H100 profile costs more. GPU stages remain optional and require model/asset rights and qualification.
- A controller lasts one hour per recording-hour, averaging 0.1 vCPU/0.2GB RAM: $0.03/hour, plus $2/month for the two cron-service floors; task-state/above-minimum cron usage remains extra. Concurrent stages and retained memory can increase controller-hours. Render has no verified suspended-wait primitive; task recovery must pass the [selected orchestration](job-orchestration.md). Controller generations resume existing Modal work rather than launching it again.

[Modal compute rates](https://modal.com/pricing), [Render Workflow billing](https://render.com/docs/workflows-limits), [model/resource qualification](cloud-processing.md#5-models-and-resources).

R2 request overages, staging, replicas/HA, additional backups, domains/email, cache storage above allowances, review labor and collector connectivity/compensation are excluded. Storage uses approximate provider-GB pricing; Modal transfer explicitly converts decimal byte volumes to GiB. Check actual billing units/rounding and account credits before activation.

These use unpinned Modal base rates. Region selection currently adds a 1.15x broad or 1.75x narrow resource multiplier; price the chosen residency/region profile before activation. A geographic region name alone does not establish free same-region AWS S3 transfer. [Modal regions/pricing](https://modal.com/docs/guide/region-selection)

## Low-budget implementation order

Start near the **20-hour/month pilot**, CPU-only ingest/QC/preview and internal review, with zero warm GPUs. Run optional inference on approved subsets until cost per approved hour and label quality are measured. Keep raw originals once; reuse canonical batch media/Lance checkpoints across stages and retries. Retain only required output representations and shard delivery files; avoid permanent copies for every stage or export attempt.

Before committing a monthly budget, measure one representative two-hour capture's complete upload size; total byte-hours retained per artifact class; all worker read/write/network bytes; CPU/GPU time by enabled stage; retries/cold starts; workflow consumption; review playback and customer-download volume. R2 remains conditional on passing Lance/credential/recovery qualification; if S3 is required, reprice object egress for every external worker read and customer download rather than carrying over R2's zero-egress assumption.
