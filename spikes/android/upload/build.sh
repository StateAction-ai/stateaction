#!/usr/bin/env bash
# Assemble the spike debug + instrumentation APKs and run lint with the repository's pinned
# JDK 21 / Android SDK / Gradle 8.14. Needs no global Gradle and no SPIKE_GRADLE_BIN: the
# committed Flutter-app wrapper (apps/mobile/android/gradlew, pinned to Gradle 8.14 with a
# distribution SHA-256) bootstraps the distribution on a cache miss without building Flutter.
# Run `source artifacts/platform-tools/mobile/env.sh` first (CI exports the same variables).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
wrapper="$repo/apps/mobile/android/gradlew"
: "${JAVA_HOME:?JAVA_HOME must name the pinned JDK 21 (see scripts/mobile/README.md)}"
: "${ANDROID_HOME:?ANDROID_HOME must name the pinned Android SDK (see scripts/mobile/README.md)}"
"$JAVA_HOME/bin/java" -version 2>&1 | grep -q '"21\.' || { echo 'JDK 21 is required.' >&2; exit 1; }
expected="$(sed -n 's#^distributionUrl=.*gradle-\([0-9.]*\)-all\.zip$#\1#p' "$repo/apps/mobile/android/gradle/wrapper/gradle-wrapper.properties")"
[[ "$expected" == 8.14 ]] || { echo "Wrapper pins Gradle '$expected', expected 8.14." >&2; exit 1; }

gradle_binary="${SPIKE_GRADLE_BIN:-}"
if [[ -z "$gradle_binary" ]]; then
  # Verified download of the pinned distribution into the wrapper's normal home (a no-op when cached).
  "$wrapper" --version >/dev/null
  gradle_binary="$(compgen -G "${GRADLE_USER_HOME:-$HOME/.gradle}/wrapper/dists/gradle-8.14-all/*/gradle-8.14/bin/gradle" | head -n1 || true)"
fi
if [[ -z "$gradle_binary" || ! -x "$gradle_binary" ]]; then
  echo 'Could not locate the Gradle 8.14 distribution bootstrapped by apps/mobile/android/gradlew.' >&2
  exit 1
fi
if [[ "$("$gradle_binary" --version | sed -n 's/^Gradle //p')" != "8.14" ]]; then
  echo 'Gradle 8.14 is required.' >&2
  exit 1
fi
# Locally keep a separate writable Gradle home so the Flutter build's caches are never edited and
# share the dependency cache read-only. CI uses the default home that setup-gradle restores.
if [[ "${CI:-}" != true ]]; then
  export GRADLE_RO_DEP_CACHE="${GRADLE_RO_DEP_CACHE:-$HOME/.gradle/caches}"
  export GRADLE_USER_HOME="${SPIKE_GRADLE_USER_HOME:-$here/.gradle-user}"
fi
cd "$here"
exec "$gradle_binary" --no-daemon --max-workers=2 --console=plain :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug "$@"
