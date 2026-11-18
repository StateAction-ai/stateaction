#!/usr/bin/env bash
# Real Dart -> MethodChannel -> SteraRecorderPlugin -> Kotlin Os hashing probe.
# Emulator only, personal user 0, headless (a service hosts the FlutterEngine:
# no activity, no foreground window, does not touch other packages).
# Usage: scripts/source_hash_probe.sh [emulator-serial]   (default emulator-5582)
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Generated projects share the same enforced budget as the actual app.
if ! python3 -c 'import pathlib; p=pathlib.Path("/proc/self/cgroup").read_text(); raise SystemExit(0 if p.strip().endswith("/agent-mobile-build.scope") and "/agent-work.slice/" in p else 1)'; then
  exec "$HOME/.local/bin/agent-resource" run -- bash "$SCRIPT_DIR/source_hash_probe.sh" "$@"
fi
source "$SCRIPT_DIR/env.sh"
SERIAL="${1:-emulator-5582}"
PKG=ai.stateaction.sourceprobe
case "$SERIAL" in emulator-[0-9]*) ;; *) echo "Refusing non-emulator serial: $SERIAL" >&2; exit 2 ;; esac
[[ "$(adb -s "$SERIAL" shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]] || { echo "not an emulator: $SERIAL" >&2; exit 2; }
PROBE="$ROBOTICS_CAPTURE_ROOT/apps/mobile/tool/source_hash_probe"
OUT="${PROBE_OUT:-$ROBOTICS_CAPTURE_ROOT/artifacts/source-hash-probe/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$OUT"
( cd "$PROBE" && flutter build apk --debug --target-platform android-x64 ) | tee "$OUT/build.log" | tail -2
APK="$PROBE/build/app/outputs/flutter-apk/app-debug.apk"
git -C "$ROBOTICS_CAPTURE_ROOT" rev-parse HEAD > "$OUT/source-head.txt"
# Shared mobile lock, bounded wait; held only for install+run (headless, short).
exec 9>/tmp/stateaction-mobile-validation.lock
flock -w 60 9 || { echo "mobile lock busy >60s; not running" >&2; exit 3; }
PD=(python3 "$SCRIPT_DIR/android_personal_device.py" --serial "$SERIAL" --user 0)
"${PD[@]}" install --package "$PKG" --apk "$APK"
adb -s "$SERIAL" shell am force-stop --user 0 "$PKG"
# A same-version reinstall can leave Flutter's extracted debug bundle in place.
adb -s "$SERIAL" shell run-as "$PKG" --user 0 rm -rf app_flutter code_cache/flutter_engine
adb -s "$SERIAL" shell run-as "$PKG" --user 0 rm -f files/result.json || true
# Optional, ignored fixture produced by actual recorder instrumentation: bytes
# are streamed into this dedicated emulator package, never passed in argv.
if [[ -n "${PROBE_NATIVE_FIXTURE:-}" ]]; then
  python3 - "$SERIAL" "$PKG" "$PROBE_NATIVE_FIXTURE" <<'STAGE'
import json, pathlib, re, subprocess, sys
serial, package, directory = sys.argv[1:]
root = pathlib.Path(directory).resolve()
fixture = root / "native-stop.json"
if fixture.stat().st_size > 65536:
    raise SystemExit("native stop fixture too large")
doc = json.loads(fixture.read_bytes())
files = ["native-stop.json", *doc["hashes"].keys()]
subprocess.run(["adb", "-s", serial, "shell", "run-as", package, "--user", "0", "mkdir", "-p", "files/native-source"], check=True)
for name in files:
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,200}", name) or name in (".", ".."):
        raise SystemExit("unsafe native fixture name")
    source = root / name
    if source.is_symlink() or source.resolve().parent != root:
        raise SystemExit("unsafe native fixture file")
    with source.open("rb") as stream:
        subprocess.run(["adb", "-s", serial, "shell", "run-as", package, "--user", "0", "sh", "-c", f"'cat > files/native-source/{name}'"], stdin=stream, check=True)
STAGE
else
  adb -s "$SERIAL" shell run-as "$PKG" --user 0 rm -rf files/native-source
fi
adb -s "$SERIAL" logcat -c -b main || true
# Background-start of our own idle package from shell needs a temporary doze allowlist (removed on exit).
adb -s "$SERIAL" shell cmd deviceidle whitelist "+$PKG" >/dev/null
trap 'adb -s "$SERIAL" shell cmd deviceidle whitelist "-$PKG" >/dev/null 2>&1 || true' EXIT
adb -s "$SERIAL" shell am start-service --user 0 -n "$PKG/.ProbeService" | tee "$OUT/start.log"
for _ in $(seq 1 60); do
  adb -s "$SERIAL" shell run-as "$PKG" --user 0 cat files/result.json > "$OUT/result.json" 2>/dev/null && [[ -s "$OUT/result.json" ]] && break
  sleep 1
done
adb -s "$SERIAL" shell am stopservice --user 0 -n "$PKG/.ProbeService" >/dev/null 2>&1 || adb -s "$SERIAL" shell am stop-service --user 0 "$PKG/.ProbeService" >/dev/null 2>&1 || true
adb -s "$SERIAL" logcat -d -b main -s flutter:I | grep SRCPROBE > "$OUT/logcat.txt" || true
cat "$OUT/logcat.txt" | grep -v "SRCPROBE JSON" || true
python3 - "$OUT/result.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
if not r["ok"]:
    raise SystemExit("probe FAILED")
print("probe ok:", len(r["results"]), "checks; evidence in", sys.argv[1])
PY
echo "$OUT"
