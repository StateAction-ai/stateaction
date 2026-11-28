#!/usr/bin/env python3
"""Discover a same-user display and prove a running emulator is accelerated.

Nothing here reads or prints X authority cookies: an authority file is only
passed by path to ``xdpyinfo`` to test whether it works. The commands are used
by ``scripts/start_capture_emulator.sh``.

* ``display``  prints ``export DISPLAY=...``/``XAUTHORITY=...`` lines.
* ``verify``   inspects the qemu process and the guest renderer and writes an
  evidence JSON. The accelerated profile fails on a missing /dev/kvm descriptor,
  a non-``-gpu host`` command line or any software renderer; the software
  profile is labeled as such and can never pass as accelerated.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import stat
import subprocess
import sys
import time
from collections.abc import Callable, Mapping
from pathlib import Path

SOFTWARE_RENDERER = re.compile(
    r"swiftshader|llvmpipe|lavapipe|softpipe|software|angle \(.*(subzero|swiftshader)",
    re.IGNORECASE,
)
ACCELERATED = "accelerated-kvm-host-gpu"
SOFTWARE = "software-rendering-not-accelerated"


class VerificationError(RuntimeError):
    pass


def is_software_renderer(renderer: str) -> bool:
    return bool(SOFTWARE_RENDERER.search(renderer))


def guest_renderer(surfaceflinger: str) -> str | None:
    """Return the ``GLES:`` line of ``dumpsys SurfaceFlinger`` without the prefix."""
    for line in surfaceflinger.splitlines():
        if line.startswith("GLES:"):
            return line[len("GLES:") :].strip()
    return None


def flag_value(args: list[str], flag: str) -> str | None:
    for index, value in enumerate(args[:-1]):
        if value == flag:
            return args[index + 1]
    return None


def find_qemu(port: int, avd: str, proc: Path = Path("/proc")) -> int | None:
    """Locate the qemu process (not the launcher wrapper) of one dedicated AVD."""
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / "cmdline").read_bytes().decode().split("\0")
        except OSError:
            continue
        if not args or "qemu-system" not in os.path.basename(args[0]):
            continue
        if flag_value(args, "-port") == str(port) and flag_value(args, "-avd") == avd:
            return int(entry.name)
    return None


def cmdline_of(pid: int, proc: Path = Path("/proc")) -> list[str]:
    return (proc / str(pid) / "cmdline").read_bytes().decode().split("\0")[:-1]


def has_kvm_fd(pid: int, proc: Path = Path("/proc")) -> bool:
    fd_dir = proc / str(pid) / "fd"
    for fd in fd_dir.iterdir():
        try:
            if os.readlink(fd) == "/dev/kvm":
                return True
        except OSError:
            continue
    return False


def boot_mode(args: list[str]) -> str:
    """Report what the running emulator was actually started with, not what was requested."""
    return (
        "cold"
        if "-no-snapshot" in args or "-no-snapshot-load" in args
        else "snapshot-capable"
    )


def check_profile(
    profile: str, args: list[str], kvm: bool, renderer: str | None, expect_gpu: str
) -> list[str]:
    """Return failure reasons; empty means the running emulator matches the profile."""
    problems: list[str] = []
    gpu = flag_value(args, "-gpu")
    if renderer is None:
        problems.append(
            "guest renderer unavailable (dumpsys SurfaceFlinger has no GLES line)"
        )
    if profile == ACCELERATED:
        if not kvm:
            problems.append("qemu has no open /dev/kvm descriptor (KVM is not in use)")
        if flag_value(args, "-accel") != "on":
            problems.append("emulator was not started with -accel on")
        if gpu != "host":
            problems.append(f"emulator was started with -gpu {gpu}, not -gpu host")
        if renderer is not None:
            if is_software_renderer(renderer):
                problems.append(f"guest renderer is software: {renderer}")
            elif expect_gpu and expect_gpu.lower() not in renderer.lower():
                problems.append(
                    f"guest renderer does not name {expect_gpu}: {renderer}"
                )
    elif profile == SOFTWARE:
        if renderer is not None and not is_software_renderer(renderer):
            problems.append(
                f"software profile selected but guest renderer is {renderer}"
            )
    else:
        problems.append(f"unknown profile {profile}")
    return problems


def adb(serial: str, *args: str) -> str:
    return subprocess.run(
        ["adb", "-s", serial, *args],
        capture_output=True,
        text=True,
        timeout=60,
        check=True,
    ).stdout.replace("\r", "")


def verify(
    serial: str,
    avd: str,
    port: int,
    profile: str,
    expect_gpu: str,
    requested_quick_boot: bool,
    out: Path,
    display: str | None,
    expected_camera_back: str | None = None,
) -> dict[str, object]:
    pid = find_qemu(port, avd)
    if pid is None:
        raise VerificationError(f"no qemu process for -avd {avd} -port {port}")
    args = cmdline_of(pid)
    kvm = has_kvm_fd(pid)
    renderer = guest_renderer(adb(serial, "shell", "dumpsys", "SurfaceFlinger"))
    abi = adb(serial, "shell", "getprop", "ro.product.cpu.abi").strip()
    problems = check_profile(profile, args, kvm, renderer, expect_gpu)
    camera_back = flag_value(args, "-camera-back")
    if expected_camera_back is not None and camera_back != expected_camera_back:
        problems.append("running emulator has a different back camera source")
    if abi != "x86_64":
        problems.append(f"guest ABI is {abi}, not x86_64")
    evidence: dict[str, object] = {
        "profile": profile,
        "accelerated": profile == ACCELERATED and not problems,
        "ok": not problems,
        "problems": problems,
        "serial": serial,
        "avd": avd,
        "qemu_pid": pid,
        "qemu_binary": args[0],
        "kvm_fd_open": kvm,
        "accel_flag": flag_value(args, "-accel"),
        "gpu_flag": flag_value(args, "-gpu"),
        "camera_back": camera_back.split(":", 1)[0] if camera_back else None,
        "requested_quick_boot": requested_quick_boot,
        "observed_snapshot_flags": [a for a in args if "snapshot" in a],
        "boot_mode": boot_mode(args),
        "guest_renderer": renderer,
        "guest_abi": abi,
        "display": display,
        "note": (
            "GPU applies to rendering only; the Android video encoder in the guest remains"
            " software and this is emulator evidence, never physical-device qualification."
        ),
        "verified_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(evidence, indent=2) + "\n")
    if problems:
        raise VerificationError("; ".join(problems))
    return evidence


Probe = Callable[[str, str | None], bool]


def xdpyinfo_probe(display: str, authority: str | None) -> bool:
    env = {k: v for k, v in os.environ.items() if k != "XAUTHORITY"}
    if authority:
        env["XAUTHORITY"] = authority
    try:
        result = subprocess.run(
            ["xdpyinfo", "-display", display],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0 and "GLX" in result.stdout


def owned_private(path: Path, uid: int) -> bool:
    try:
        info = path.stat()
    except OSError:
        return False
    return (
        stat.S_ISREG(info.st_mode)
        and info.st_uid == uid
        and not info.st_mode & (stat.S_IRWXG | stat.S_IRWXO)
    )


def discover_display(
    env: Mapping[str, str],
    uid: int,
    probe: Probe = xdpyinfo_probe,
    x11_dir: Path = Path("/tmp/.X11-unix"),
    runtime_dir: Path | None = None,
) -> dict[str, str | None]:
    """Honor the caller's display; otherwise find a working SAME-USER one.

    Only sockets and ``.mutter-Xwaylandauth.*`` files owned by this uid with no
    group/other access are candidates. Cookies are never read; ``xdpyinfo`` is
    the only consumer. Raises ``VerificationError`` when nothing works.
    """
    runtime = runtime_dir or Path(env.get("XDG_RUNTIME_DIR") or f"/run/user/{uid}")
    if env.get("DISPLAY"):
        display, authority = env["DISPLAY"], env.get("XAUTHORITY")
        if probe(display, authority):
            return {
                "DISPLAY": display,
                "XAUTHORITY": authority,
                "source": "caller-environment",
            }
        raise VerificationError(
            f"caller DISPLAY={display} is not usable with the supplied XAUTHORITY;"
            " fix the environment or unset DISPLAY to allow same-user discovery"
        )
    sockets = []
    if x11_dir.is_dir():
        for entry in sorted(x11_dir.iterdir()):
            match = re.fullmatch(r"X(\d+)", entry.name)
            try:
                same_user = entry.stat().st_uid == uid
            except OSError:
                continue
            if match and same_user:
                sockets.append(f":{match.group(1)}")
    authorities: list[str | None] = [None]
    if runtime.is_dir():
        authorities += [
            str(p)
            for p in sorted(runtime.glob(".mutter-Xwaylandauth.*"))
            if owned_private(p, uid)
        ]
    for display in sockets:
        for authority in authorities:
            if probe(display, authority):
                source = "same-user-discovery" if authority else "same-user-open-socket"
                return {"DISPLAY": display, "XAUTHORITY": authority, "source": source}
    raise VerificationError(
        "no usable same-user X display for host GPU emulation. Run from the desktop"
        " session or export DISPLAY and XAUTHORITY; never use xhost +. Use --software"
        " only for explicitly labeled non-accelerated evidence."
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("display")
    check = sub.add_parser("verify")
    check.add_argument("--serial", required=True)
    check.add_argument("--avd", required=True)
    check.add_argument("--port", type=int, required=True)
    check.add_argument(
        "--profile", choices=[ACCELERATED, SOFTWARE], default=ACCELERATED
    )
    check.add_argument("--camera-back")
    check.add_argument("--expect-gpu", default="NVIDIA")
    check.add_argument("--requested-quick-boot", action="store_true")
    check.add_argument("--out", type=Path, required=True)
    pid = sub.add_parser("find-pid")
    pid.add_argument("--avd", required=True)
    pid.add_argument("--port", type=int, required=True)
    options = parser.parse_args(argv)
    try:
        if options.command == "display":
            found = discover_display(os.environ, os.getuid())
            # Every value is shell-quoted; with no authority, a stale inherited one is unset
            # so the emulator sees exactly what the probe saw.
            print(f"export DISPLAY={shlex.quote(str(found['DISPLAY']))}")
            if found["XAUTHORITY"]:
                print(f"export XAUTHORITY={shlex.quote(str(found['XAUTHORITY']))}")
            else:
                print("unset XAUTHORITY")
            print(f"echo {shlex.quote('display source: ' + str(found['source']))} >&2")
        elif options.command == "find-pid":
            found_pid = find_qemu(options.port, options.avd)
            if found_pid is None:
                return 1
            print(found_pid)
        else:
            evidence = verify(
                options.serial,
                options.avd,
                options.port,
                options.profile,
                options.expect_gpu,
                options.requested_quick_boot,
                options.out,
                os.environ.get("DISPLAY"),
                options.camera_back,
            )
            print(json.dumps(evidence, indent=2))
    except (VerificationError, subprocess.SubprocessError, OSError) as error:
        print(f"emulator verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
