# Render, Supabase and AWS: comparable deployment costs

Updated: 2026-10-26. Decision record: Render Next.js/Better Auth/Postgres/Workflows with R2/Modal is selected. Alternative rows below remain cost evidence; no migration, deployment or paid job. Parent: [hosting choices](hosting-evaluation.md). [Calculation receipt](../validation/platform-comparison-20261026.json).

## Application hosting and media storage are separate choices

Any of these application backends can authorize direct uploads to R2 or S3. Selecting Supabase Postgres/Auth does not require Supabase Storage; selecting AWS hosting does not require S3. All figures below keep the same Modal compute assumptions. A fully AWS-hosted processing system needs its own compute/orchestration sizing.

| Application core | Monthly allowance | Ownership/tradeoff |
| --- | ---: | --- |
| Render Next.js/API + Render Postgres + Better Auth | $72; $47 with one infrastructure operator | Node/TypeScript API and auth library in our app; managed host and DB |
| Render Next.js/API + Supabase Postgres/Auth | $75; $50 with one infrastructure operator | Supabase Pro $25 adds managed user identity; keep domain API in Node if desired |
| Small AWS VM + encrypted managed Postgres + app-hosted auth | $45 | Concrete budget baseline: Lightsail 2GB/public IPv4 $12, encrypted 2GB managed DB $30, $3 operations allowance. We administer the VM. |

Both Render arrangements include the same $25 Pro workspace for a fair team comparison. App users do not require infrastructure seats. Supabase is not a full Next.js Node server host; use Next.js hosting separately. Edge Functions are Deno-based short handlers with current 256MB RAM, two CPU seconds/request and 400-second paid wall-clock limits; no long media jobs or Modal waits there. Choosing Supabase Auth is an explicit identity/mobile-adapter decision, not an automatic Better Auth migration. [Render rates](https://render.com/pricing), [Supabase rates](https://supabase.com/pricing), [function limits](https://supabase.com/docs/guides/functions/limits), [Next.js auth integration](https://supabase.com/docs/guides/auth/server-side/nextjs), [AWS baseline](https://aws.amazon.com/lightsail/pricing/)

The AWS VM example is a low-cost comparison, not a renewed Lightsail selection or an estimate for an HA ECS/RDS production deployment. Amplify, Cognito, RDS and Step Functions are additional managed options to size if choosing AWS. OS patching, deployment, restoration and operational labor are excluded from the $45 allowance. Shapes are not load-tested.

## Use identical byte flows

Retain the [previous model](video-cost-model.md): 12.5GB uploaded/hour, raw plus derived storage twice raw volume, rolling three-month retention, one raw-volume of Modal output, the same CPU/workflow allowances and optional GPU sensitivity. Add explicit object-store outbound assumptions for comparison: **two raw-volume equivalents of worker reads**, **0.25 of review playback**, **one of customer downloads**, each month. At 100 recording hours, this means 1.25TB new raw uploads, 7.5TB retained and about 4.06TB read/download traffic. These factors are planning assumptions, not measured stages or a requirement to reread the original twice.

| Media option | Storage | Read/download charges |
| --- | --- | --- |
| R2 Standard | $0.015/GB-month; 10GB-month included | No egress/retrieval fee; requests and worker I/O time remain |
| Supabase Storage Pro | 100GB included, then $0.0213/GB-month | 250GB uncached egress included, then $0.09/GB; cached allowance/rate separate |
| S3 Standard, us-east-1 | $0.023/GB-month first 50TB; $0.022 next tier | Direct internet transfer: 100GB shared allowance, then $0.09/GB first 10TB and $0.085 next 40TB |

Prices use approximate provider GB; precise billing-unit reconciliation remains a canary requirement. Do not apply cached Supabase pricing to all private downloads or native worker reads. Free allowances are shared and assumed otherwise unused. [R2](https://developers.cloudflare.com/r2/pricing/), [Supabase](https://supabase.com/pricing), [S3](https://aws.amazon.com/s3/pricing/). AWS regional public-price-file receipts preserve the current [storage tiers](../validation/aws-s3-pricing-20261026.json) and [transfer tiers](../validation/aws-transfer-pricing-20261026.json); transfer is priced through the AWS Data Transfer catalog. [Shared 100GB allowance](https://aws.amazon.com/blogs/aws/aws-free-tier-data-transfer-expansion-100-gb-from-regions-and-1-tb-from-amazon-cloudfront-per-month/)

### AWS delivery optimization belongs in the comparison

CloudFront Pro flat-rate pricing is **$15/month per distribution**, with **50TB delivery and 10 million requests** in the monthly allowance. It supports private S3 origins/OAC and signed URLs. S3 origin transfer to CloudFront is free; a cache hit is not required for that exemption. Use it for review/customer delivery rather than assuming every download incurs direct-S3 internet rates. Eligibility, Range/CORS behavior, URL expiry and release-grant enforcement need qualification. Credits against S3 storage are conservatively omitted here. [Pricing](https://aws.amazon.com/cloudfront/pricing/), [features/allowances](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html)

This does **not** make direct S3 reads by external Modal workers free. Native Curator S3 clients are not automatically CloudFront viewers. Conversely, eligible S3-to-AWS compute transfers in the same AWS region are free, including across accounts. AWS-native workers—or verified eligible Modal placement—could remove that transfer line. Modal spans clouds; selecting `us-east` alone does not prove an AWS-region billing match. Its current resource price multipliers are 1.15x for broad region selection and 1.75x for narrow selection, excluded from the unpinned baseline. [AWS transfer rules](https://aws.amazon.com/about-aws/global-infrastructure/global-network/faqs/), [Modal region behavior/pricing](https://modal.com/docs/guide/region-selection)

## Monthly totals before optional GPU stages

Steady state after retaining three months, USD, before tax/credits. Same CPU, Modal output transfer and workflow allowance in every row. Request overages, extra environments, HA, labor and collector connectivity remain excluded. The AWS/CloudFront row routes review/download bytes through CloudFront while worker S3 reads remain billable external transfer.

| Architecture | 20 hours/month | 100 hours/month | 1,000 hours/month |
| --- | ---: | ---: | ---: |
| Render app/DB/auth + R2 + Modal | $108 | $251 | $2,209 |
| Render app + Supabase DB/Auth + R2 + Modal | $111 | $254 | $2,212 |
| Render app + Supabase DB/Auth/Storage + Modal | $169 | $642 | $6,316 |
| Small AWS app/DB + S3 + CloudFront Pro + external Modal | $144 | $515 | $4,941 |
| Small AWS app/DB + R2 + Modal | $81 | $224 | $2,182 |

Subtract $25 from **every Render row** for a single infrastructure operator on a Hobby workspace. The optional GPU sensitivity adds the same **$20–79 / $99–395 / $988–3,954** respectively; it is not a benchmark. Replace the common workflow allowance with the selected engine's measured bill, and do not retain two outer orchestration engines. Provider capacity, bytes, retries and controller memory remain unmeasured.

For context, direct S3 downloads without CloudFront raise the AWS row to about $157/$640/$6,254. If all worker reads genuinely qualify for zero same-region S3 transfer, the CloudFront variant's transfer saving is about $36/$216/$2,168 relative to its external-worker case. This isolates the transfer benefit; adopting AWS-native CPU/GPU workers requires a new compute quote and must not inherit Modal's rates.

## Decision for the unfunded pilot

The application-core difference between Render Postgres/Better Auth and Supabase Postgres/Auth is approximately **$3/month** with matched frontend/workspace sizing. The user selected the Render Postgres/Better Auth arrangement after this comparison. Supabase supplies managed identity; Better Auth runs in our Node application. R2's larger saving comes from its media economics, independent of that choice, subject to the existing Lance/credential/recovery qualification gates.

Implement **Render Next.js/Node API + Render Postgres/Better Auth + Render Workflows + R2 + Modal**. Preserve one domain API, identity authority and workflow owner; use the [deployment specification](render-deployment.md). AWS becomes more attractive if we deliberately colocate processing with S3, qualify private CloudFront delivery, obtain useful credits or need its infrastructure controls. Compare total engineering/operational effort as well as the cloud bill.
