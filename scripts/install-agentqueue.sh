#!/usr/bin/env bash
# Build the pinned agentqueue binary into artifacts/platform-tools/agentqueue (ignored by Git).
# Network is needed only here, never at gate time. The recorded sha256 is self-attested (detects
# drift, not tampering by the same user). Run it under `agent-resource run --lane android-build --`
# when other heavy jobs are active; it is niced and limited to 2 jobs either way. Source: a local checkout whose HEAD is the
# pinned rev (default ~/projects/agentqueue; the repository is private), or --git URL.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pin="$here/config/agentqueue/pin.json"
rev="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["rev"])' "$pin")"
dest="${AGENTQUEUE_ROOT:-$here/artifacts/platform-tools/agentqueue}"
src="${AGENTQUEUE_SRC:-$HOME/projects/agentqueue}"
git_url=""
while [ $# -gt 0 ]; do
  case "$1" in
    --src) src="$2"; shift 2 ;;
    --git) git_url="$2"; shift 2 ;;
    --root) dest="$2"; shift 2 ;;
    *) echo "usage: $0 [--src CHECKOUT | --git URL] [--root DIR]" >&2; exit 64 ;;
  esac
done
export CARGO_BUILD_JOBS=2
if [ -n "$git_url" ]; then
  nice -n 10 cargo install --locked --git "$git_url" --rev "$rev" --root "$dest" --force agentqueue
else
  head="$(git -C "$src" rev-parse HEAD)"
  [ "$head" = "$rev" ] || { echo "checkout $src is at $head, pin is $rev" >&2; exit 1; }
  [ -z "$(git -C "$src" status --porcelain --untracked-files=normal)" ] || { echo "checkout $src has local changes" >&2; exit 1; }
  nice -n 10 cargo install --locked --path "$src" --root "$dest" --force
fi
sum="$(sha256sum "$dest/bin/agentqueue" | cut -d' ' -f1)"
printf '{"rev": "%s", "sha256": "%s", "installedBy": "scripts/install-agentqueue.sh"}\n' "$rev" "$sum" > "$dest/INSTALLED.json"
echo "installed agentqueue $rev sha256 $sum -> $dest/bin/agentqueue"
