#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
source ../../../scripts/env.sh
gradle_binary="${SPIKE_GRADLE_BIN:-$HOME/.gradle/wrapper/dists/gradle-8.14-all/c2qonpi39x1mddn7hk5gh9iqj/gradle-8.14/bin/gradle}"
if [[ ! -x "$gradle_binary" ]]; then
  echo 'Set SPIKE_GRADLE_BIN to a Gradle 8.14 executable.' >&2
  exit 1
fi
export GRADLE_RO_DEP_CACHE="${GRADLE_RO_DEP_CACHE:-$HOME/.gradle/caches}"
export GRADLE_USER_HOME="$PWD/.gradle-user"
exec "$gradle_binary" --no-daemon --max-workers=2 :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug "$@"
