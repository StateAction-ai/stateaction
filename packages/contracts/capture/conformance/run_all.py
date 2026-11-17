"""Run every available cross-language golden conformance runner and print a machine-readable receipt.

  python3 packages/contracts/capture/conformance/run_all.py --require python,typescript,dart,kotlin
  python3 packages/contracts/capture/conformance/run_all.py --require python,typescript,dart,kotlin,swift

A runner named in --require that cannot run (missing toolchain) or fails exits non-zero: unsupported
languages are reported as `unavailable`, never as passed. Default --require is python,typescript.
Toolchain locations: SWIFT_BIN (swift executable), DART_BIN, NODE_BIN, GRADLE_BIN, JAVA_HOME (JDK 21).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

CAP = Path(__file__).resolve().parents[1]
HERE = Path(__file__).resolve().parent


def run(cmd, cwd=None, env=None, stdout_only=False):
    r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
    return r.returncode, (r.stdout if stdout_only else r.stdout + r.stderr).strip()


def python_runner():
    uv = shutil.which("uv")
    if not uv:
        return "unavailable", "uv missing"
    code, out = run(
        [
            uv,
            "run",
            "--no-project",
            "--with",
            "jsonschema==4.25.1",
            "--with",
            "mcap==1.6.0",
            "--with",
            "protobuf==6.33.0",
            "python",
            str(CAP / "verify.py"),
        ],
        stdout_only=True,
    )
    if code != 0:
        return "failed", out[-2000:]
    report = json.loads(out)
    return "passed", {
        "golden_cases": len(report["golden_cases"]),
        "v12_golden_cases": len(report["v12"]["golden_cases"]),
        "encoder_buffer_cases": report["encoder_buffer_cases"],
    }


def ts_runner():
    node = os.environ.get("NODE_BIN") or shutil.which("node")
    if not node:
        return "unavailable", "node missing"
    code, out = run([node, str(HERE / "ts/capture_conformance.mjs")])
    return ("passed" if code == 0 else "failed"), out[-2000:]


def dart_runner():
    dart = os.environ.get("DART_BIN") or shutil.which("dart")
    if not dart:
        return "unavailable", "dart missing"
    code, out = run(
        [dart, "run", "capture_conformance.dart", str(CAP)], cwd=HERE / "dart"
    )
    return ("passed" if code == 0 else "failed"), out[-2000:]


def kotlin_runner():
    # Prefer an explicit/installed Gradle; otherwise the repository's pinned Gradle wrapper
    # (apps/mobile/android/gradlew), which is already provisioned on the mobile CI runners.
    wrapper = CAP.parents[2] / "apps/mobile/android/gradlew"
    gradle = os.environ.get("GRADLE_BIN") or shutil.which("gradle")
    gradle = gradle or (str(wrapper) if wrapper.exists() else None)
    java_home = os.environ.get("JAVA_HOME")
    if not gradle or not java_home or "21" not in java_home:
        return (
            "unavailable",
            "gradle (or the Gradle wrapper) and a JDK 21 JAVA_HOME are required",
        )
    code, out = run(
        [gradle, "--console=plain", "--no-daemon", "test", "--rerun-tasks"],
        cwd=HERE / "kotlin",
    )
    if code != 0:
        return "failed", out[-2000:]
    return "passed", [line.strip() for line in out.splitlines() if "kotlin-" in line]


def swift_runner():
    swift = os.environ.get("SWIFT_BIN") or shutil.which("swift")
    if not swift:
        return (
            "unavailable",
            "swift missing (set SWIFT_BIN); Linux Foundation runner only, no Apple-platform evidence",
        )
    scratch = os.environ.get("SWIFT_SCRATCH", "/tmp/capture-conformance-swift")
    code, out = run([swift, "build", "--scratch-path", scratch], cwd=HERE / "swift")
    if code:
        return "failed", out[-2000:]
    code, out = run([f"{scratch}/debug/CaptureConformance", str(CAP)])
    return ("passed" if code == 0 else "failed"), out[-2000:]


RUNNERS = {
    "python": python_runner,
    "typescript": ts_runner,
    "dart": dart_runner,
    "kotlin": kotlin_runner,
    "swift": swift_runner,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--require", default="python,typescript")
    ap.add_argument("--only", default=",".join(RUNNERS))
    args = ap.parse_args()
    required = set(filter(None, args.require.split(",")))
    receipt, bad = {}, False
    for name in args.only.split(","):
        status, detail = RUNNERS[name]()
        receipt[name] = {"status": status, "detail": detail}
        if status == "failed" or (status == "unavailable" and name in required):
            bad = True
    print(json.dumps(receipt, indent=1))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
