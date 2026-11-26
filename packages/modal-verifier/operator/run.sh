#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ $# != 3 ]]; then
  printf 'Usage: %s MANIFEST SHA256 check|run|cleanup\n' "$0" >&2
  exit 2
fi
manifest=$1
digest=$2
mode=$3
[[ "$manifest" = /*.sha256 && "$digest" =~ ^[a-f0-9]{64}$ ]]
[[ "$mode" =~ ^(check|run|cleanup)$ ]]
root="$(git rev-parse --show-toplevel)"
cd "$root"
[[ "$(sha256sum "$manifest" | cut -d ' ' -f 1)" == "$digest" ]]
sha256sum --check --strict --quiet "$manifest"

scope="${manifest%.sha256}.scope"
grep -Fxq "$(sha256sum "$scope")" "$manifest"
mapfile -t binding < "$scope"
[[ ${#binding[@]} == 5 ]]
head=${binding[0]}
app=${binding[1]}
receipt=${binding[2]}
workspace=${binding[3]}
node=${binding[4]}
[[ "$receipt" = /* && "$node" = /* && "$workspace" =~ ^[A-Za-z0-9_-]+$ ]]
[[ "$app" =~ ^sa-152-probe-[a-f0-9]{16}$ ]]
[[ "$(git rev-parse HEAD)" == "$head" && -z "$(git status --porcelain)" ]]
grep -Fxq "$(sha256sum "$node")" "$manifest"
[[ "$("$node" --version)" == "v24.22.2" ]]
python="packages/modal-verifier/.venv/bin/python"
[[ "$("$python" --version)" == "Python 3.12.13" ]]
if [[ "$mode" == check ]]; then
  exit 0
fi
exec "$python" -B -X pycache_prefix=/dev/null -E -s packages/modal-verifier/operator/window.py \
  "$receipt" "$digest" "$app" "$workspace" "$node" "$mode" >/dev/null 2>&1
