#!/usr/bin/env bash
# Run only on isolated local/CI ports. Never dispatches to a cloud workflow.
#
# Bounded external mode (STATEACTION_LOCAL_FIXTURES / E2E_EXTERNAL_FIXTURES):
# no `docker compose`. A run-owned database and bucket on the already-running
# bounded loopback PostgreSQL/S3 are used and removed on exit by exact ledger
# entry. STATEACTION_REQUIRE_EXTERNAL_FIXTURES=1 refuses the Compose fallback.
set -euo pipefail
cd "$(dirname "$0")/../.."
fixtures=scripts/platform/local-fixtures.mjs
external=false
if [[ -n "${STATEACTION_LOCAL_FIXTURES:-}${E2E_EXTERNAL_FIXTURES:-}" || -n "${STATEACTION_REQUIRE_EXTERNAL_FIXTURES:-}" ]]; then
  node "$fixtures" check # refuses unsafe/missing fixtures
  external=true
fi
export COMPOSE_PROJECT_NAME="${STATEACTION_SMOKE_COMPOSE_PROJECT:-stateaction-sa11-smoke}"
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
run_dir=''
cleanup() {
  local rc=$?
  [[ -z "$web_pid" ]] || kill -- "-$web_pid" 2>/dev/null || true
  [[ -z "$workflow_pid" ]] || kill -- "-$workflow_pid" 2>/dev/null || true
  if [[ "$compose_started" == true ]]; then
    docker compose -f infra/compose.yaml logs --no-color > artifacts/platform-ci/infrastructure.log 2>&1 || true
    docker compose -f infra/compose.yaml down
  fi
  rm -f .env .env.workflows.local
  if [[ -n "$run_dir" ]]; then node "$fixtures" reap "$run_dir" || rc=1; fi
  return "$rc"
}
trap 'cleanup; exit $?' EXIT
if [[ "$external" == true ]]; then
  run_dir=$(node "$fixtures" prepare smk --database --bucket)
  (
    set -a; source "$run_dir/run.env"; set +a
    python3 - <<'PY'
from pathlib import Path
import os, re
p = Path('.env')
text = p.read_text()
def put(key, value):
    global text
    text = re.sub(rf'^{key}=.*$', lambda _: f'{key}={value}', text, flags=re.M)
put('DATABASE_URL', os.environ['STATEACTION_FIXTURE_OWNER_URL'])
put('S3_ENDPOINT', os.environ['STORAGE_TEST_ENDPOINT'])
put('S3_BUCKET', os.environ['STATEACTION_FIXTURE_BUCKET'])
put('S3_ACCESS_KEY_ID', os.environ['STORAGE_TEST_ACCESS_KEY_ID'])
put('S3_SECRET_ACCESS_KEY', os.environ['STORAGE_TEST_SECRET_ACCESS_KEY'])
p.write_text(text)
p.chmod(0o600)
PY
  )
  public_endpoint="http://localhost:19000"
else
  # Isolated named volumes survive shutdown; never delete user data in this script.
  if [[ -n "$(docker compose -f infra/compose.yaml ps -q)" ]]; then
    echo "Refusing to reuse existing StateAction Compose services." >&2
    exit 1
  fi
  compose_started=true
  docker compose -f infra/compose.yaml up -d --wait
  public_endpoint="http://localhost:9000"
fi
pnpm db:migrate
pnpm storage:init
pnpm storage:check
printf 'S3_PUBLIC_ENDPOINT=%s\n' "$public_endpoint" >> .env # differs from S3_ENDPOINT: signing origin test
# SA-25: explicit permanent job input identity (health reports checks.jobs).
{
  printf 'PROCESSING_EXECUTION_BACKEND=local\n'
  printf 'PROCESSING_CODE_REVISION=ci-smoke\n'
  printf 'PROCESSING_IMAGE_SPEC_SHA256=%s\n' "$(printf image | sha256sum | cut -d' ' -f1)"
  printf 'PROCESSING_CONFIG_SHA256=%s\n' "$(printf config | sha256sum | cut -d' ' -f1)"
} >> .env
pnpm storage:presign
setsid pnpm dev > artifacts/platform-ci/web.log 2>&1 &
web_pid=$!
setsid artifacts/platform-tools/render/render workflows dev --env-file .env.workflows.local -- pnpm --filter @stateaction/jobs dev > artifacts/platform-ci/workflows.log 2>&1 &
workflow_pid=$!
for attempt in {1..60}; do
  if curl --silent --fail http://127.0.0.1:3000/api/v1/health >/dev/null && artifacts/platform-tools/render/render workflows tasks list --local -o json >/dev/null 2>&1; then
    pnpm --filter @stateaction/jobs smoke
    exit 0
  fi
  sleep 1
done
cat artifacts/platform-ci/web.log artifacts/platform-ci/workflows.log >&2
exit 1
