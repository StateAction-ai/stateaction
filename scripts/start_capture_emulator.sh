#!/usr/bin/env bash
# Dedicated synthetic-camera device; never selects the connected physical phone.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/env.sh"
export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
emulator="$ANDROID_HOME/emulator/emulator"
capture_avd=stera_ar_api35
capture_port=5580
capture_extra=()
if [[ "${1:-}" == --ar ]]; then
  shift
  emulator="$ROBOTICS_CAPTURE_TOOLS/emulator-36.4.10/emulator/emulator"
  capture_avd=stera_ar_api33
  capture_port=5582
  capture_extra=(-feature -Vulkan)
fi
if [[ ! -x "$emulator" || ! -f "$ANDROID_AVD_HOME/$capture_avd.ini" ]]; then
  echo "Install the emulator and $capture_avd AVD first; see docs/linux-recording-test-loop.md." >&2
  exit 1
fi
if adb -s "emulator-$capture_port" get-state >/dev/null 2>&1; then
  echo "The capture emulator is already running as emulator-$capture_port."
  exit 0
fi
exec "$emulator" -avd "$capture_avd" -port "$capture_port" \
  -camera-back virtualscene -camera-front none -no-audio -no-snapshot \
  -gpu "${CAPTURE_EMULATOR_GPU:-swiftshader_indirect}" "${capture_extra[@]}" "$@"
