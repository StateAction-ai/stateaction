#!/usr/bin/env python3
"""Bounded live Linux proof. No VM starts; OOM test is limited to 64 MiB."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import resource_guard as guard

ROOT = Path(__file__).resolve().parents[2]
RUNNER = Path.home() / ".local/bin/agent-resource"


def run(*args: str, timeout: int = 120):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def wait_file(path: Path):
    deadline = time.monotonic() + 15
    while not path.exists():
        if time.monotonic() > deadline:
            raise RuntimeError("Bounded proof did not reach its checkpoint")
        time.sleep(0.1)


def sentinel(path: Path):
    return subprocess.Popen(
        [
            str(RUNNER),
            "run",
            "--",
            sys.executable,
            "-c",
            "from pathlib import Path;import sys,time;Path(sys.argv[1]).touch();time.sleep(30)",
            str(path),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    guard.enforce_slice()
    evidence = {"availableBeforeGiB": round(guard.memory_available() / guard.GIB, 2)}
    with tempfile.TemporaryDirectory() as tmp:
        temp = Path(tmp)
        first = sentinel(temp / "ready")
        try:
            wait_file(temp / "ready")
            second = run(str(RUNNER), "run", "--", "/bin/true")
            assert second.returncode == 75 and "heavy-job" in second.stderr
            evidence["secondHeavyJobRefused"] = True
            # Real reserve-stop path, controlled input; no host-memory exhaustion.
            assert guard.stop_for_pressure(guard.RESERVE_MIN - 1)
            assert first.wait(timeout=15) != 0
            evidence["simulatedPressureStoppedActualScope"] = True
        finally:
            guard.call("systemctl", "--user", "stop", guard.SLICE, check=False)
            first.wait(timeout=15)
        guard.enforce_slice()
        installed = json.loads((guard.INSTALL / "config.json").read_text())
        vendor = Path(installed["vendors"][0])
        sdk_entry = vendor.with_name("emulator")
        before = guard.android_processes()
        with guard.singleton("emulator"):
            # A concurrent launch reservation must reject the real SDK entrypoint
            # before it can execute the vendor binary or start any VM.
            duplicate = run(
                str(sdk_entry), "-avd", "guard-denial-proof", "-port", "5580"
            )
            assert duplicate.returncode == 75 and "emulator" in duplicate.stderr
        assert before == guard.android_processes() == []
        evidence["sdkConcurrentLaunchRefusedBeforeVMStart"] = True
        proof = temp / "memory-proof.py"
        proof.write_text(
            "from pathlib import Path\nimport subprocess,json,os\n"
            "p=Path('/proc/self/cgroup').read_text().strip().split('::',1)[1]\n"
            "c=Path('/sys/fs/cgroup')/p.lstrip('/')\n"
            "def oom():return int(dict(x.split() for x in (c.parent/'memory.events').read_text().splitlines())['oom_kill'])\n"
            "before=oom()\n"
            "r=subprocess.run(['systemd-run','--user','--scope','--quiet','--slice=agent-work.slice','--unit=agent-memory-limit-proof','--property=MemoryMax=64M','--property=MemorySwapMax=0','--',"
            "'/usr/bin/python3','-c','x=bytearray(128*1024*1024)'],capture_output=True)\n"
            "assert r.returncode!=0 and oom()>before\n"
            "print(json.dumps({'kernelOOMContainedAtMiB':64,'jobMax':(c/'memory.max').read_text().strip(),'aggregateMax':(c.parent/'memory.max').read_text().strip(),'swapMax':(c/'memory.swap.max').read_text().strip()}))\n"
            "subprocess.run(['systemctl','--user','reset-failed','agent-memory-limit-proof.scope'],capture_output=True)\n"
        )
        memory = run(str(RUNNER), "run", "--", sys.executable, str(proof))
        assert memory.returncode == 0, memory.stderr
        evidence["kernelEnforcement"] = json.loads(memory.stdout.strip())
        orphan_ready = temp / "orphan-ready"
        orphan = sentinel(orphan_ready)
        try:
            wait_file(orphan_ready)
            started = time.monotonic()
            os.kill(orphan.pid, signal.SIGKILL)
            orphan.wait(timeout=5)
            deadline = time.monotonic() + 10
            while (
                guard.call("systemctl", "--user", "is-active", guard.BUILD, check=False)
                == "active"
            ):
                if time.monotonic() > deadline:
                    raise RuntimeError("Orphan scope was not reaped")
                time.sleep(0.1)
            evidence["killedControllerScopeReapedSeconds"] = round(
                time.monotonic() - started, 2
            )
        finally:
            guard.call("systemctl", "--user", "stop", guard.BUILD, check=False)

    project = ROOT / "artifacts/resource-guard/gradle-defaults"
    project.mkdir(parents=True, exist_ok=True)
    (project / "settings.gradle").write_text("rootProject.name='guard-default-proof'\n")
    (project / "gradle.properties").write_text(
        "org.gradle.jvmargs=-Xmx8g\norg.gradle.workers.max=8\norg.gradle.parallel=true\n"
        "kotlin.compiler.execution.strategy=daemon\n"
    )
    (project / "build.gradle").write_text(
        "tasks.register('verifyBudget') { doLast {\n"
        "assert Runtime.version().feature()==21\n"
        "assert Runtime.runtime.maxMemory()<=2147483648L\n"
        "assert gradle.startParameter.maxWorkerCount<=2\n"
        "assert !gradle.startParameter.parallelProjectExecutionEnabled\n"
        "assert providers.gradleProperty('kotlin.compiler.execution.strategy').get()=='in-process'\n"
        "println 'GUARD_JVM_PROOF='+groovy.json.JsonOutput.toJson([java:Runtime.version().feature(),heapMax:Runtime.runtime.maxMemory(),workers:gradle.startParameter.maxWorkerCount,strategy:providers.gradleProperty('kotlin.compiler.execution.strategy').get()])\n"
        "} }\n"
    )
    gradle = run(
        str(RUNNER),
        "run",
        "--",
        str(ROOT / "apps/mobile/android/gradlew"),
        "-p",
        str(project),
        "verifyBudget",
        "--no-daemon",
        "--console=plain",
    )
    assert gradle.returncode == 0, gradle.stdout[-2000:] + gradle.stderr[-2000:]
    line = next(
        x for x in gradle.stdout.splitlines() if x.startswith("GUARD_JVM_PROOF=")
    )
    evidence["generated8GiBDefaultsOverridden"] = json.loads(line.split("=", 1)[1])
    evidence["androidPidsAfter"] = guard.android_processes()
    evidence["availableAfterGiB"] = round(guard.memory_available() / guard.GIB, 2)
    evidence["note"] = (
        "No VM launched. Reserve pressure was simulated; actual child allocation was capped at 64 MiB."
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
