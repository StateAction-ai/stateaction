#!/usr/bin/env bash
# The exact command sequence the deploy workflow runs; also runnable from an operator machine.
#   scripts/deploy/render-deploy.sh <dry-run|prepare|production|components> <40-hex ref> [components-spec] [base-ref]
# `prepare` installs and builds WITHOUT any secret in the environment; `production` and `components`
# only estimate, validate and run the engine (secrets are never exposed to install/build/test code).
# Secrets come from the environment only (never argv, never printed): RENDER_API_KEY,
# S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, APP_DB_PASSWORD, optional
# RENDER_DISPATCH_API_KEY, MODAL_TOKEN_ID/SECRET, GOOGLE_CLIENT_ID/SECRET. dry-run needs none.
set -euo pipefail
cd "$(dirname "$0")/../.."
mode="${1:?usage: render-deploy.sh <dry-run|prepare|production|components> <ref> [components] [base]}"
ref="${2:?missing ref}"
components_spec="${3:-auto}"
base_ref="${4:-}"
[[ "$ref" =~ ^[0-9a-f]{40}$ ]] || { echo "ref must be a 40-hex commit" >&2; exit 2; }
engine=scripts/platform/render-deploy.mjs
scope=scripts/platform/deploy-scope.mjs
state="artifacts/render-deploy-state.json"
mkdir -p artifacts
export RENDER="${RENDER:-artifacts/platform-tools/render/render}"
node "$engine" estimate # prices the Blueprint plans and refuses above the cap
if [[ "$mode" == dry-run ]]; then
  node --test infra/test/*.test.mjs scripts/platform/render-deploy.test.mjs scripts/platform/deploy-scope.test.mjs
  scope_args=(--head "$ref" --components "$components_spec" --format json)
  if [[ -n "$base_ref" ]]; then scope_args+=(--base "$base_ref"); fi
  node "$scope" "${scope_args[@]}"
fi
if [[ "$mode" == prepare ]]; then
  for name in RENDER_API_KEY RENDER_DISPATCH_API_KEY RENDER_CREATE_KEY S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY APP_DB_PASSWORD MODAL_TOKEN_SECRET GOOGLE_CLIENT_SECRET; do
    [[ -z "${!name:-}" ]] || { echo "refusing to prepare with $name in the environment" >&2; exit 2; }
  done
  corepack enable
  pnpm install --frozen-lockfile --prod=false
  pnpm --filter "@stateaction/server..." build
  exit 0
fi
if [[ "$mode" == dry-run ]]; then
  if [[ -n "${RENDER_API_KEY:-}" ]]; then "$RENDER" blueprints validate render.yaml -o text; else echo "no RENDER_API_KEY: Blueprint schema validation skipped (static policy checks passed)"; fi
  echo "dry-run complete: nothing was created or changed"
  exit 0
fi
RENDER="$(cd "$(dirname "$RENDER")" && pwd)/$(basename "$RENDER")"
export PATH="$(dirname "$RENDER"):$PATH"
render blueprints validate render.yaml -o text
args=(--environment production --ref "$ref" --state "$state")

if [[ "$mode" == components ]]; then
  scope_args=(--head "$ref" --components "$components_spec" --format csv)
  if [[ -n "$base_ref" ]]; then scope_args+=(--base "$base_ref"); fi
  if [[ "$components_spec" == auto ]]; then
    live_refs="artifacts/render-live-refs.json"
    if node "$engine" live-refs --environment production --out "$live_refs" >/dev/null; then
      scope_args+=(--live-refs "$live_refs")
    else
      echo "warning: could not read live Render refs; falling back to git diff" >&2
    fi
  fi
  resolved=$(node "$scope" "${scope_args[@]}")
  echo "resolved deploy components: ${resolved:-none}"
  if [[ -z "$resolved" ]]; then
    echo "no Render components changed; skipping deploy"
    exit 0
  fi
  IFS=',' read -r -a selected <<< "$resolved"
  has_migrations=false
  has_web=false
  service_list=()
  for c in "${selected[@]}"; do
    case "$c" in
      migrations) has_migrations=true ;;
      web) has_web=true; service_list+=("web") ;;
      cron|workflow) service_list+=("$c") ;;
      *) echo "unexpected component $c" >&2; exit 2 ;;
    esac
  done
  if [[ "$has_migrations" == true ]]; then
    [[ -f packages/server/dist/cli.js ]] || { echo "run the prepare mode first" >&2; exit 2; }
    node "$engine" migrate --schema-only "${args[@]}"
  fi
  if (( ${#service_list[@]} > 0 )); then
    service_csv=$(IFS=','; echo "${service_list[*]}")
    if ! node "$engine" deploy --components "$service_csv" "${args[@]}"; then
      if [[ "$has_web" == true ]]; then
        node "$engine" rollback "${args[@]}" || echo "ROLLBACK FAILED: inspect Render" >&2
      fi
      exit 1
    fi
  fi
  if [[ "$has_web" == true ]]; then
    if ! node "$engine" smoke "${args[@]}"; then
      node "$engine" rollback "${args[@]}" || echo "ROLLBACK FAILED: inspect Render" >&2
      exit 1
    fi
  fi
  echo "component deploy (${resolved}) of ${ref} complete"
  exit 0
fi

[[ "$mode" == production ]] || { echo "unknown mode $mode" >&2; exit 2; }
[[ -f packages/server/dist/cli.js ]] || { echo "run the prepare mode first" >&2; exit 2; }
node "$engine" provision "${args[@]}"
node "$engine" configure "${args[@]}"
node "$engine" migrate "${args[@]}"
if ! node "$engine" deploy "${args[@]}"; then node "$engine" rollback "${args[@]}" || echo "ROLLBACK FAILED: inspect Render" >&2; exit 1; fi
if ! node "$engine" smoke "${args[@]}"; then node "$engine" rollback "${args[@]}" || echo "ROLLBACK FAILED: inspect Render" >&2; exit 1; fi
echo "deploy of ${ref} complete"
