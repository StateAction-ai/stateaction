# Python pipeline-plane spike

This checkout tests the recipe compiler and the controller at the existing server boundary. The controller runs a single CPU-shaped stage on a stub subprocess, records its claim and exact exit evidence, and stops before the seal. The server remains the authority for admission, claims and acceptance.

- `controller/` contains the Render task, HTTP client, executor interface, journal, pytest ports, Nx project and the local operator entrypoint.
- `providers/` contains the offline Modal SDK evaluation and its thin adapter.
- `contracts/` contains generated Python types and the conformance comparison.
- `sandbox/` contains the isolated recipe compiler and 20-run verification instructions.

Use the repository's Node 24.22.2 and bounded fixtures. From the worktree root:

```sh
agent-resource run -- pnpm install --frozen-lockfile
agent-resource run -- pnpm --filter '@stateaction/server...' build
agent-resource run -- env NEXT_TELEMETRY_DISABLED=1 pnpm --filter @stateaction/web build
agent-resource run -- python3 scripts/platform/install-render.py
agent-resource run -- uvx --from uv==0.13.6 uv sync --project spikes/python-plane/controller --locked --python 3.12
agent-resource run -- uvx --from uv==0.13.6 uv run --project spikes/python-plane/controller --locked python -m pytest -q spikes/python-plane/controller/tests
agent-resource run -- env STATEACTION_LOCAL_FIXTURES=/home/wearaway/.cache/stateaction-sa26-fixtures/bounded-fixtures.env \
  bash spikes/python-plane/controller/operator.sh --rehearse
```

The repository's existing CI integration stage selects the spike's uncached Nx `integration` target. A production move would keep the Python lock and static checks under the Python project, and keep the Render and DB fixture case uncached within the integration lane. Extend the gate's full-run path matcher for new lock locations and add freshness checks for generated bindings and compiled JSON. A new workflow service can preserve the server's existing `<service-slug>/process-recording` task convention.
