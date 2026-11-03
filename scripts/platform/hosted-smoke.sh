#!/usr/bin/env bash
# Render-like production-mode proof on isolated local ports. Never contacts Render
# or real R2 credentials: storage uses a fake credential pair and is expected degraded.
#
# Bounded external mode (STATEACTION_LOCAL_FIXTURES / E2E_EXTERNAL_FIXTURES): no
# Docker. A run-owned database on the already-running bounded loopback
# PostgreSQL replaces the container; a bounded 127.0.0.2 forwarder gives the
# production-mode services the non-"loopback" host Render would. The database is
# removed on exit by exact ledger entry. STATEACTION_REQUIRE_EXTERNAL_FIXTURES=1
# refuses the Docker fallback.
set -euo pipefail
cd "$(dirname "$0")/../.."
fixtures=scripts/platform/local-fixtures.mjs
external=false
if [[ -n "${STATEACTION_LOCAL_FIXTURES:-}${E2E_EXTERNAL_FIXTURES:-}" || -n "${STATEACTION_REQUIRE_EXTERNAL_FIXTURES:-}" ]]; then
  node "$fixtures" check # refuses unsafe/missing fixtures
  external=true
fi
WEB_PORT="${HOSTED_SMOKE_WEB_PORT:-10000}"   # Render's default PORT
RUNNER_PORT="${HOSTED_SMOKE_RUNNER_PORT:-8121}"
NAME="stateaction-sa14-hosted-pg"
RENDER="${RENDER:-artifacts/platform-tools/render/render}"
mkdir -p artifacts/hosted-smoke
for p in "$WEB_PORT" "$RUNNER_PORT"; do
  python3 - "$p" <<'PY'
import socket, sys
with socket.socket() as s:
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try: s.bind(('0.0.0.0', int(sys.argv[1])))
    except OSError: raise SystemExit(f'Refusing occupied port {sys.argv[1]}')
PY
done
web_pid=''; runner_pid=''; forward_pid=''; run_dir=''
cleanup() {
  local rc=$?
  [[ -z "$web_pid" ]] || kill -- "-$web_pid" 2>/dev/null || true
  [[ -z "$runner_pid" ]] || kill -- "-$runner_pid" 2>/dev/null || true
  [[ -z "$forward_pid" ]] || kill "$forward_pid" 2>/dev/null || true
  if [[ "$external" == true ]]; then
    [[ -z "$run_dir" ]] || node "$fixtures" reap "$run_dir" || rc=1
  else
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
  return "$rc"
}
trap 'cleanup; exit $?' EXIT
if [[ "$external" == true ]]; then
  run_dir=$(node "$fixtures" prepare smk --database)
  # Synthetic loopback credentials of the bounded fixtures; never printed.
  set -a; source "$run_dir/run.env"; set +a
  DB_NAME="$STATEACTION_FIXTURE_DATABASE"
  OWNER_PW="$(python3 -c 'import os,urllib.parse as u;print(u.unquote(u.urlparse(os.environ["CATALOG_TEST_OWNER_URL"]).password))')"
  APP_PW="$(python3 -c 'import os,urllib.parse as u;print(u.unquote(u.urlparse(os.environ["CATALOG_TEST_APP_URL"]).password))')"
  DIRECT_PORT="$(python3 -c 'import os,urllib.parse as u;print(u.urlparse(os.environ["CATALOG_TEST_ADMIN_URL"]).port)')"
  psql_as() { # user, password, db, then psql-style -c SQL or SQL on stdin
    local user=$1 pw=$2 db=$3; shift 3
    local enc; enc="$(python3 -c 'import sys,urllib.parse as u;print(u.quote(sys.argv[1],safe=""))' "$pw")"
    HS_URL="postgresql://$user:$enc@127.0.0.1:$DIRECT_PORT/$db" node "$fixtures" sql --url-env HS_URL "$@"
  }
  forward_port_file="$run_dir/forward.port"
  setsid node "$fixtures" forward --ttl 1800 > "$forward_port_file" &
  forward_pid=$!
  for _ in {1..30}; do [[ -s "$forward_port_file" ]] && break; sleep 0.2; done
  DB_HOST=127.0.0.2   # not in the config's loopback names, like Render's private network
  DB_PORT="$(head -1 "$forward_port_file")"
  [[ "$DB_PORT" =~ ^[0-9]+$ ]] || { echo "forwarder did not start" >&2; exit 1; }
  OWNER_URL="postgresql://migration_owner:$OWNER_PW@$DB_HOST:$DB_PORT/$DB_NAME"
  APP_ROLE_SQL=''
else
  DB_NAME=stateaction; DB_PORT=5432
  BOOT_PW="$(python3 -c 'import secrets;print(secrets.token_hex(16))')"
  OWNER_PW="$(python3 -c 'import secrets;print(secrets.token_hex(16))')"
  APP_PW="$(python3 -c 'import secrets;print(secrets.token_hex(16))')"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # Bootstrap superuser only provisions; the migration owner mirrors Render: NOSUPERUSER
  # CREATEROLE and the owner of its database (the catalog grant helper requires ownership).
  docker run -d --name "$NAME" -e POSTGRES_USER=bootstrap -e POSTGRES_PASSWORD="$BOOT_PW" -e POSTGRES_DB=postgres \
    "$(grep -oE 'postgres:[^ ]+@sha256:[0-9a-f]+' infra/compose.yaml | head -1)" >/dev/null
  for _ in {1..60}; do docker exec "$NAME" pg_isready -U bootstrap -d postgres >/dev/null 2>&1 && break; sleep 1; done
  DB_HOST="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$NAME")"
  # Non-loopback address, like Render's private network, so production isolation applies.
  for _ in {1..30}; do python3 -c "import socket;socket.create_connection(('$DB_HOST',5432),1)" 2>/dev/null && break; sleep 1; done
  psql_as() { local user=$1 pw=$2 db=$3; shift 3; docker exec -i -e PGPASSWORD="$pw" "$NAME" psql -v ON_ERROR_STOP=1 -qAt -h "$DB_HOST" -U "$user" -d "$db" "$@"; }
  psql_as bootstrap "$BOOT_PW" postgres -c "CREATE ROLE migration_owner LOGIN CREATEROLE NOSUPERUSER NOCREATEDB PASSWORD '$OWNER_PW'"
  psql_as bootstrap "$BOOT_PW" postgres -c "CREATE DATABASE stateaction OWNER migration_owner"
  OWNER_URL="postgresql://migration_owner:$OWNER_PW@$DB_HOST:5432/$DB_NAME"
  APP_ROLE_SQL="CREATE ROLE stateaction_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$APP_PW';"
fi
APP_AS() { psql_as stateaction_app "$APP_PW" "$DB_NAME" "$@"; }
echo "== legacy SA-14 state: version-1 schema (no checksum) + broad grants and default ACLs"
psql_as migration_owner "$OWNER_PW" "$DB_NAME" < packages/server/migrations/001_platform.sql
psql_as migration_owner "$OWNER_PW" "$DB_NAME" <<SQL
$APP_ROLE_SQL
GRANT ALL ON ALL TABLES IN SCHEMA public TO stateaction_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stateaction_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO stateaction_app;
SQL

echo "== owner migration (explicit owner credentials, not the web env): adoption + catalog"
MIGRATE_ENV=(env -i PATH="$PATH" APP_ENV=production "MIGRATION_DATABASE_URL=$OWNER_URL" "APP_DB_PASSWORD=$APP_PW")
first="$("${MIGRATE_ENV[@]}" node packages/server/dist/cli.js migrate)"; echo "$first"
grep -q 'checksum adopted \[1\]' <<<"$first" && grep -q 'applied \[2,3,4,5,6,7\]' <<<"$first" && grep -q 'grants applied' <<<"$first" \
  || { echo "legacy v1 must adopt its checksum and apply the published catalog" >&2; exit 1; }
second="$("${MIGRATE_ENV[@]}" node packages/server/dist/cli.js migrate)"; echo "$second"
grep -q 'applied \[\],' <<<"$second" || { echo "second migration must be a no-op" >&2; exit 1; }
echo "== broad default ACLs were removed by stateaction_grant_app_role"
leftover="$(psql_as migration_owner "$OWNER_PW" "$DB_NAME" -c "SELECT count(*) FROM pg_default_acl WHERE defaclacl::text LIKE '%stateaction_app=%'")"
[[ "$leftover" == 0 ]] || { echo "default ACLs for the app role remain" >&2; exit 1; }
echo "== restricted role on the catalog: intended operations allowed, escalation/DDL/mutation denied"
denied() { # statement, expected SQLSTATE class text
  local out; out="$(APP_AS -c "$1" 2>&1 || true)"
  grep -qE 'permission denied|must be owner' <<<"$out" || { echo "expected denial for: $1 -> $out" >&2; exit 1; }
}
APP_AS -c "SELECT count(*) FROM platform_schema_migrations" >/dev/null
APP_AS -c "INSERT INTO \"user\" (id, name, email, \"emailVerified\") VALUES ('smoke-user','s','s@example.test',true)" >/dev/null
APP_AS -c "INSERT INTO session (id, \"expiresAt\", token, \"createdAt\", \"updatedAt\", \"userId\") VALUES ('smoke-s', now() + interval '1 day', 'smoke-token', now(), now(), 'smoke-user')" >/dev/null
APP_AS -c "DELETE FROM session WHERE id = 'smoke-s'" >/dev/null
APP_AS -c "SELECT count(*) FROM ingest_permissions" >/dev/null
denied "DELETE FROM ingest_permissions"
denied "UPDATE recording_registrations SET permission_ref = 'x'"
denied "CREATE TABLE should_fail(x int)"
denied "DROP TABLE platform_schema_migrations"
denied "ALTER TABLE recordings ADD COLUMN x int"
denied "INSERT INTO access (user_id, role) VALUES ('smoke-user','staff')"
denied "UPDATE access SET enabled = true"
denied "UPDATE reviews SET decision = 'approved'"
denied "DELETE FROM reviews"
denied "DELETE FROM clips"
denied "DELETE FROM recordings"
denied "SELECT stateaction_grant_app_role('stateaction_app')"
psql_as migration_owner "$OWNER_PW" "$DB_NAME" -c "DELETE FROM \"user\" WHERE id = 'smoke-user'" >/dev/null
echo "restricted role checks passed"

echo "== production start: injected env only, no .env file, PORT=$WEB_PORT"
test ! -e .env
HOSTED_ENV=(env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production APP_ENV=production PORT="$WEB_PORT"
  DATABASE_HOST="$DB_HOST" DATABASE_PORT="$DB_PORT" DATABASE_NAME="$DB_NAME" APP_DB_PASSWORD="$APP_PW"
  S3_REGION=auto S3_ENDPOINT=https://smokeaccount.r2.cloudflarestorage.com S3_BUCKET=stateaction-smoke
  S3_ACCESS_KEY_ID=smoke-access-key S3_SECRET_ACCESS_KEY=smoke-secret-key-not-real
  PROCESSING_PROFILE_REVISION=smoke-1 SUPPORTED_RGB_PROFILES=h264_mcap_v1
  PROCESSING_EXECUTION_BACKEND=modal PROCESSING_CODE_REVISION=smoke-rev
  PROCESSING_IMAGE_SPEC_SHA256=$(printf image | sha256sum | cut -d' ' -f1)
  PROCESSING_MODEL_SHA256=fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1
  PROCESSING_CONFIG_SHA256=$(printf config | sha256sum | cut -d' ' -f1))
"${HOSTED_ENV[@]}" pnpm --filter @stateaction/server hosted:preflight
# SA-25: hosted preflight refuses to start without the permanent job input identity.
for missing in PROCESSING_EXECUTION_BACKEND PROCESSING_CODE_REVISION PROCESSING_IMAGE_SPEC_SHA256 PROCESSING_MODEL_SHA256 PROCESSING_CONFIG_SHA256; do
  without=()
  for assignment in "${HOSTED_ENV[@]}"; do [[ "$assignment" == "$missing="* ]] || without+=("$assignment"); done
  if "${without[@]}" pnpm --filter @stateaction/server hosted:preflight >/dev/null 2>&1; then
    echo "hosted preflight must require $missing" >&2; exit 1
  fi
done
# SA-71: the development-only simulated capture flag must make hosted preflight fail.
if "${HOSTED_ENV[@]}" ALLOW_SIMULATED_CAPTURE_INPUTS=true pnpm --filter @stateaction/server hosted:preflight >/dev/null 2>&1; then
  echo "hosted preflight must refuse ALLOW_SIMULATED_CAPTURE_INPUTS" >&2; exit 1
fi
echo "hosted preflight refuses ALLOW_SIMULATED_CAPTURE_INPUTS"
setsid "${HOSTED_ENV[@]}" pnpm --filter @stateaction/web start > artifacts/hosted-smoke/web.log 2>&1 &
web_pid=$!
LAN_IP="$(python3 -c "import socket;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.connect(('192.0.2.1',9));print(s.getsockname()[0])")"
for _ in {1..60}; do curl -sf "http://$LAN_IP:$WEB_PORT/api/v1/live" >/dev/null && break; sleep 1; done
curl -sf "http://$LAN_IP:$WEB_PORT/api/v1/live"; echo " <- /live via non-loopback $LAN_IP:$WEB_PORT (0.0.0.0 bind)"
code="$(curl -s -o artifacts/hosted-smoke/health.json -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/api/v1/health")"
cat artifacts/hosted-smoke/health.json; echo
[[ "$code" == 503 ]] && grep -q '"database":true' artifacts/hosted-smoke/health.json && grep -q '"storage":false' artifacts/hosted-smoke/health.json \
  || { echo "expected database via restricted role true, fake R2 false" >&2; exit 1; }
dispatch="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$WEB_PORT/api/v1/development/workflows/verify")"
[[ "$dispatch" == 404 ]] || { echo "development dispatch must be disabled in production ($dispatch)" >&2; exit 1; }
echo "development dispatch disabled: 404"

echo "== Render-hosted APP_ENV=development: RENDER=true injected env binds 0.0.0.0:\$PORT, no .env"
kill -- "-$web_pid" 2>/dev/null || true; web_pid=''
for _ in {1..30}; do python3 -c "import socket,sys;s=socket.socket();s.bind(('0.0.0.0',$WEB_PORT))" 2>/dev/null && break; sleep 1; done
DEV_ENV=(env -i PATH="$PATH" HOME="$HOME" RENDER=true APP_ENV=development PORT="$WEB_PORT")
setsid "${DEV_ENV[@]}" pnpm --filter @stateaction/web start > artifacts/hosted-smoke/web-dev.log 2>&1 &
web_pid=$!
for _ in {1..60}; do curl -sf "http://$LAN_IP:$WEB_PORT/api/v1/live" >/dev/null && break; sleep 1; done
curl -sf "http://$LAN_IP:$WEB_PORT/api/v1/live"; echo " <- development service reachable via non-loopback (RENDER=true)"

echo "== hosted-style workflow env: tasks register, no database/storage credentials"
printf 'APP_ENV=production\n' > artifacts/hosted-smoke/workflow.env
setsid env -i PATH="$PATH" HOME="$HOME" "$RENDER" workflows dev --port "$RUNNER_PORT" --env-file artifacts/hosted-smoke/workflow.env -- pnpm --filter @stateaction/jobs start > artifacts/hosted-smoke/workflow.log 2>&1 &
runner_pid=$!
for _ in {1..60}; do "$RENDER" workflows tasks list --local --port "$RUNNER_PORT" -o text 2>/dev/null | grep -q verify-platform && break; sleep 1; done
"$RENDER" workflows tasks list --local --port "$RUNNER_PORT" -o text | grep verify-platform
for pid in $(pgrep -g "$runner_pid"); do
  if tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -E '^(DATABASE_|MIGRATION_|APP_DB_|S3_)'; then
    echo "workflow process $pid received a forbidden credential" >&2; exit 1
  fi
done
echo "workflow process tree has no database/storage/API credentials"
out="$("$RENDER" workflows start verify-platform --local --port "$RUNNER_PORT" --input='[{"requestId":"11111111-1111-4111-8111-111111111111"}]' -o json)"
run="$(printf '%s' "$out" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("taskRunId") or d.get("id"))')"
for _ in {1..30}; do
  state="$("$RENDER" workflows tasks runs show "$run" --local --port "$RUNNER_PORT" -o json)"
  status="$(printf '%s' "$state" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("status"))')"
  [[ "$status" == failed || "$status" == completed ]] && break; sleep 1
done
# Production processing is deferred: the health fixture must NOT succeed outside local.
[[ "$status" == failed ]] && printf '%s' "$state" | grep -q 'explicit local configuration' \
  || { echo "verify-platform must refuse to run outside local ($status)" >&2; exit 1; }
echo "verify-platform refused outside local: production processor remains deferred"
echo "hosted smoke passed"
