# Hosting evaluation: Next.js and Render

Updated: 2026-10-26. **Confirmed: Next.js frontend.** Render, API hosting, identity integration and workflow-engine changes remain evaluation choices. No service has been deployed.

This record supersedes the October 23 assumption that a Node API and static React console would share Lightsail. The Node/Fastify/Better Auth component details remain a reference option. Supabase Edge/Deno was the earlier managed API proposal; it was not ruled out by choosing TypeScript. Select one API/identity architecture before implementing its adapters.

## Next.js deployment

Render officially supports Next.js as a Node web service with server-side features, or a static site when using Next's static export. A static export cannot provide request-time SSR/server features. For a full Next.js dashboard, evaluate a **paid web service**, not an assumption of free static hosting. [Render guide](https://render.com/docs/deploy-nextjs-app), [Next.js export boundaries](https://nextjs.org/docs/app/guides/static-exports)

| Candidate arrangement | Responsibility split |
| --- | --- |
| Next.js on Render + Supabase Edge API | Next handles UI/rendering; Deno/TypeScript functions own domain API; Supabase Postgres retains catalog. Qualify auth/cookies/CORS, forwarding and SDKs. |
| Next.js on Render with domain API there | Next route handlers or one owned Node API host the domain services; Supabase supplies Postgres and the separately chosen identity integration. Avoid duplicating domain writes in Edge and Node. |

A Next.js server rendering pages does not itself require moving the domain API from Supabase. Conversely, using Next route handlers for all domain operations is a separate architecture choice. Uploads/downloads remain direct to object storage; GPU and long media work stay on Modal.

## Render Workflows: what is verified

Render provides managed TypeScript/Python tasks, automatic retries, chained runs and per-run instances that scale to zero. Current limits are two hours by default and up to 24 hours per task, 4MB arguments and 30-day task-state retention. Task instances accept no inbound connections; callbacks must reach the API or start another task. Native scheduled triggers are not documented; a cron service can trigger tasks. [Overview](https://render.com/docs/workflows), [limits](https://render.com/docs/workflows-limits)

This is a candidate to replace Inngest, not another workflow engine to add beside it. Render's published workflow shapes are CPU/RAM plans; no GPU workflow plan was established in this review. Keep Modal for the qualified GPU workers.

### Waiting and recovery matter for our pipeline

Render's comparison says there is no suspended sleep/pause primitive: a waiting task retains its instance. Flex bills actual CPU/RAM, so a small controller can still be inexpensive. Inngest documents durable sleep without a running handler and saved completed-step results. [Render comparison](https://render.com/articles/render-workflows-vs-vercel-workflows), [Inngest sleep](https://www.inngest.com/docs/durable-execution/primitives/step-sleep), [Inngest steps](https://www.inngest.com/docs/durable-execution/primitives/step-run)

**Checkpoint claims conflict:** the Render comparison advertises `ctx.step()` replay, while its SDK reference lists `TaskContext.run()` only and its product page labels checkpointing as forthcoming. Read-only inspection of the published `@renderinc/sdk` **1.4.0** package also found `run()` without `step()`. Do not implement against an assumed checkpoint API. Resolve support for the pinned release and inject parent failure before adoption. The package declares MIT; hosted-service terms remain separate. [SDK reference](https://render.com/docs/workflows-sdk-typescript), [SDK source](https://github.com/render-oss/sdk/blob/main/typescript/src/workflows/types.ts), [package-inspection receipt](../validation/render-research-20261026.json)

For Render, retain our Postgres attempt ledger and immutable Curator checkpoints. A controller loads the existing attempt/call ID, submits Modal once, polls within its deadline, validates and advances. A restarted/retried controller must recover those records rather than resubmit GPU work. Render's API idempotency lasts 24 hours and ignores repeated input for the same key; our request-digest/conflict checks must remain. Configure retries explicitly; the documented default is three retries. [API idempotency](https://api-docs.render.com/reference/createtask), [retry behavior](https://render.com/docs/workflows-defining)

End processing before human review, and start a separate export run after approval. Do not hold a Render instance waiting days for a reviewer. All existing source-integrity, write-barrier, validation and publication contracts remain applicable.

## Cost comparison

USD public rates checked 2026-10-26; sizing unmeasured, excluding tax and usage extras.

| Item | Planning rate |
| --- | --- |
| Render Next.js web service | $7/month for 512MB; $25/month for 2GB. Measure runtime fit. |
| Render workspace | Hobby: $0 fee, one member; Pro: $25/month, multiple team members, plus service compute. |
| Render Workflow Flex | $0.20/active CPU-hour + $0.05/GB-hour of RAM; state retention $0.25/GB. |
| Inngest | Free includes 50k executions/five concurrent steps; Pro starts $99/month. |

[Service pricing](https://render.com/pricing), [workspace plans](https://render.com/changelog/updated-plans-for-render-workspaces), [workflow billing](https://render.com/docs/workflows-limits), [Inngest pricing](https://www.inngest.com/pricing).

Illustration: retaining 0.2GB RAM for a two-hour Modal wait costs about **$0.02** in Render Flex RAM charges, plus CPU, state and transfer. It is not free suspended waiting, but need not be expensive. A one-operator $7 Next service plus $25 Supabase Pro starts near $32/month; adding Render Pro workspace makes that $57 before workflows/storage/GPU/other usage. Render's Free web service sleeps after 15 minutes and is explicitly unsuitable for production. Video bytes should bypass Render's frontend bandwidth. [Free-service limits](https://render.com/docs/free)

## Recommendation and decision test

Shortlist Render for full Next.js hosting. Retain Inngest as the current qualified-design workflow option while evaluating Render as its replacement. Before choosing Render Workflows, prove controller restart after Modal submission, parent/child retry behavior, cancellation propagation to Modal, durable result recovery, bounded waiting cost and scheduled reconciliation. Use fake workers locally before an authorized cloud canary. No backend migration or provider activation is implied by this evaluation.
