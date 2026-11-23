#!/usr/bin/env bash
# The exact command sequence the deploy workflow runs; also runnable from an operator machine.
#   scripts/deploy/render-deploy.sh <dry-run|prepare|production> <40-hex ref>
# `prepare` installs and builds WITHOUT any secret in the environment; `production` only
# estimates, validates and runs the engine (secrets are never exposed to install/build/test code).
# Secrets come from the environment only (never argv, never printed): RENDER_API_KEY,
# S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, APP_DB_PASSWORD, optional
# RENDER_DISPATCH_API_KEY, MODAL_TOKEN_ID/SECRET, GOOGLE_CLIENT_ID/SECRET. dry-run needs none.
set -euo pipefail
cd "$(dirname "$0")/../.."
mode="${1:?usage: render-deploy.sh <dry-run|production> <ref>}"
ref="${2:?missing ref}"
[[ "$ref" =~ ^[0-9a-f]{40}$ ]] || { echo "ref must be a 40-hex commit" >&2; exit 2; }
engine=scripts/platform/render-deploy.mjs
state="artifacts/render-deploy-state.json"
mkdir -p artifacts
export RENDER="${RENDER:-artifacts/platform-tools/render/render}"
node "$engine" estimate # prices the Blueprint plans and refuses above the cap
if [[ "$mode" == dry-run ]]; then node --test infra/test/*.test.mjs scripts/platform/render-deploy.test.mjs; fi
if [[ "$mode" == prepare ]]; then
  for name in RENDER_API_KEY S3_SECRET_ACCESS_KEY APP_DB_PASSWORD MODAL_TOKEN_SECRET; do
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
[[ "$mode" == production ]] || { echo "unknown mode $mode" >&2; exit 2; }
RENDER="$(cd "$(dirname "$RENDER")" && pwd)/$(basename "$RENDER")"
[[ -f packages/server/dist/cli.js ]] || { echo "run the prepare mode first" >&2; exit 2; }
export PATH="$(dirname "$RENDER"):$PATH"
render blueprints validate render.yaml -o text
args=(--environment production --ref "$ref" --state "$state")
node "$engine" provision "${args[@]}"
node "$engine" configure "${args[@]}"
node "$engine" migrate "${args[@]}"
if ! node "$engine" deploy "${args[@]}"; then node "$engine" rollback "${args[@]}" || echo "ROLLBACK FAILED: inspect Render" >&2; exit 1; fi
if ! node "$engine" smoke "${args[@]}"; then node "$engine" rollback "${args[@]}" || echo "ROLLBACK FAILED: inspect Render" >&2; exit 1; fi
echo "deploy of ${ref} complete"
