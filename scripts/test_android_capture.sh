#!/usr/bin/env bash
# Native Android codec + producer fixture tests; refuses to target a physical device.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/env.sh"
CAPTURE_EMULATOR_SERIAL="${1:-emulator-5580}"
case "$CAPTURE_EMULATOR_SERIAL" in
  emulator-[0-9]*) ;;
  *) printf 'Refusing non-emulator serial: %s\n' "$CAPTURE_EMULATOR_SERIAL" >&2; exit 2 ;;
esac
if [[ "$(adb -s "$CAPTURE_EMULATOR_SERIAL" shell getprop ro.kernel.qemu | tr -d '\r')" != 1 ]]; then
  printf 'Target is not a running Android emulator: %s\n' "$CAPTURE_EMULATOR_SERIAL" >&2
  exit 2
fi
CAPTURE_APP_ROOT="$ROBOTICS_CAPTURE_ROOT/apps/mobile"
CAPTURE_TEST_RESULTS="$ROBOTICS_CAPTURE_ROOT/artifacts/android-capture-tests/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$CAPTURE_TEST_RESULTS"
# Incremental Gradle tasks; no production app install and no connectedAndroidTest.
(
  cd "$CAPTURE_APP_ROOT/android"
  ./gradlew :stera_recorder:testDebugUnitTest :stera_recorder:assembleDebugAndroidTest --console=plain
) | tee "$CAPTURE_TEST_RESULTS/build.log"
CAPTURE_TEST_APK="$CAPTURE_APP_ROOT/build/stera_recorder/outputs/apk/androidTest/debug/stera_recorder-debug-androidTest.apk"
# Always scope app mutations to the emulator's full user0; never --user all.
adb -s "$CAPTURE_EMULATOR_SERIAL" install --user 0 -r "$CAPTURE_TEST_APK"
adb -s "$CAPTURE_EMULATOR_SERIAL" shell am instrument --user 0 -w -r \
  open.fpvlabs.stera.ar_recorder.test/androidx.test.runner.AndroidJUnitRunner \
  | tee "$CAPTURE_TEST_RESULTS/instrumentation.log"
# Android's am command can exit zero despite test failures.
python3 - "$CAPTURE_TEST_RESULTS/instrumentation.log" <<'PY'
import pathlib, re, sys
result = pathlib.Path(sys.argv[1]).read_text()
if not re.search(r'OK \([1-9][0-9]* tests?\)', result) or 'FAILURES!!!' in result:
    raise SystemExit('Android instrumentation did not report a successful test suite')
PY
adb -s "$CAPTURE_EMULATOR_SERIAL" exec-out run-as open.fpvlabs.stera.ar_recorder.test --user 0 \
  tar -C files -cf - geometry-fixtures > "$CAPTURE_TEST_RESULTS/geometry-fixtures.tar"
tar -xf "$CAPTURE_TEST_RESULTS/geometry-fixtures.tar" -C "$CAPTURE_TEST_RESULTS"
printf 'Tests passed. Native producer fixtures and logs: %s\n' "$CAPTURE_TEST_RESULTS"
