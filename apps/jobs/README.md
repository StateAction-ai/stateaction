# Workflow foundation

The module-level `verify-platform` task uses the real `@renderinc/sdk` registration and official Render local task server. Run `make workflows` from the repository root; this does not deploy anything. `pnpm --filter @stateaction/jobs... build` builds the compiled entrypoint; `pnpm --filter @stateaction/jobs start` runs it.

`LocalExecutor` launches the installed Python worker with an argument array, bounded stdio and a 10-second smoke deadline. It passes no database/storage/provider credentials. The task verifies request identity and reports Render's actual task run ID.

`process-recording` (SA-26) is the production task: shared controller, local journal and detached Python child. See `docs/components/job-orchestration.md`. Output acceptance (SA-28), operator repair (SA-27), the hand-pose extractor stack and Modal are not here. Local Render history is memory-only.
