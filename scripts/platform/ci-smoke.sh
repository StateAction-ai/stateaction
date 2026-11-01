#!/usr/bin/env bash
# Run only on isolated local/CI ports. Never dispatches to a cloud workflow.
set -euo pipefail
cd "$(dirname "$0")/../.."
export COMPOSE_PROJECT_NAME="${STATEACTION_SMOKE_COMPOSE_PROJECT:-stateaction-smoke}"
mkdir -p artifacts/platform-ci
python3 - <<'PY'
import socket
for port in (3000, 8120):
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(('127.0.0.1', port))
        except OSError:
            raise SystemExit(f'Refusing to reuse another process on port {port}')
PY
for target in .env .env.workflows.local; do
  if [[ -e "$target" ]]; then
    echo "Refusing to replace an existing $target; run the manual smoke instead." >&2
    exit 1
  fi
done
cp .env.example .env
cp .env.workflows.example .env.workflows.local
python3 - <<'PY'
from pathlib import Path
import secrets
p = Path('.env')
p.write_text(p.read_text().replace('replace-with-a-local-random-token', secrets.token_hex(32)))
p.chmod(0o600)
Path('.env.workflows.local').chmod(0o600)
PY
web_pid=''
workflow_pid=''
compose_started=false
cleanup() {
  [[ -z "$web_pid" ]] || kill -- "-$web_pid" 2>/dev/null || true
  [[ -z "$workflow_pid" ]] || kill -- "-$workflow_pid" 2>/dev/null || true
  if [[ "$compose_started" == true ]]; then
    docker compose -f infra/compose.yaml logs --no-color > artifacts/platform-ci/infrastructure.log 2>&1 || true
    docker compose -f infra/compose.yaml down
  fi
  rm -f .env .env.workflows.local
}
trap cleanup EXIT
# Isolated named volumes survive shutdown; never delete user data in this script.
if [[ -n "$(docker compose -f infra/compose.yaml ps -q)" ]]; then
  echo "Refusing to reuse existing StateAction Compose services." >&2
  exit 1
fi
compose_started=true
docker compose -f infra/compose.yaml up -d --wait
pnpm db:migrate
pnpm storage:init
pnpm storage:check
setsid pnpm dev > artifacts/platform-ci/web.log 2>&1 &
web_pid=$!
setsid artifacts/platform-tools/render/render workflows dev --env-file .env.workflows.local -- pnpm --filter @stateaction/jobs dev > artifacts/platform-ci/workflows.log 2>&1 &
workflow_pid=$!
for attempt in {1..60}; do
  if curl --silent --fail http://127.0.0.1:3000/api/v1/health >/dev/null && artifacts/platform-tools/render/render workflows tasks list --local -o json >/dev/null 2>&1; then
    pnpm test:platform
    exit 0
  fi
  sleep 1
done
cat artifacts/platform-ci/web.log artifacts/platform-ci/workflows.log >&2
exit 1
