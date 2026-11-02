#!/usr/bin/env bash
# Keep the guarded SDK supervisor alive across transient heavy jobs. This
# command remains running; stop the exact dedicated emulator to finish it.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if ! python3 -c 'from pathlib import Path; import sys; sys.exit(0 if "/agent-service-emulator-control.scope" in Path("/proc/self/cgroup").read_text() else 1)'; then
  exec agent-resource serve --name emulator-control -- bash "$0" "$@"
fi
source "$script_dir/env.sh"
serial=emulator-5580
for arg in "$@"; do
  [[ "$arg" != --ar ]] || serial=emulator-5582
done
# No physical serial can be selected. A lost control scope causes the existing
# watchdog to reap the SDK supervisor's orphaned VM in its separate 6 GiB scope.
cleanup() { timeout 20 adb -s "$serial" emu kill >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
bash "$script_dir/start_capture_emulator.sh" "$@"
echo "Guarded $serial supervisor remains active for warm reuse."
while timeout 20 adb -s "$serial" get-state >/dev/null 2>&1; do sleep 2; done
