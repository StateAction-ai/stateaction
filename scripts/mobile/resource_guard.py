#!/usr/bin/env python3
"""Machine-wide admission and cgroup limits for local agent workloads.

No unsafe fallback: missing systemd/cgroup enforcement refuses the command.
The installed emulator shims also cover old worktrees and generated probes.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import signal
import stat
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

GIB = 1024**3
MIB = 1024**2
# Memory policy. Host usage (MemTotal - MemAvailable) must stay <= 80% of
# MemTotal, so the host reserve is ceil(MemTotal / 5) and the aggregate hard
# cap for our slice is dynamic:
#   cap = min(AGG_MAX, ceiling - other)  where  ceiling = MemTotal - reserve,
#   other = max(0, (MemTotal - MemAvailable) - H)  and H is our slice's
#   anonymous memory (memory.stat anon only; page cache is excluded
#   because MemAvailable already treats reclaimable cache as free).
# Equivalently cap = min(AGG_MAX, H + (MemAvailable - reserve)). H is anon only:
# slab can be reclaimable and shmem overlaps other accounting, so adding either
# back would overestimate our share and understate other apps (non-conservative).
# A cap is never set below the slice's actual memory.current (+ margin).
AGG_MAX = 24 * GIB  # absolute upper bound for the aggregate kernel cap
BOOT_CAP = 12 * GIB  # unit-file default before the first dynamic readback
TOTAL_MAX = BOOT_CAP  # legacy alias
JOB_MAX = 6 * GIB  # emulator and heavy job, unchanged
SERVICE_MAX = 1 * GIB
ADMISSION_MARGIN = 8 * GIB  # JOB_MAX + 2 GiB above the host reserve
SHRINK_MARGIN = 1 * GIB  # never set a cap closer than this to memory.current
STOP_MARGIN = 1 * GIB  # watchdog stops this far above the 20% reserve
WATCHDOG_POLICY = 2  # watchdog generation that implements this policy
WATCHDOG_FRESH = 15.0  # seconds a watchdog heartbeat stays trustworthy
SHRINK_HYSTERESIS = 1 * GIB  # watchdog tightens only for a larger gap
# Reference values on a 60 GiB host (exactly 20% reserve); the live values use
# the real MemTotal through host_reserve()/admission_min().
RESERVE_MIN = 12 * GIB
ADMISSION_MIN = RESERVE_MIN + ADMISSION_MARGIN
SLICE = "agent-work.slice"
BUILD = "agent-mobile-build.scope"
EMULATOR = "agent-android-emulator.scope"
HOME_DIR = Path.home()
INSTALL = HOME_DIR / ".local/share/agent-resource-guard"
CGROUP_ROOT = Path("/sys/fs/cgroup")


class Refused(RuntimeError):
    pass


def user_environment() -> dict[str, str]:
    env = os.environ.copy()
    runtime = Path(f"/run/user/{os.getuid()}")
    bus = runtime / "bus"
    if (
        runtime.stat().st_uid != os.getuid()
        or bus.stat().st_uid != os.getuid()
        or not stat.S_ISSOCK(bus.stat().st_mode)
    ):
        raise Refused("Owned systemd user bus unavailable; no unbounded fallback")
    env.update(
        XDG_RUNTIME_DIR=str(runtime), DBUS_SESSION_BUS_ADDRESS=f"unix:path={bus}"
    )
    return env


def call(*args: str, check: bool = True) -> str:
    result = subprocess.run(
        args, env=user_environment(), capture_output=True, text=True, timeout=20
    )
    if check and result.returncode:
        raise Refused(f"{args[0]} refused enforcement: {result.stderr.strip()}")
    return result.stdout.strip()


MEMINFO = Path("/proc/meminfo")


def meminfo_field(name: str, meminfo: Path = MEMINFO) -> int:
    for line in meminfo.read_text().splitlines():
        if line.startswith(name + ":"):
            return int(line.split()[1]) * 1024
    raise Refused(f"Cannot establish {name}")


def memory_available(meminfo: Path = MEMINFO) -> int:
    try:
        return meminfo_field("MemAvailable", meminfo)
    except (ValueError, IndexError) as error:
        raise Refused("Cannot establish available RAM") from error


def memory_total(meminfo: Path = MEMINFO) -> int:
    try:
        return meminfo_field("MemTotal", meminfo)
    except (ValueError, IndexError) as error:
        raise Refused("Cannot establish total RAM") from error


def host_reserve(total: int) -> int:
    """20% of MemTotal, rounded up: the share that must stay available."""
    return -(-total // 5)


def host_ceiling(total: int) -> int:
    """80% of MemTotal: the most host memory that may be in use."""
    return total - host_reserve(total)


def admission_min(total: int) -> int:
    return host_reserve(total) + ADMISSION_MARGIN


def admit(available: int | None = None, total: int | None = None) -> None:
    available = memory_available() if available is None else available
    total = memory_total() if total is None else total
    needed = admission_min(total)
    if available < needed:
        raise Refused(
            f"Only {available / GIB:.1f} GiB available; require "
            f"{needed / GIB:.1f} GiB (20% host reserve + {ADMISSION_MARGIN // GIB} GiB) "
            "before heavy work"
        )


def round_down_mib(value: int) -> int:
    return value // MIB * MIB


def round_up_mib(value: int) -> int:
    return -(-value // MIB) * MIB


def agent_hard_charge(stat: dict[str, int]) -> int:
    """Our slice's anonymous memory only; cache, slab and shmem are excluded
    so the add-back is never overestimated."""
    try:
        return stat["anon"]
    except KeyError as error:
        raise Refused(
            f"memory.stat lacks {error}; cannot account our memory"
        ) from error


def stop_threshold(total: int) -> int:
    """Watchdog stops our work below this: the reserve plus a reaction margin."""
    return host_reserve(total) + STOP_MARGIN


def read_memory_stat(group: Path) -> dict[str, int]:
    stat = {}
    for line in (group / "memory.stat").read_text().splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].isdigit():
            stat[parts[0]] = int(parts[1])
    return stat


def cap_high(cap: int) -> int:
    return round_down_mib(cap * 5 // 6)


def plan_cap(
    total: int,
    available: int,
    hard: int,
    current: int | None = None,
    aggregate_max: int = AGG_MAX,
    charge: int | None = None,
) -> dict[str, int | bool]:
    """Pure policy: the aggregate cap allowed now.

    `hard` is our anon memory (the add-back term); `charge` is the slice's
    actual memory.current (defaults to `hard`). A cap below charge plus
    SHRINK_MARGIN could OOM-kill admitted work (dirty/unreclaimable cache), so an
    existing cap is preserved and `deferred` is set; the caller must then refuse
    new admissions.
    """
    charge = hard if charge is None else max(charge, hard)
    reserve = host_reserve(total)
    ceiling = total - reserve
    other = max(0, (total - available) - hard)
    headroom = ceiling - other
    desired = round_down_mib(max(0, min(aggregate_max, headroom)))
    cap, deferred = desired, False
    if current is not None and desired < current and desired < charge + SHRINK_MARGIN:
        cap, deferred = current, True
    elif cap < JOB_MAX:
        raise Refused(
            f"Only {headroom / GIB:.1f} GiB of the 80% host ceiling remains for agents; "
            f"need at least {JOB_MAX // GIB} GiB"
        )
    return {
        "cap": cap,
        "high": cap_high(cap),
        "desired": desired,
        "deferred": deferred,
        "reserve": reserve,
        "ceiling": ceiling,
        "other": other,
        "hard": hard,
        "charge": charge,
        "headroom": headroom,
        "available": available,
        "total": total,
    }


def tighten_target(
    total: int, available: int, hard: int, current: int, charge: int | None = None
) -> int | None:
    """Watchdog shrink-only target when external apps consume the headroom."""
    other = max(0, (total - available) - hard)
    desired = min(AGG_MAX, host_ceiling(total) - other)
    charge = hard if charge is None else max(charge, hard)
    target = round_up_mib(max(desired, charge + SHRINK_MARGIN, JOB_MAX))
    return target if target <= current - SHRINK_HYSTERESIS else None


def runtime_dir() -> Path:
    user_environment()
    directory = Path(f"/run/user/{os.getuid()}/agent-resource-guard")
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077:
        raise Refused("Resource lock directory must be private and owned by this user")
    return directory


@contextmanager
def singleton(name: str, directory: Path | None = None):
    directory = directory or runtime_dir()
    fd = os.open(
        directory / f"{name}.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
    )
    try:
        if os.fstat(fd).st_uid != os.getuid():
            raise Refused("Resource lock has another owner")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Refused(
                f"Another {name} already owns the machine-wide slot"
            ) from error
        yield
    finally:
        os.close(fd)


def android_processes(proc: Path = Path("/proc")) -> list[int]:
    found = []
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if entry.stat().st_uid != os.getuid():
                continue
            args = (entry / "cmdline").read_bytes().decode().split("\0")
            binary = Path(args[0]).name
            if (
                binary.startswith("qemu-system")
                and ("-avd" in args or "/emulator/" in args[0])
            ) or (binary == "emulator.agent-vendor" and "-avd" in args):
                found.append(int(entry.name))
        except (OSError, UnicodeError, IndexError):
            continue
    return found


def properties(unit: str) -> dict[str, str]:
    text = call(
        "systemctl",
        "--user",
        "show",
        unit,
        "--property=ControlGroup,MemoryMax,MemorySwapMax,ActiveState",
    )
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


@contextmanager
def cap_lock(directory: Path | None = None, timeout: float = 10.0):
    """Short exclusive section so concurrent admissions cannot race cap changes."""
    directory = directory or runtime_dir()
    fd = os.open(directory / "cap.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError as error:
                if time.monotonic() >= deadline:
                    raise Refused("Aggregate cap update is busy") from error
                time.sleep(0.05)
        yield
    finally:
        os.close(fd)


def read_cap_text(group: Path, name: str) -> int | None:
    text = (group / name).read_text().strip()
    return None if text == "max" else int(text)


def apply_cap(group: Path, plan: dict[str, int | bool]) -> None:
    """Live-update the slice limits (no stop/restart of the slice or its scopes)
    and verify the kernel files; any mismatch fails closed."""
    cap, high = int(plan["cap"]), int(plan["high"])
    call(
        "systemctl",
        "--user",
        "set-property",
        "--runtime",
        SLICE,
        f"MemoryMax={cap}",
        f"MemoryHigh={high}",
        "MemorySwapMax=0",
    )
    props = properties(SLICE)
    if (
        props.get("MemoryMax") != str(cap)
        or props.get("MemorySwapMax") != "0"
        or read_cap_text(group, "memory.max") != cap
        or read_cap_text(group, "memory.high") != high
        or (group / "memory.swap.max").read_text().strip() != "0"
    ):
        raise Refused("Aggregate kernel memory/swap limits are not enforced")
    record = {
        "capBytes": cap,
        "highBytes": high,
        "aggregateMaxBytes": AGG_MAX,
        "memTotalBytes": plan["total"],
        "reserveBytes": plan["reserve"],
        "ceilingBytes": plan["ceiling"],
        "availableBytes": plan["available"],
        "hardChargeBytes": plan["hard"],
        "memoryCurrentBytes": plan.get("charge", plan["hard"]),
        "otherBytes": plan["other"],
        "headroomBytes": plan["headroom"],
        "time": time.time(),
    }
    target = runtime_dir() / "aggregate-cap.json"
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(record, indent=2) + "\n")
    os.replace(temporary, target)


def enforce_slice() -> dict[str, int | bool]:
    call("systemctl", "--user", "start", SLICE)
    props = properties(SLICE)
    group = CGROUP_ROOT / props.get("ControlGroup", "").lstrip("/")
    if (
        not props.get("ControlGroup")
        or props.get("MemorySwapMax") != "0"
        or (group / "memory.swap.max").read_text().strip() != "0"
        or not os.access(group / "cgroup.kill", os.W_OK)
    ):
        raise Refused("Aggregate kernel memory/swap limits are not enforced")
    with cap_lock():
        current = read_cap_text(group, "memory.max")
        # Until the new watchdog heartbeats, the old (weaker) 12 GiB reserve is
        # the only stop, so the aggregate stays at the boot cap.
        limit = AGG_MAX if new_watchdog_active() else BOOT_CAP
        plan = plan_cap(
            memory_total(),
            memory_available(),
            agent_hard_charge(read_memory_stat(group)),
            current,
            limit,
            read_cap_text(group, "memory.current"),
        )
        if plan["deferred"]:
            raise Refused(
                f"External memory use left {plan['headroom'] / GIB:.1f} GiB of the 80% "
                f"ceiling; our charges are {plan['hard'] / GIB:.1f} GiB. Keeping the "
                "current cap and refusing new admission"
            )
        if current != plan["cap"]:
            apply_cap(group, plan)
        elif (
            props.get("MemoryMax") != str(current)
            or not (runtime_dir() / "aggregate-cap.json").exists()
        ):
            apply_cap(group, plan)
    (runtime_dir() / "cgroup-path").write_text(str(group))
    call("systemctl", "--user", "start", "agent-resource-watch.service")
    if (
        call("systemctl", "--user", "is-active", "agent-resource-watch.service")
        != "active"
    ):
        raise Refused("Memory reserve watchdog is not active")
    return plan


def write_heartbeat() -> None:
    target = runtime_dir() / "watchdog.json"
    temporary = target.with_suffix(".tmp")
    temporary.write_text(
        json.dumps({"policy": WATCHDOG_POLICY, "pid": os.getpid(), "time": time.time()})
    )
    os.replace(temporary, target)


def new_watchdog_active() -> bool:
    """True only while a watchdog implementing this policy heartbeats. An older
    watchdog (fixed 12 GiB reserve) never writes this file."""
    try:
        beat = json.loads((runtime_dir() / "watchdog.json").read_text())
        return (
            beat["policy"] == WATCHDOG_POLICY
            and 0 <= time.time() - float(beat["time"]) <= WATCHDOG_FRESH
        )
    except (OSError, ValueError, KeyError, TypeError):
        return False


def read_record() -> dict | None:
    try:
        return json.loads((runtime_dir() / "aggregate-cap.json").read_text())
    except (OSError, ValueError):
        return None


def policy() -> dict:
    """Machine-readable proof that the live kernel cap matches the allowed policy."""
    total = memory_total()
    props = properties(SLICE)
    problems = []
    kernel_max = kernel_swap = None
    if props.get("ActiveState") != "active" or not props.get("ControlGroup"):
        problems.append("agent-work.slice is not active")
    else:
        group = CGROUP_ROOT / props["ControlGroup"].lstrip("/")
        try:
            kernel_max = read_cap_text(group, "memory.max")
            kernel_swap = (group / "memory.swap.max").read_text().strip()
        except (OSError, ValueError):
            problems.append("cannot read kernel limits")
    record = read_record()
    expected = record.get("capBytes") if record else BOOT_CAP
    if kernel_swap != "0":
        problems.append("swap is not zero")
    if kernel_max is None:
        problems.append("aggregate memory.max is unlimited or unreadable")
    else:
        if not JOB_MAX <= kernel_max <= AGG_MAX:
            problems.append("aggregate cap outside 6 GiB..24 GiB")
        if kernel_max > host_ceiling(total):
            problems.append("aggregate cap exceeds the 80% host ceiling")
        if kernel_max != expected:
            problems.append("kernel cap differs from the recorded/boot cap")
        if kernel_max > BOOT_CAP and not new_watchdog_active():
            problems.append("cap above boot cap without a current-policy watchdog")
    return {
        "ok": not problems,
        "problems": problems,
        "kernelMemoryMaxBytes": kernel_max,
        "kernelSwapMax": kernel_swap,
        "recordedCapBytes": record.get("capBytes") if record else None,
        "bootCapBytes": BOOT_CAP,
        "watchdogPolicyActive": new_watchdog_active(),
        "stopThresholdBytes": stop_threshold(total),
        "aggregateMaxBytes": AGG_MAX,
        "jobMaxBytes": JOB_MAX,
        "serviceMaxBytes": SERVICE_MAX,
        "memTotalBytes": total,
        "reserveBytes": host_reserve(total),
        "ceilingBytes": host_ceiling(total),
        "record": record,
    }


def tighten_cap() -> None:
    """Shrink-only reaction to external memory growth; never below our charges."""
    group = work_group()
    if group is None:
        return
    try:
        with cap_lock(timeout=2):
            current = read_cap_text(group, "memory.max")
            if current is None:
                return
            total, available = memory_total(), memory_available()
            hard = agent_hard_charge(read_memory_stat(group))
            charge = read_cap_text(group, "memory.current") or hard
            target = tighten_target(total, available, hard, current, charge)
            if target is not None:
                other = max(0, (total - available) - hard)
                apply_cap(
                    group,
                    {
                        "cap": target,
                        "high": cap_high(target),
                        "total": total,
                        "reserve": host_reserve(total),
                        "ceiling": host_ceiling(total),
                        "available": available,
                        "hard": hard,
                        "other": other,
                        "headroom": host_ceiling(total) - other,
                    },
                )
    except OSError:
        return  # slice stopped/stopping; the reserve stop is separate
    except (ValueError, Refused) as error:
        print(f"Cap tighten skipped: {error}", flush=True)


def guarded_pid(pid: str = "self") -> bool:
    try:
        path = Path(f"/proc/{pid}/cgroup").read_text().strip().split("::", 1)[1]
        if f"/{SLICE}/" not in path:
            return False
        group = Path("/sys/fs/cgroup") / path.lstrip("/")
        return (
            int((group / "memory.max").read_text()) <= JOB_MAX
            and (group / "memory.swap.max").read_text().strip() == "0"
            and int((group.parent / "memory.max").read_text()) <= AGG_MAX
            and (group.parent / "memory.swap.max").read_text().strip() == "0"
        )
    except (OSError, ValueError, IndexError):
        return False


def inside_guard() -> bool:
    return guarded_pid() and Path("/proc/self/cgroup").read_text().strip().endswith(
        "/" + BUILD
    )


def check_emulator() -> list[int]:
    pids = android_processes()
    if len(pids) > 1:
        raise Refused(
            f"Multiple Android emulator processes exist: {pids}; do not launch another"
        )
    if any(not guarded_pid(str(pid)) for pid in pids):
        raise Refused(
            "Existing emulator is outside the enforced memory budget; do not reuse it unbounded"
        )
    return pids


def wait_emulator_gone(timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not android_processes():
            try:
                with singleton("emulator"):
                    return
            except Refused:
                pass
        time.sleep(0.1)
    raise Refused("Previous emulator has not released its process and singleton slot")


def shadow_user_config() -> Path:
    # Flutter's jdk-dir uses $XDG_CONFIG_HOME/settings. Keep that one private
    # while preserving the user's other applications' config by reference.
    private = INSTALL / "flutter-config"
    private.mkdir(parents=True, exist_ok=True)
    source = Path(os.environ.get("XDG_CONFIG_HOME", str(HOME_DIR / ".config")))
    if source.resolve() != private.resolve() and source.is_dir():
        for entry in source.iterdir():
            if entry.name == "settings":
                continue
            target = private / entry.name
            if not target.exists() and not target.is_symlink():
                try:
                    target.symlink_to(
                        entry.resolve(), target_is_directory=entry.is_dir()
                    )
                except FileExistsError:
                    pass
    return private


def bounded_environment() -> dict[str, str]:
    env = user_environment()
    config = json.loads((INSTALL / "config.json").read_text())
    jdk = config["jdk"]
    env.update(
        JAVA_HOME=jdk,
        GRADLE_USER_HOME=str(INSTALL / "gradle"),
        XDG_CONFIG_HOME=str(shadow_user_config()),
        CMAKE_BUILD_PARALLEL_LEVEL="2",
        MAKEFLAGS="-j2",
        NODE_OPTIONS=env.get("NODE_OPTIONS", "") + " --max-old-space-size=2048",
    )
    env["PATH"] = jdk + "/bin:" + env.get("PATH", "")
    return env


def emulator_shim(vendor: Path) -> str:
    target = INSTALL / "resource_guard.py"
    return (
        "#!/usr/bin/env python3\nimport os,sys\n"
        f"os.execv(sys.executable,[sys.executable,{str(target)!r},'emulator','--',{str(vendor)!r},*sys.argv[1:]])\n"
    )


def verify_binary(binary: Path) -> None:
    binary = binary.resolve()
    vendor = binary.with_name("emulator.agent-vendor")
    config = json.loads((INSTALL / "config.json").read_text())
    expected = emulator_shim(vendor).encode()
    with binary.open("rb") as file:
        observed = file.read(len(expected) + 1)
    if str(vendor) not in config["vendors"] or observed != expected:
        raise Refused(
            "SDK emulator guard is missing/overwritten; reinstall it before launching"
        )


def run_scope(
    unit: str, command: list[str], *, emulator: bool, service: bool = False
) -> int:
    if not command:
        raise Refused("A command is required")
    slot = unit if service else "emulator" if emulator else "heavy-job"
    with singleton(slot):
        if emulator and android_processes():
            raise Refused(
                "An Android emulator already exists; reuse it, regardless of AVD/port"
            )
        admit()
        for vendor in json.loads((INSTALL / "config.json").read_text())["vendors"]:
            verify_binary(Path(vendor).with_name("emulator"))
        enforce_slice()
        argv = [
            "systemd-run",
            "--user",
            "--scope",
            "--quiet",
            f"--slice={SLICE}",
            f"--unit={unit.removesuffix('.scope')}",
            "--property=MemoryAccounting=yes",
            "--property=MemoryHigh=768M" if service else "--property=MemoryHigh=5G",
            "--property=MemoryMax=1G" if service else "--property=MemoryMax=6G",
            "--property=MemorySwapMax=0",
            "--property=TasksMax=256",
            "--",
            *command,
        ]
        owner = runtime_dir() / f"{unit}.owner"
        owner.write_text(
            json.dumps({"pid": os.getpid(), "identity": process_identity(os.getpid())})
        )
        try:
            return subprocess.run(argv, env=bounded_environment()).returncode
        finally:
            # Reap descendants even if a generated project unexpectedly creates a daemon.
            call("systemctl", "--user", "stop", unit, check=False)
            call("systemctl", "--user", "reset-failed", unit, check=False)
            owner.unlink(missing_ok=True)


def emulator_command(command: list[str]) -> int:
    config = json.loads((INSTALL / "config.json").read_text())
    if not command or str(Path(command[0]).resolve()) not in config["vendors"]:
        raise Refused("Emulator vendor path is not installed/approved")
    launch = "-avd" in command or any(x.startswith("@") for x in command[1:])
    if not launch:
        # Read-only vendor discovery does not start a VM.
        if len(command) < 2 or not any(
            x
            in {
                "-version",
                "-list-avds",
                "-accel-check",
                "-help",
                "-help-all",
                "-gpu-list",
            }
            or x.startswith("-help-")
            for x in command[1:]
        ):
            raise Refused("Unknown emulator command; refusing an unguarded launch")
        return subprocess.run(command, env=user_environment()).returncode
    return run_scope(EMULATOR, command, emulator=True)


def process_identity(pid: int) -> str | None:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return None if fields[0] in {"Z", "X"} else fields[19]
    except (OSError, IndexError):
        return None


def work_group() -> Path | None:
    cached = runtime_dir() / "cgroup-path"
    if cached.exists():
        group = Path(cached.read_text())
        prefix = f"/sys/fs/cgroup/user.slice/user-{os.getuid()}.slice/user@{os.getuid()}.service/"
        if str(group).startswith(prefix) and group.name == SLICE:
            return group
    return None


def reap_orphans() -> None:
    group = work_group()
    if group is None:
        return
    services = [p.name for p in group.glob("agent-service-*.scope")]
    for unit in (BUILD, EMULATOR, *services):
        kill = group / unit / "cgroup.kill"
        if not kill.exists():
            continue
        owner = runtime_dir() / f"{unit}.owner"
        try:
            record = json.loads(owner.read_text())
            alive = (
                record["identity"] is not None
                and process_identity(record["pid"]) == record["identity"]
            )
        except (OSError, ValueError, KeyError, TypeError):
            alive = False
        if not alive:
            kill.write_text("1")
            call("systemctl", "--user", "stop", unit, check=False)
            owner.unlink(missing_ok=True)


def stop_for_pressure(available: int, total: int | None = None) -> bool:
    total = memory_total() if total is None else total
    if available < stop_threshold(total):
        # Free our memory immediately even if the user bus is under pressure.
        # This path was obtained from the manager and kernel-verified at admission.
        group = work_group()
        if group is not None and (group / "cgroup.kill").exists():
            (group / "cgroup.kill").write_text("1")
        call("systemctl", "--user", "stop", SLICE, check=False)
        return True
    return False


def watch() -> None:
    reported = False
    while True:
        try:
            reap_orphans()
            available = memory_available()
            total = memory_total()
            write_heartbeat()
            if available < stop_threshold(total):
                if not reported:
                    print(
                        f"Stopping agent workloads: available RAM {available / GIB:.1f} GiB "
                        f"< stop threshold {stop_threshold(total) / GIB:.1f} GiB (20% reserve + margin)",
                        flush=True,
                    )
                reported = True
                stop_for_pressure(available, total)
            else:
                reported = False
                tighten_cap()
        except (OSError, Refused, subprocess.SubprocessError) as error:
            # Losing the monitor must stop its workloads, not leave them unguarded.
            print(f"Resource monitor failed: {error}", flush=True)
            call("systemctl", "--user", "stop", SLICE, check=False)
            raise
        time.sleep(1)


def install(jdk: Path, emulators: list[Path], projects: list[Path]) -> None:
    user_environment()
    if (
        android_processes()
        or call("systemctl", "--user", "is-active", BUILD, check=False) == "active"
    ):
        raise Refused("Stop guarded emulator/build work before updating the guard")
    if not (jdk / "bin/java").is_file():
        raise Refused("Pinned JDK is missing")
    version = subprocess.check_output(
        [str(jdk / "bin/java"), "-Xmx64m", "-version"],
        stderr=subprocess.STDOUT,
        text=True,
    )
    if 'version "21.' not in version:
        raise Refused("JDK 21 is required")
    INSTALL.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = INSTALL / "resource_guard.py"
    if Path(__file__).resolve() != target:
        shutil.copyfile(__file__, target)
    config_path = INSTALL / "config.json"
    prior = json.loads(config_path.read_text()) if config_path.exists() else {}
    vendors = set(prior.get("vendors", []))
    for path in emulators:
        path = path.resolve()
        vendor = path.with_name("emulator.agent-vendor")
        if vendor.exists():
            expected = emulator_shim(vendor).encode()
            with path.open("rb") as binary:
                observed = binary.read(len(expected) + 1)
            if observed != expected:
                raise Refused(
                    f"SDK entrypoint changed at {path}; preserve and review the new SDK before reinstalling"
                )
        if not vendor.exists():
            with path.open("rb") as binary:
                magic = binary.read(4)
            if path.stat().st_uid != os.getuid() or magic != b"\x7fELF":
                raise Refused(f"Expected an untouched ELF emulator at {path}")
            path.rename(vendor)
        vendors.add(str(vendor))
        path.write_text(emulator_shim(vendor))
        path.chmod(0o755)
    roots = sorted(
        set(prior.get("projects", [])) | {str(p.resolve()) for p in projects}
    )
    config_path.write_text(
        json.dumps(
            {"jdk": str(jdk.resolve()), "vendors": sorted(vendors), "projects": roots},
            indent=2,
        )
        + "\n"
    )
    gradle = INSTALL / "gradle"
    gradle.mkdir(exist_ok=True)
    for cache in ("caches", "wrapper"):
        dest = gradle / cache
        source = HOME_DIR / ".gradle" / cache
        if source.exists() and not dest.exists():
            dest.symlink_to(source, target_is_directory=True)
    (gradle / "gradle.properties").write_text(
        "org.gradle.jvmargs=-Xmx2g -XX:MaxMetaspaceSize=512m -XX:ReservedCodeCacheSize=256m\n"
        "org.gradle.daemon=false\norg.gradle.workers.max=2\norg.gradle.parallel=false\n"
        "org.gradle.caching=false\norg.gradle.configuration-cache=false\n"
        "kotlin.compiler.execution.strategy=in-process\nkotlin.daemon.enabled=false\n"
    )
    flutter = INSTALL / "flutter-config"
    flutter.mkdir(parents=True, exist_ok=True)
    (flutter / "settings").write_text(
        json.dumps({"jdk-dir": str(jdk.resolve())}) + "\n"
    )
    guard_init = (
        "// Agent-owned resource gate; only applies to the configured project roots.\n"
        "gradle.settingsEvaluated { settings ->\n"
        f"  def roots = {json.dumps(roots)}\n"
        "  def project = settings.settingsDir.canonicalPath\n"
        "  if (roots.any { project == it || project.startsWith(it + '/') }) {\n"
        "    def cg = new File('/proc/self/cgroup').text\n"
        "    if (!cg.contains('/agent-work.slice/')) throw new GradleException('Use agent-resource run -- <command>; unbounded local Gradle is prohibited')\n"
        "    if (Runtime.version().feature() != 21 || Runtime.runtime.maxMemory() > 2147483648L) throw new GradleException('Require JDK21 and Gradle heap <=2GiB')\n"
        "    if (gradle.startParameter.maxWorkerCount > 2 || gradle.startParameter.parallelProjectExecutionEnabled) throw new GradleException('Require <=2 Gradle workers and no parallel projects')\n"
        "    def strategy = settings.providers.gradleProperty('kotlin.compiler.execution.strategy').getOrElse('in-process')\n"
        "    if (strategy != 'in-process') throw new GradleException('Persistent Kotlin compiler daemons are prohibited')\n"
        "  }\n}\n"
    )
    for base in (HOME_DIR / ".gradle", gradle):
        init = base / "init.d"
        init.mkdir(parents=True, exist_ok=True)
        (init / "agent-resource-guard.gradle").write_text(guard_init)
    units = HOME_DIR / ".config/systemd/user"
    units.mkdir(parents=True, exist_ok=True)
    (units / SLICE).write_text(
        "[Unit]\nDescription=Shared bounded agent work\n"
        "BindsTo=agent-resource-watch.service\nAfter=agent-resource-watch.service\n[Slice]\n"
        "MemoryAccounting=yes\nMemoryHigh=10G\nMemoryMax=12G\nMemorySwapMax=0\nTasksMax=512\n"
    )
    (units / "agent-resource-watch.service").write_text(
        "[Unit]\nDescription=Stop agent workloads before host memory reserve is exhausted\n"
        "[Service]\nType=simple\n"
        f"ExecStart=/usr/bin/python3 {target} watch\n"
        "MemoryMax=64M\nMemorySwapMax=0\nRestart=on-failure\nRestartSec=2\n"
    )
    binary = HOME_DIR / ".local/bin/agent-resource"
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_text(f"#!/bin/sh\nexec /usr/bin/python3 '{target}' \"$@\"\n")
    binary.chmod(0o755)
    call("systemctl", "--user", "daemon-reload")
    call("systemctl", "--user", "restart", "agent-resource-watch.service")
    plan = enforce_slice()
    print(
        json.dumps(
            {
                "installed": True,
                "aggregateGiB": round(int(plan["cap"]) / GIB, 2),
                "aggregateMaxGiB": AGG_MAX // GIB,
                "aggregateBootGiB": BOOT_CAP // GIB,
                "perJobGiB": 6,
                "swapMax": 0,
                "emulatorSlots": 1,
                "heavyJobSlots": 1,
            }
        )
    )


def main() -> int:
    def terminate(signum, _frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, terminate)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=[
            "install",
            "run",
            "serve",
            "emulator",
            "watch",
            "status",
            "stop",
            "check-emulator",
            "wait-emulator-gone",
            "verify-binary",
            "policy",
            "retune",
        ],
    )
    parser.add_argument(
        "--name", choices=["web", "worker", "postgres", "storage", "emulator-control"]
    )
    parser.add_argument("--jdk", type=Path)
    parser.add_argument("--binary", type=Path)
    parser.add_argument("--wrap-emulator", type=Path, action="append", default=[])
    parser.add_argument("--project-root", type=Path, action="append", default=[])
    args, command = parser.parse_known_args()
    if command[:1] == ["--"]:
        command = command[1:]
    try:
        if args.action == "install":
            if args.jdk is None:
                raise Refused("--jdk is required")
            install(args.jdk, args.wrap_emulator, args.project_root)
        elif args.action == "run":
            if not command:
                raise Refused("A command is required")
            if inside_guard():
                os.execvpe(command[0], command, os.environ)
            return run_scope(BUILD, command, emulator=False)
        elif args.action == "emulator":
            return emulator_command(command)
        elif args.action == "serve":
            if not args.name:
                raise Refused(
                    "--name web, worker, postgres, storage or emulator-control is required"
                )
            if args.name == "emulator-control" and inside_guard():
                raise Refused(
                    "Start the emulator-control supervisor outside transient work scopes; it enters its own bounded service"
                )
            return run_scope(
                f"agent-service-{args.name}.scope",
                command,
                emulator=False,
                service=True,
            )
        elif args.action == "watch":
            watch()
        elif args.action == "stop":
            call("systemctl", "--user", "stop", SLICE)
        elif args.action == "check-emulator":
            print(json.dumps({"androidPids": check_emulator(), "maximum": 1}))
        elif args.action == "wait-emulator-gone":
            wait_emulator_gone()
        elif args.action == "policy":
            report = policy()
            print(json.dumps(report, indent=2))
            return 0 if report["ok"] else 1
        elif args.action == "retune":
            # Live cap update only; no scope or fixture is stopped.
            plan = enforce_slice()
            print(json.dumps(policy(), indent=2))
            return 0 if plan else 1
        elif args.action == "verify-binary":
            if args.binary is None:
                raise Refused("--binary is required")
            verify_binary(args.binary)
        else:
            print(
                json.dumps(
                    {
                        "availableGiB": round(memory_available() / GIB, 1),
                        "androidPids": android_processes(),
                        "slice": properties(SLICE),
                        "watchdog": call(
                            "systemctl",
                            "--user",
                            "is-active",
                            "agent-resource-watch.service",
                            check=False,
                        ),
                    },
                    indent=2,
                )
            )
    except (OSError, Refused, subprocess.SubprocessError) as error:
        print(f"RESOURCE GUARD REFUSED: {error}", file=sys.stderr)
        return 75
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
