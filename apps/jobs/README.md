# Workflow foundation

The module-level `verify-platform` task uses the real `@renderinc/sdk` registration and official Render local task server. Run `make workflows` from the repository root; this does not deploy anything. `pnpm --filter @stateaction/jobs... build` builds the compiled entrypoint; `pnpm --filter @stateaction/jobs start` runs it.

`LocalExecutor` launches the installed Python worker with an argument array, bounded stdio and a 10-second smoke deadline. It passes no database/storage/provider credentials. The task verifies request identity and reports Render's actual task run ID.

This probe is separate from the future `process-recording` task. Durable jobs, controller leases, recovery, scoped worker capabilities, output multipart uploads and Modal execution are not implemented here. Local Render history is memory-only.
