#!/usr/bin/env bash
# Dedicated synthetic-camera device; never selects the connected physical phone.
#
# Default: KVM (-accel on), x86_64 guest, host GPU rendering (-gpu host), cold boot.
# A warm emulator is reused only after it is verified; a software-rendered one is
# never silently accepted. Usage:
#   start_capture_emulator.sh [--ar] [--quick-boot] [--software] [--replace]
#                             [--force-cold-start] [--verify-only] [emulator args...]
#   --ar          pinned ARCore target: API33 AVD, emulator 36.4.10, port 5582
#   --quick-boot  opt in to snapshots for ordinary app tests (camera/lifecycle/recovery
#                 tests keep the default cold boot)
#   --software    explicit software-rendering (CI/compatibility); labeled NOT ACCELERATED
#   --replace     stop a running dedicated emulator that fails verification, then relaunch
#   --force-cold-start  stop the running dedicated emulator even if healthy and cold boot
#                 (overrides --quick-boot; for camera/lifecycle/recovery checks)
#   --verify-only verify the running emulator and exit
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/env.sh"
export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
emulator="$ANDROID_HOME/emulator/emulator"
capture_avd=stera_ar_api35
capture_port=5580
capture_extra=()
profile=accelerated-kvm-host-gpu
quick_boot=0 replace=0 verify_only=0 force_cold=0
boot_timeout="${CAPTURE_EMULATOR_BOOT_TIMEOUT:-240}"
[[ "${CAPTURE_EMULATOR_PROFILE:-}" == software ]] && profile=software-rendering-not-accelerated
if [[ -n "${CAPTURE_EMULATOR_GPU:-}" && "$CAPTURE_EMULATOR_GPU" != host ]]; then
  echo "CAPTURE_EMULATOR_GPU=$CAPTURE_EMULATOR_GPU is not allowed by default; use --software." >&2
  exit 2
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ar)
      emulator="$ROBOTICS_CAPTURE_TOOLS/emulator-36.4.10/emulator/emulator"
      capture_avd=stera_ar_api33
      capture_port=5582
      capture_extra=(-feature -Vulkan) # Vulkan stays off for the pinned ARCore image.
      ;;
    --quick-boot) quick_boot=1 ;;
    --software) profile=software-rendering-not-accelerated ;;
    --replace) replace=1 ;;
    --force-cold-start) force_cold=1; replace=1 ;;
    --verify-only) verify_only=1 ;;
    *) break ;;
  esac
  shift
done
serial="emulator-$capture_port"
state_dir="$ROBOTICS_CAPTURE_ROOT/artifacts/emulator-verification"
helper=("python3" "$script_dir/mobile/emulator_acceleration.py")
verify_args=(verify --serial "$serial" --avd "$capture_avd" --port "$capture_port"
  --profile "$profile" --expect-gpu "${CAPTURE_EMULATOR_EXPECT_GPU:-NVIDIA}" --out "$state_dir/$serial.json")
((quick_boot)) && verify_args+=(--requested-quick-boot)

if [[ "$profile" == software-rendering-not-accelerated ]]; then
  echo "################################################################" >&2
  echo "# SOFTWARE RENDERING (NOT ACCELERATED): evidence must say so.   #" >&2
  echo "################################################################" >&2
  gpu=swiftshader_indirect accel=auto
else
  gpu=host accel=on
  [[ "$(uname -sm)" == "Linux x86_64" && -r /dev/kvm && -w /dev/kvm ]] || {
    echo "Accelerated profile needs Linux x86_64 with read/write /dev/kvm; pass --software for labeled non-accelerated runs." >&2
    exit 1
  }
fi
if [[ ! -x "$emulator" || ! -f "$ANDROID_AVD_HOME/$capture_avd.ini" ]]; then
  echo "Install the emulator and $capture_avd AVD first; see docs/linux-recording-test-loop.md." >&2
  exit 1
fi

if timeout 20 adb -s "$serial" get-state >/dev/null 2>&1; then
  if ((!force_cold)) && "${helper[@]}" "${verify_args[@]}" >/dev/null; then
    mode="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["boot_mode"])' "$state_dir/$serial.json")"
    echo "Reusing warm $serial (verified: $profile; actual boot mode: $mode; evidence $state_dir/$serial.json)."
    ((quick_boot)) && [[ "$mode" == cold ]] && echo "Note: --quick-boot was requested but the running instance is cold-booted." >&2
    exit 0
  fi
  if ((verify_only || !replace)); then
    echo "Running $serial failed verification for $profile; rerun with --replace to restart it." >&2
    exit 1
  fi
  echo "Stopping $serial before relaunch ($( ((force_cold)) && echo --force-cold-start || echo "failed verification, --replace" ))." >&2
  timeout 20 adb -s "$serial" emu kill >/dev/null 2>&1 || true
  for _ in $(seq 30); do timeout 20 adb -s "$serial" get-state >/dev/null 2>&1 || break; sleep 1; done
  if timeout 20 adb -s "$serial" get-state >/dev/null 2>&1; then
    echo "$serial did not stop; refusing to start a second instance." >&2
    exit 1
  fi
elif ((verify_only)); then
  echo "$serial is not running." >&2
  exit 1
fi

if [[ "$profile" == accelerated-kvm-host-gpu ]]; then
  # Assign first so set -e sees the helper's exit status (eval "$(cmd)" would mask it).
  display_exports="$("${helper[@]}" display)" || {
    echo "Display discovery failed; the emulator was not started." >&2
    exit 1
  }
  eval "$display_exports" # process-local DISPLAY/XAUTHORITY; no cookie is read
fi
snapshot_args=(-no-snapshot)
((quick_boot && !force_cold)) && snapshot_args=()
mkdir -p "$state_dir"
log="$state_dir/$serial.log"
nohup setsid "$emulator" -avd "$capture_avd" -port "$capture_port" \
  -camera-back virtualscene -camera-front none -no-audio "${snapshot_args[@]}" \
  -accel "$accel" -gpu "$gpu" "${capture_extra[@]}" "$@" >"$log" 2>&1 &
launcher_pid=$!
echo "Launched $serial ($profile, requested $( ((${#snapshot_args[@]})) && echo cold-boot || echo quick-boot)); log $log"
deadline=$((SECONDS + boot_timeout))
booted=0
while ((SECONDS < deadline)); do
  if ! kill -0 "$launcher_pid" 2>/dev/null; then
    echo "Emulator process exited during startup; no fallback was attempted. Log: $log" >&2
    tail -n 15 "$log" >&2 || true
    exit 1
  fi
  if [[ "$(timeout 20 adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then
    booted=1
    break
  fi
  sleep 2
done
((booted)) || {
  echo "$serial did not finish booting within ${boot_timeout}s; emulator left running (pid $launcher_pid), log $log" >&2
  exit 1
}
"${helper[@]}" "${verify_args[@]}" || {
  echo "Launched emulator failed verification; it was left running for inspection (log $log)." >&2
  exit 1
}
