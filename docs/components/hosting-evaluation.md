# Hosting decision and provider evidence

Selected 2026-10-26: **Next.js/Node on Render, Better Auth, Render Postgres and Render Workflows**. R2 stores bulk media; Modal runs CPU/GPU processing. No service has been deployed. The [deployment specification](render-deployment.md) and [technical design](../technical-design.md) supersede the earlier Lightsail/Supabase/Inngest assumptions.

## Decision and boundaries

Render hosts the full Next.js Node server, including its domain route handlers and Better Auth adapter. The application owns permissions; Render workspace login/OIDC does not authenticate collectors or customers. Render Postgres is the only relational catalog. There is no second Edge/Deno API or identity authority. [Next.js hosting](https://render.com/docs/deploy-nextjs-app), [Better Auth integration](https://better-auth.com/docs/integrations/next)

Private R2 remains the media/dataset candidate because worker reads and bulk downloads dominate transfer. Its Lance, scoped-credential and recovery qualification gates remain open; S3 is the fallback. Render's SDK lists Object Storage as forthcoming/early access, and no GPU workflow offering was established in the reviewed plans. Attached disks do not replace a shared object store. [SDK feature status](https://github.com/render-oss/sdk), [disk constraints](https://render.com/docs/disks)

## What Render Workflows provides

Managed TypeScript/Python tasks, automatic retries, versioned task references, task chaining and per-run instances that scale to zero. Current limits are a two-hour default, up to 24 hours per task, 4MB arguments and 30-day task-state retention. Tasks have no inbound listener; callbacks reach the API. Cron triggers scheduled relay/reconciliation. Workflow/cron can initiate private connections in the same workspace/region; network-isolated environments currently need separate Workflow support qualification. [Overview](https://render.com/docs/workflows), [limits](https://render.com/docs/workflows-limits), [private network](https://render.com/docs/private-network)

**Checkpoint claims conflict:** a Render comparison advertises `ctx.step()` replay, while its SDK reference and the inspected published `@renderinc/sdk` **1.4.0** expose `TaskContext.run()` without a verified saved-step/suspended-sleep API. The selected design does not depend on those claims. Four bounded controller tasks resume from Postgres and Curator checkpoints, with 50-minute continuation inside a 60-minute task limit. [Comparison](https://render.com/articles/render-workflows-vs-vercel-workflows), [SDK reference](https://render.com/docs/workflows-sdk-typescript), [inspection receipt](../validation/render-research-20261026.json)

Render API idempotency lasts 24 hours and ignores repeated input. Our permanent dispatch/digest/attempt records prevent duplicate media work after that window. Pin retries explicitly, recover known Modal call IDs, and preserve source/writer-barrier/validator/API-acceptance contracts. A controller retry is not a GPU retry. Human review holds no task instance; export starts separately after internal approval. [API behavior](https://api-docs.render.com/reference/createtask), [selected orchestration](job-orchestration.md)

## Cost and qualification

USD planning rates checked 2026-10-26: 2GB Next service $25/month; 1GB-RAM Postgres $19; database-disk allowance $3; workspace Hobby $0 for one infrastructure operator or Pro $25. Application core is therefore **about $47/$72**, plus two cron floors ($2 total), variable workflow, media, compute and backup usage. Flex costs $0.20/active vCPU-hour plus $0.05/GB-hour RAM; waiting retains RAM. Provider task-state retention is $0.25/GB. No video crosses the Next service. [Render pricing](https://render.com/pricing), [workflow billing](https://render.com/docs/workflows-limits), [cron](https://render.com/docs/cronjobs)

The [video model](video-cost-model.md) has complete scenarios; the [platform comparison](platform-cost-comparison.md) preserves alternatives and AWS/CloudFront findings. Architecture is selected; runtime capacity and recovery are still unmeasured. Before activation, prove private connections/role pools, task registration/versioning, controller restart/continuation after Modal submission, cancellation, ambiguous dispatch, native recovery, durable result acceptance, complete delivery and bounded cost. Use fake workers before an authorized cloud canary.
