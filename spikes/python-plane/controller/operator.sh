#!/usr/bin/env bash
# Rehearse a single CPU dispatch with the production web routes and local Render runner.
set -euo pipefail
cd "$(dirname "$0")"

case "${1:-}" in
  --rehearse)
    : "${STATEACTION_LOCAL_FIXTURES:?Set the path to the bounded local fixtures}"
    unset RENDER_API_KEY RENDER_WORKSPACE_ID MODAL_TOKEN_ID MODAL_TOKEN_SECRET
    export DO_NOT_TRACK=1
    exec node local-e2e.mjs
    ;;
  --hosted)
    printf '%s\n' 'Hosted execution is disabled while exact Modal definition verification is unqualified.' >&2
    exit 2
    ;;
  *)
    printf '%s\n' 'Usage: operator.sh --rehearse' >&2
    exit 2
    ;;
esac
