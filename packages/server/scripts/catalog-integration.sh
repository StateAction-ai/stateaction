#!/usr/bin/env bash
# Real catalog integration on a throwaway Postgres (same pinned image as
# infra/compose.yaml) bound to an ephemeral loopback port with tmpfs storage.
# Roles mirror a managed deployment: a NOSUPERUSER/NOCREATEDB migration owner
# with CREATEROLE owns each database; the restricted app role is created by
# that owner. The bootstrap superuser only creates databases (provisioning).
set -euo pipefail
cd "$(dirname "$0")/.."
root="$(cd ../.. && pwd)"
image=$(sed -n 's/^ *image: \(postgres:.*\)$/\1/p' "$root/infra/compose.yaml" | head -1)
[[ -n "$image" ]] || { echo "Could not read the pinned Postgres image" >&2; exit 1; }
name="stateaction-catalog-it-$(python3 -c 'import secrets; print(secrets.token_hex(6))')"
secret() { python3 -c 'import secrets; print(secrets.token_hex(24))'; }
admin_pw=$(secret); owner_pw=$(secret); app_pw=$(secret)
out="$root/artifacts/catalog-integration"
mkdir -p "$out"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --rm --name "$name" \
  -e POSTGRES_USER=bootstrap -e POSTGRES_PASSWORD="$admin_pw" -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 --tmpfs /var/lib/postgresql/data:rw,size=1g \
  "$image" >/dev/null
for _ in {1..60}; do
  docker exec "$name" pg_isready -U bootstrap -d postgres -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$name" pg_isready -U bootstrap -d postgres -h 127.0.0.1 >/dev/null
port=$(docker port "$name" 5432/tcp | head -1 | sed 's/.*://')
psql_as() { local user=$1 pw=$2; shift 2; docker exec -e PGPASSWORD="$pw" "$name" psql -v ON_ERROR_STOP=1 -qAt -h 127.0.0.1 -U "$user" -d postgres "$@"; }
psql_as bootstrap "$admin_pw" -c "CREATE ROLE migration_owner LOGIN CREATEROLE NOSUPERUSER NOCREATEDB NOBYPASSRLS PASSWORD '$owner_pw'"
psql_as migration_owner "$owner_pw" -c "CREATE ROLE stateaction_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '$app_pw'"
export CATALOG_TEST_ADMIN_URL="postgresql://bootstrap:$admin_pw@127.0.0.1:$port/postgres"
export CATALOG_TEST_OWNER_URL="postgresql://migration_owner:$owner_pw@127.0.0.1:$port/postgres"
export CATALOG_TEST_APP_URL="postgresql://stateaction_app:$app_pw@127.0.0.1:$port/postgres"
export CATALOG_TEST_ARTIFACTS="$out"
docker exec "$name" postgres --version > "$out/server-version.txt"
node --conditions=react-server --import tsx --test --test-concurrency=4 \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=junit --test-reporter-destination="$out/junit.xml" \
  test-integration/*.test.ts
