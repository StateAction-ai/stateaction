# CPU-only operator rehearsal

Run from the spike worktree. Use the checked-in branch base and the repo's pinned Node, uv, and Render CLI. Build the unchanged web and server first. The entrypoint runs under `agent-resource` and needs the existing bounded fixture env file.

```sh
agent-resource run -- env \
  PATH="/home/wearaway/.nvm/versions/node/v24.22.2/bin:$PATH" \
  STATEACTION_LOCAL_FIXTURES=/home/wearaway/.cache/stateaction-sa26-fixtures/bounded-fixtures.env \
  bash spikes/python-plane/controller/operator.sh --rehearse
```

The rehearsal creates an isolated Postgres clone and object-store bucket, starts the official local Render runner, admits one hand-pose-only fixture and asks the existing reconcile route to dispatch it. It verifies the physical stub claim, the matching stage terminal evidence, and the absence of a job seal. The job remains active with its slot held because the controller stops before sealing. The harness removes its own database, bucket, capability files and processes in `finally`.

## Hosted prerequisites and sequence

The hosted branch of the script is disabled. The rehearsal covers local fixture teardown. Hosted release changes, spend metering, and restoration require provider adapters and a separate rehearsal of those adapters.

1. Verify the coordinator's `HOSTED WINDOW START GO`, the candidate commit and an exact, independently verified deployment definition. Resolve the SDK inspection gap before scheduling. Keep automatic dispatch disabled and cron suspended.
2. Snapshot the exact web release, workflow release and dispatch slug, cron state, affected environment keys and database allowlist. Verify the expected migrations in read-only mode, the idle slot and the public canary's source and recording-specific consent. Keep credentials in process.
3. Verify the gross workspace meter and provider budget. Follow the SA-142 and SA-147 USD 22 gross cutoff. Require zero GPU, one CPU container, zero provider retries, an effective wall-clock bound and enough headroom for one call, preparation and Render. Reserve an immutable app name, and bind the exact function and definition identities and verified settings.
4. Activate the temporary Python workflow with the `process-recording` suffix. Confirm its registration, options and revision. Admit the exact CPU-only fixture and dispatch once with the server's fixed key. Sample gross at least every 30 seconds. Stop dispatch and cancel only recorded task and call IDs if metering fails, identity drifts or the budget threshold is reached.
5. Read back the exact Render run, Modal call ID, stage receipt and terminal evidence. The proof stops before job sealing. Use the supported operator settlement path and require an idle slot before closing the window.
6. In a finally block, settle the exact started calls and task, revoke the fixture authorization and consent, retire its collector, stop the temporary Modal deployment by app ID and restore the captured releases, settings and ACL. Verify live health, exact release identities, dispatch disabled, cron suspended, baseline ACL and empty slot. Record actual spend and restoration evidence.

Procedure references are the SA-142 window 7 handoff and SA-147 CPU-only handoff in `flora-work/handoff`.
