#!/usr/bin/env bash
# Real catalog integration on a throwaway Postgres (same pinned image as
# infra/compose.yaml) bound to an ephemeral loopback port with tmpfs storage.
# Roles mirror a managed deployment: a NOSUPERUSER/NOCREATEDB migration owner
# with CREATEROLE owns each database; the restricted app role is created by
# that owner. The bootstrap superuser only creates databases (provisioning).
set -euo pipefail
# Optional arguments select test files; default is the whole suite.
(( $# )) || set -- test-integration/*.test.ts
cd "$(dirname "$0")/.."
root="$(cd ../.. && pwd)"
image=$(sed -n 's/^ *image: \(postgres:.*\)$/\1/p' "$root/infra/compose.yaml" | head -1)
[[ -n "$image" ]] || { echo "Could not read the pinned Postgres image" >&2; exit 1; }
name="stateaction-catalog-it-$(python3 -c 'import secrets; print(secrets.token_hex(6))')"
secret() { python3 -c 'import secrets; print(secrets.token_hex(24))'; }
admin_pw=$(secret); owner_pw=$(secret); app_pw=$(secret)
out="$root/artifacts/catalog-integration"
mkdir -p "$out"
# Throwaway SeaweedFS S3 (same pinned image as infra/compose.yaml) with a random
# per-run identity, for the real storage-backed source-manifest reader.
storage_image=$(sed -n 's/^ *image: \(chrislusf\/seaweedfs:.*\)$/\1/p' "$root/infra/compose.yaml" | head -1)
[[ -n "$storage_image" ]] || { echo "Could not read the pinned SeaweedFS image" >&2; exit 1; }
storage_name="${name}-s3"
storage_dir=$(mktemp -d)
s3_key="it$(python3 -c 'import secrets; print(secrets.token_hex(8))')"; s3_secret=$(secret)
python3 - "$storage_dir/s3.json" "$s3_key" "$s3_secret" <<'PY'
import json, sys
json.dump({"identities": [{"name": "catalog-it", "credentials": [{"accessKey": sys.argv[2], "secretKey": sys.argv[3]}], "actions": ["Admin", "Read", "List", "Write"]}]}, open(sys.argv[1], "w"))
PY
chmod 0644 "$storage_dir/s3.json"
cleanup() { docker rm -f "$name" "$storage_name" >/dev/null 2>&1 || true; rm -rf "$storage_dir"; }
trap cleanup EXIT
docker run -d --rm --name "$name" \
  -e POSTGRES_USER=bootstrap -e POSTGRES_PASSWORD="$admin_pw" -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 --tmpfs /var/lib/postgresql/data:rw,size=1g \
  "$image" >/dev/null
docker run -d --rm --name "$storage_name" -p 127.0.0.1::9000 \
  -v "$storage_dir/s3.json:/etc/seaweedfs/s3.json:ro" \
  -v "$root/infra/seaweedfs-master.toml:/etc/seaweedfs/master.toml:ro" \
  --tmpfs /data:rw,size=512m \
  "$storage_image" server -ip=127.0.0.1 -ip.bind=0.0.0.0 -dir=/data -volume.max=8 \
  -master.volumeSizeLimitMB=64 -filer -s3 -s3.port=9000 -s3.config=/etc/seaweedfs/s3.json >/dev/null
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
s3_port=$(docker port "$storage_name" 9000/tcp | head -1 | sed 's/.*://')
for _ in {1..60}; do
  docker exec "$storage_name" wget -qO- http://127.0.0.1:9333/dir/status 2>/dev/null | grep -q '"Url":"127.0.0.1:8080"' && break
  sleep 1
done
export STORAGE_TEST_ENDPOINT="http://127.0.0.1:$s3_port"
export STORAGE_TEST_ACCESS_KEY_ID="$s3_key" STORAGE_TEST_SECRET_ACCESS_KEY="$s3_secret"
docker exec "$name" postgres --version > "$out/server-version.txt"
node --conditions=react-server --import tsx --test --test-concurrency=4 \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=junit --test-reporter-destination="$out/junit.xml" \
  "$@"
