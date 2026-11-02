#!/usr/bin/env bash
# ONE guarded driver for SA-26 validation. Run as:
#   /home/wearaway/.local/bin/agent-resource run -- apps/jobs/test-integration/run.sh
# It uses the shared bounded fixtures (never Docker), starts no emulator, and every
# server/runner/child it launches is torn down by the tests; the guard reaps leftovers.
set -euo pipefail
cd "$(dirname "$0")/../../.."
export PATH="/home/wearaway/.nvm/versions/node/v24.22.2/bin:$PATH"
# Repo pins uv 0.13.6; the host has an older global uv. Use it ephemerally.
shim="$(mktemp -d)"; trap 'rm -rf "$shim"' EXIT
printf '#!/bin/sh\nexec uvx -q --from uv==0.13.6 uv "$@"\n' > "$shim/uv"; chmod +x "$shim/uv"
export PATH="$shim:$PATH"
set -a
# shellcheck disable=SC1090
source "${BOUNDED_FIXTURES_ENV:-/tmp/stateaction-team-2026-11-01/bounded-fixtures.env}"
set +a
pnpm install --frozen-lockfile
uv sync --project workers/processing --locked --no-dev
pnpm exec prettier --write "apps/jobs/src/**/*" "apps/jobs/test/**/*" "apps/jobs/test-integration/*.mjs" "apps/jobs/*.json" infra/test/blueprint.test.mjs
if [ "${SA26_SKIP_WEB_BUILD:-}" != 1 ]; then # unchanged by SA-26; skip only on a rerun after a jobs-only fix
  pnpm --filter "@stateaction/server..." build
  pnpm --filter @stateaction/web build
fi
pnpm --filter "@stateaction/jobs..." build
pnpm --filter @stateaction/jobs typecheck
pnpm --filter @stateaction/jobs test
(cd workers/processing && PYTHONPATH=src ../../workers/processing/.venv/bin/python -m unittest discover -s tests -v)
node --test infra/test/blueprint.test.mjs
export PYTHON_EXECUTABLE="$PWD/workers/processing/.venv/bin/python"
export RENDER_CLI="${RENDER_CLI:?set RENDER_CLI to the pinned official render binary}"
export SA26_E2E_EVIDENCE=1
pnpm --filter @stateaction/jobs test:integration
