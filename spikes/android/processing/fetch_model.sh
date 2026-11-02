#!/usr/bin/env bash
# Fetch the pinned MediaPipe hand landmarker into the user cache and verify its SHA-256.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
url="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["url"])' "$here/model.json")"
want="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sha256"])' "$here/model.json")"
dest="${MEDIAPIPE_MODEL:-$HOME/.cache/mediapipe/hand_landmarker.task}"
mkdir -p "$(dirname "$dest")"
if [ ! -f "$dest" ]; then
  tmp="$(mktemp "$dest.XXXXXX")"
  curl -fsSL --proto '=https' -o "$tmp" "$url"
  mv "$tmp" "$dest"
fi
got="$(sha256sum "$dest" | cut -d' ' -f1)"
[ "$got" = "$want" ] || { echo "model hash mismatch: $got" >&2; exit 1; }
echo "$dest $got"
