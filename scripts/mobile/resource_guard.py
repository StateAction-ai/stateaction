#!/usr/bin/env python3
"""Machine-wide admission and cgroup limits for local agent workloads.

No unsafe fallback: missing systemd/cgroup enforcement refuses the command.
The installed emulator shims also cover old worktrees and generated probes.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import resource
import secrets
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
# SA-124 lanes (agentqueue). A lane job runs in its own scope per lane and project; the Free
# class (every `run` without --lane in a registered root) takes no slot and never waits.
FREE_SLICE = "agent-work-free.slice"  # child of agent-work.slice by systemd's dash rule
FREE_JOB_MAX = 6 * GIB  # per-command default, the old per-job cap; `--mem` lowers it
FREE_OOM_ADJUST = 500  # Free processes are the kernel OOM killer's first victims
FREE_LOW = 4 * GIB  # MemoryLow of the Free slice, reserved out of the lane budget
EMULATOR_SHARE = 6 * GIB  # the warm emulator scope is outside the lane queue
FREE_DENY = ("gradle", "gradlew", "emulator", "emulator.agent-vendor")
LANES = ("ci", "android-build", "emulator")
MACHINE_LANES = ("emulator",)  # one state dir for all registered roots
LANE_SCOPE = re.compile(r"agent-lane-(ci|android-build|emulator)-[0-9a-f]{8}\.scope")
LANE_ENV_PASS = (
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_CONFIG_DIR",
    "GH_HOST",
    "SSH_AUTH_SOCK",
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TERM",
    "DISPLAY",
    "XAUTHORITY",
    "NVM_DIR",
    "NODE_OPTIONS",
    "PNPM_HOME",
    "PUB_CACHE",
    "FLUTTER_ROOT",
    "ANDROID_HOME",
    "ANDROID_SDK_ROOT",
    "ANDROID_AVD_HOME",
    "ANDROID_SERIAL",
    "CI",
    "GIT_CONFIG_GLOBAL",
)
LANE_ENV_PREFIXES = (
    "STATEACTION_",
    "AGENT_RESOURCE_",
    "UV_",
    "NX_",
    "CARGO_",
    "RUSTUP_",
    "GIT_",
)
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


def own_scope() -> str:
    return Path("/proc/self/cgroup").read_text().strip().rsplit("/", 1)[-1]


FREE_SCOPE = re.compile(r"agent-free-\d+-[0-9a-f]{6}\.scope")


def current_lane() -> str | None:
    """The lane this process is really in (kernel cgroup), never the environment."""
    name = own_scope()
    match = LANE_SCOPE.fullmatch(name)
    return match.group(1) if match and guarded_pid() else None


def inside_lane() -> bool:
    """A lane ticket (or the legacy heavy-job scope) is held by this process tree."""
    return guarded_pid() and (own_scope() == BUILD or current_lane() is not None)


def inside_guard() -> bool:
    """Inside any capped agent scope: a lane, the legacy heavy-job scope or a Free scope."""
    return inside_lane() or (guarded_pid() and bool(FREE_SCOPE.fullmatch(own_scope())))


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
    lanes = [p.name for p in group.glob("agent-lane-*.scope")]
    free = [
        f"{FREE_SLICE}/{p.name}"
        for p in (group / FREE_SLICE).glob("agent-free-*.scope")
    ]
    for unit in (BUILD, EMULATOR, *services, *lanes, *free):
        kill = group / unit / "cgroup.kill"
        if not kill.exists():
            continue
        unit = unit.rsplit("/", 1)[-1]
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
    repo = Path(__file__).resolve().parents[2]
    for name in ("lanes.toml", "pin.json"):
        source = repo / "config/agentqueue" / name
        if source.is_file() and source.resolve() != INSTALL / name:
            shutil.copyfile(source, INSTALL / name)
    queue_root = repo / "artifacts/platform-tools/agentqueue"
    if (queue_root / "INSTALLED.json").is_file():
        shutil.copytree(queue_root, INSTALL / "agentqueue", dirs_exist_ok=True)
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


# --------------------------------------------------------------------------- lanes (SA-124)
# `run --lane L` queues on the pinned `agentqueue` binary (FIFO tickets, one transient unit per
# job, a ticket outlives its submitter). `run` without --lane in a registered StateAction root is
# Free: no slot, no wait, its own capped scope in FREE_SLICE. A caller from any other root keeps
# the legacy behavior (`run` = heavy-job slot) and `run --lane` there executes untouched.


def test_hooks() -> bool:
    return os.environ.get("AGENT_RESOURCE_TEST") == "1"


def project_roots() -> list[Path]:
    """Registered StateAction roots. Any failure means "none": foreign callers keep the
    legacy behavior instead of crashing."""
    try:
        override = (
            os.environ.get("AGENT_RESOURCE_PROJECT_ROOTS") if test_hooks() else None
        )
        if override is not None:
            names = [x for x in override.split(os.pathsep) if x]
        else:
            names = json.loads((INSTALL / "config.json").read_text()).get(
                "projects", []
            )
        return [Path(n).resolve() for n in names if Path(n).is_dir()]
    except (OSError, ValueError, AttributeError, TypeError):
        return []


def registered_root(cwd: Path | None = None) -> Path | None:
    try:
        cwd = (cwd or Path.cwd()).resolve()
    except OSError:
        return None
    inside = [r for r in project_roots() if cwd == r or r in cwd.parents]
    return max(inside, key=lambda r: len(r.parts)) if inside else None


def project_key(root: Path, cwd: Path | None = None) -> str:
    """One ci/android-build lane per repository: the git common dir when there is one, so
    the two registered roots of one repo share a lane (shared fixtures and ports)."""
    identity = str(root)
    try:
        out = subprocess.run(
            [
                "git",
                "rev-parse",
                "--path-format=absolute",
                "--show-toplevel",
                "--git-common-dir",
            ],
            cwd=cwd or Path.cwd(),
            capture_output=True,
            text=True,
            timeout=10,
        )
        lines = out.stdout.split("\n")
        if out.returncode == 0 and len(lines) >= 2:
            top = Path(lines[0]).resolve()
            # only a checkout inside the registered root counts (never an enclosing repo)
            if top == root or root in top.parents:
                identity = str(Path(lines[1]).resolve())
    except (OSError, subprocess.SubprocessError):
        pass
    return hashlib.sha256(identity.encode()).hexdigest()[:8]


def resource_file(name: str, repo_path: str) -> Path:
    """Installed copy next to this script first, then the repository checkout."""
    here = Path(__file__).resolve().parent
    for candidate in (here / name, here.parents[1] / repo_path):
        if candidate.is_file():
            return candidate
    raise Refused(f"{name} is missing; reinstall the guard from the repository")


def agentqueue_binary() -> Path:
    """The pinned binary: rev from config/agentqueue/pin.json, sha256 from the INSTALLED.json
    written by scripts/install-agentqueue.sh (self-attested: it detects drift, not tampering by
    the same user). Never downloads or builds."""
    env = os.environ.get("AGENTQUEUE_BIN") if test_hooks() else None
    here = Path(__file__).resolve().parent
    candidates = (
        [Path(env)]
        if env
        else [
            INSTALL / "agentqueue/bin/agentqueue",
            here.parents[1] / "artifacts/platform-tools/agentqueue/bin/agentqueue",
        ]
    )
    for binary in candidates:
        if not binary.is_file() or not os.access(binary, os.X_OK):
            continue
        record = binary.parent.parent / "INSTALLED.json"
        if env and not record.exists():
            return binary  # test hook only
        try:
            installed = json.loads(record.read_text())
            pin = json.loads(
                resource_file("pin.json", "config/agentqueue/pin.json").read_text()
            )
            digest = hashlib.sha256(binary.read_bytes()).hexdigest()
        except (OSError, ValueError) as error:
            raise Refused(f"agentqueue install record unreadable: {error}") from error
        if installed.get("rev") != pin["rev"] or installed.get("sha256") != digest:
            raise Refused(
                "agentqueue binary does not match config/agentqueue/pin.json and its install "
                "record; run scripts/install-agentqueue.sh"
            )
        return binary
    raise Refused(
        "agentqueue is not installed; run scripts/install-agentqueue.sh (no network is used here)"
    )


def lane_budget(cap: int | None) -> int:
    """Machine-wide reservation of lane caps: the live aggregate cap minus the protected Free
    share and the warm emulator scope, clamped to [one job, three jobs]. PROVISIONAL."""
    cap = BOOT_CAP if cap is None else cap
    return max(JOB_MAX, min(3 * JOB_MAX, cap - FREE_LOW - EMULATOR_SHARE))


def aq_lane(lane: str, key: str) -> str:
    """The agentqueue lane name: ci and android-build per repository, emulator machine-wide."""
    return lane if lane in MACHINE_LANES else f"{lane}-{key}"


def lane_files(root: Path, lane: str, key: str | None = None) -> tuple[Path, Path, str]:
    """Machine-wide state dir (one memory reservation for all projects) and the effective
    manifest: the committed lanes.toml with this repository's lanes, the registered roots and
    the state dir prepended."""
    import tomllib  # noqa: PLC0415

    key = key or project_key(root)
    base = runtime_dir() / "agentqueue"
    base.mkdir(mode=0o700, exist_ok=True)
    template = tomllib.loads(
        resource_file("lanes.toml", "config/agentqueue/lanes.toml").read_text()
    )
    lines = [
        f"state_dir = {json.dumps(str(os.environ['AGENT_RESOURCE_STATE_DIR'] if test_hooks() and os.environ.get('AGENT_RESOURCE_STATE_DIR') else base / 'machine'))}",
        f"roots = {json.dumps([str(r) for r in project_roots()])}",
        f"memory_budget = {json.dumps(template.get('memory_budget', '12G'))}",
    ]
    for name in LANES:
        spec = template["lanes"][name]
        lines.append(f"\n[lanes.{aq_lane(name, key)}]")
        for field, value in spec.items():
            lines.append(f"{field} = {json.dumps(value)}")
    text = "\n".join(lines) + "\n"
    manifest = base / f"{key}.lanes.toml"
    if not manifest.exists() or manifest.read_text() != text:
        temporary = manifest.with_suffix(f".{os.getpid()}.tmp")
        temporary.write_text(text)
        os.replace(temporary, manifest)
    state = base / "machine"
    if test_hooks() and os.environ.get("AGENT_RESOURCE_STATE_DIR"):
        state = Path(os.environ["AGENT_RESOURCE_STATE_DIR"])  # e2e isolation only
    return state, manifest, key


def aggregate_cap() -> int | None:
    if test_hooks() and os.environ.get("AGENT_RESOURCE_TEST_CAP_GIB"):
        return (
            int(os.environ["AGENT_RESOURCE_TEST_CAP_GIB"]) * GIB
        )  # reservation arithmetic only
    group = work_group()
    try:
        return None if group is None else read_cap_text(group, "memory.max")
    except (OSError, ValueError):
        return None


def lane_environment() -> list[str]:
    names = [
        n for n in os.environ if n in LANE_ENV_PASS or n.startswith(LANE_ENV_PREFIXES)
    ]
    return [x for n in sorted(names) for x in ("--pass-env", n)]


LANE_LOG_ENV = "STATEACTION_LANE_LOG"
# Threads count as tasks. The gate pinned its 256-task scope for minutes in web-auth-e2e (measured
# 256 of 256, Chrome could not start threads); the shared slice allows 512.
LANE_TASKS = 512


def lane_log_path(key: str | None = None) -> Path:
    """Per-ticket output file (agentqueue's journal output is unreadable for this user). With a
    key the path is deterministic, so a resubmit that attaches to the existing job streams the
    same log from the start."""
    directory = runtime_dir() / "agentqueue" / "logs"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    for old in directory.glob("*.log"):  # logs of killed or cancelled submitters
        try:
            if time.time() - old.stat().st_mtime > 86400:
                old.unlink()
        except OSError:
            pass
    name = (
        f"k-{hashlib.sha256(key.encode()).hexdigest()[:16]}.log"
        if key
        else f"{os.getpid()}-{secrets.token_hex(4)}.log"
    )
    path = directory / name
    os.close(os.open(path, os.O_WRONLY | os.O_CREAT, 0o600))
    return path


def run_and_stream(
    argv: list[str], env: dict[str, str], log: Path, remove: bool = True
) -> int:
    """Run `agentqueue run` and copy the job log to stdout. Ctrl-C/SIGTERM only end this
    client: the ticket and its job keep going (detach, not cancel; use `agent-resource cancel`)."""
    child = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL)

    def forward(signum, _frame):
        child.send_signal(signum)

    for name in (signal.SIGINT, signal.SIGHUP, signal.SIGTERM):
        signal.signal(name, forward)
    position = 0

    def drain() -> None:
        nonlocal position
        try:
            with log.open("rb") as handle:
                handle.seek(position)
                data = handle.read()
                position += len(data)
        except FileNotFoundError:  # another client of the same keyed ticket removed it
            data = b""
        if data:
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()

    try:
        while child.poll() is None:
            drain()
            time.sleep(0.2)
        drain()
        code = child.returncode
        return 128 - code if code < 0 else code
    finally:
        if remove:  # a keyed log is shared by every client of the ticket; age cleanup removes it
            log.unlink(missing_ok=True)


def queue_arguments(root: Path) -> list[str]:
    binary = agentqueue_binary()
    state, manifest, _ = lane_files(root, "ci")
    return [str(binary), "--manifest", str(manifest), "--state-dir", str(state)]


def queue_command(action: str, rest: list[str]) -> int:
    """`agent-resource queue|cancel|find`: thin wrappers over agentqueue status/cancel/find."""
    root = registered_root()
    if root is None:
        raise Refused("queue commands work only inside a registered StateAction root")
    verb = {"queue": "status", "cancel": "cancel", "find": "find"}[action]
    return subprocess.run(
        [*queue_arguments(root), verb, *rest], env=user_environment()
    ).returncode


def lane_run(lane: str, command: list[str], options: argparse.Namespace) -> int:
    if lane not in LANES:
        raise Refused(f"Unknown lane {lane!r}; lanes: {', '.join(LANES)}")
    if not command:
        raise Refused("A command is required")
    held = (
        current_lane()
    )  # verified from the cgroup; STATEACTION_LANE_HELD is not trusted
    if held == lane or (held and lane == "android-build"):
        # Flatten: the held ticket already bounds this work; an android-build request inside
        # any lane runs under that one ticket instead of taking a second lane.
        os.execvpe(command[0], command, os.environ)
    if held:
        print(
            f"RESOURCE GUARD REFUSED: lane {lane} requested inside lane {held}; run the work "
            "under the one ticket (lanes never nest)",
            file=sys.stderr,
        )
        return 64
    root = registered_root()
    if root is None:  # another project: untouched and never queued
        os.execvpe(command[0], command, os.environ)
    binary = agentqueue_binary()
    key = project_key(root)
    state, manifest, key = lane_files(root, lane, key)
    log = lane_log_path(options.key)
    env = user_environment()
    env[LANE_LOG_ENV] = str(log)
    argv = [
        str(binary),
        "--manifest",
        str(manifest),
        "--state-dir",
        str(state),
        "--budget",
        str(lane_budget(aggregate_cap())),
        "run",
        "--lane",
        aq_lane(lane, key),
        # a finished ticket with the same key is replaced; an unfinished one is attached to
        *(["--key", options.key, "--retry"] if options.key else []),
        *(["--mem", options.mem] if options.mem else []),
        *(["--runtime", options.runtime] if options.runtime else []),
        *(["--timeout", options.timeout] if options.timeout else []),
        *lane_environment(),
        "--pass-env",
        LANE_LOG_ENV,
        "--",
        sys.executable,
        str(Path(__file__).resolve()),
        "lane-job",
        "--lane",
        lane,
        "--project-key",
        key,
        "--",
        *command,
    ]
    return run_and_stream(argv, env, log, remove=not options.key)


def slot_fds() -> list[int]:
    """Descriptors of agentqueue slot files (flock); passed on so the slot is held until the
    job's scope exits, not only while this wrapper lives."""
    found = []
    for entry in Path("/proc/self/fd").iterdir():
        try:
            target = os.readlink(entry)
        except OSError:
            continue
        if (
            "/lanes/" in target
            and "/slot-" in target
            and not target.endswith(".holder")
        ):
            found.append(int(entry.name))
    return found


def run_bounded(
    unit: str,
    command: list[str],
    *,
    slice_name: str,
    job_max: int,
    env: dict[str, str],
    tasks: int = 256,
    oom_adjust: int = 0,
) -> int:
    """One capped scope; the owner record lets the watchdog reap it if its parent dies."""
    argv = [
        "systemd-run",
        "--user",
        "--scope",
        "--quiet",
        f"--slice={slice_name}",
        f"--unit={unit.removesuffix('.scope')}",
        "--property=MemoryAccounting=yes",
        f"--property=MemoryMax={job_max}",
        "--property=MemorySwapMax=0",
        f"--property=TasksMax={tasks}",
        "--",
        *command,
    ]
    owner = runtime_dir() / f"{unit}.owner"
    owner.write_text(
        json.dumps({"pid": os.getpid(), "identity": process_identity(os.getpid())})
    )
    log = os.environ.get(LANE_LOG_ENV) if unit.startswith("agent-lane-") else None
    keep = slot_fds() if unit.startswith("agent-lane-") else []

    def prepare_child() -> None:
        # An agentqueue unit starts with systemd's 1024 soft nofile; Chrome, Next and Nx need the
        # hard limit that Free and plain shells already get (SA-124: web-auth-e2e failed on it).
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        if hard != resource.RLIM_INFINITY and soft < hard:
            resource.setrlimit(resource.RLIMIT_NOFILE, (hard, hard))
        if oom_adjust:  # raising oom_score_adj needs no privilege
            with open("/proc/self/oom_score_adj", "w") as handle:
                handle.write(str(oom_adjust))

    try:
        if log:
            with open(log, "ab") as sink:
                return subprocess.run(
                    argv,
                    env=env,
                    stdout=sink,
                    stderr=subprocess.STDOUT,
                    pass_fds=keep,
                    preexec_fn=prepare_child,
                ).returncode
        return subprocess.run(
            argv, env=env, pass_fds=keep, preexec_fn=prepare_child
        ).returncode
    finally:
        call("systemctl", "--user", "stop", unit, check=False)
        call("systemctl", "--user", "reset-failed", unit, check=False)
        owner.unlink(missing_ok=True)


def lane_job(lane: str, key: str, command: list[str]) -> int:
    """Runs inside the agentqueue unit once the ticket holds its slot."""
    if lane not in LANES or not re.fullmatch(r"[0-9a-f]{8}", key) or not command:
        raise Refused("lane-job is started by agentqueue only")
    try:
        admit()
        enforce_slice()
    except (
        Refused
    ) as error:  # the journal may be unreadable; the submitter streams this log
        log = os.environ.get(LANE_LOG_ENV)
        if log:
            with open(log, "a") as sink:
                sink.write(f"RESOURCE GUARD REFUSED (at job start): {error}\n")
        raise
    env = bounded_environment()
    env["STATEACTION_LANE_HELD"] = (
        lane  # informational; trust is the cgroup (current_lane)
    )
    return run_bounded(
        f"agent-lane-{lane}-{key}.scope",
        command,
        slice_name=SLICE,
        job_max=JOB_MAX,
        env=env,
        tasks=LANE_TASKS,
    )


def free_slice_max(cap: int | None = None) -> int:
    """What the lane budget leaves of the aggregate cap after the warm emulator, never below
    the protected Free share. PROVISIONAL (owner approval pending on SA-124)."""
    cap = aggregate_cap() if cap is None else cap
    cap = BOOT_CAP if cap is None else cap
    return max(FREE_LOW, cap - lane_budget(cap) - EMULATOR_SHARE)


def ensure_free_slice() -> None:
    props = properties(FREE_SLICE)
    limit = free_slice_max()
    if props.get("MemoryMax") != str(limit) or props.get("MemorySwapMax") != "0":
        call(
            "systemctl",
            "--user",
            "set-property",
            "--runtime",
            FREE_SLICE,
            f"MemoryMax={limit}",
            f"MemoryLow={FREE_LOW}",
            "MemorySwapMax=0",
            "TasksMax=2048",
        )


def free_run(command: list[str], mem: int = FREE_JOB_MAX) -> int:
    """Free class: no slot, no wait, no queue. Own capped scope in the Free slice. Host memory
    pressure is the watchdog's job, not a per-command refusal."""
    if os.path.basename(command[0]) in FREE_DENY:
        raise Refused(
            f"{os.path.basename(command[0])} is heavy: use `agent-resource run --lane "
            f"{'emulator' if 'emulator' in command[0] else 'android-build'} -- ...`"
        )
    if guarded_pid():
        os.execvpe(command[0], command, os.environ)  # already inside a capped scope
    enforce_slice()
    ensure_free_slice()
    unit = f"agent-free-{os.getpid()}-{secrets.token_hex(3)}.scope"
    return run_bounded(
        unit,
        command,
        slice_name=FREE_SLICE,
        job_max=min(mem, JOB_MAX),
        env=bounded_environment(),
        tasks=512,
        oom_adjust=FREE_OOM_ADJUST,
    )


def parse_mem(text: str | None) -> int:
    if not text:
        return FREE_JOB_MAX
    match = re.fullmatch(r"(\d+)([MG])", text.upper())
    if not match or int(match.group(1)) == 0:
        raise Refused("--mem takes a size like 512M or 4G")
    return int(match.group(1)) * (MIB if match.group(2) == "M" else GIB)


def run_command(command: list[str], options: argparse.Namespace) -> int:
    if not command:
        raise Refused("A command is required")
    if options.lane:
        return lane_run(options.lane, command, options)
    if registered_root() is None:
        # Not a StateAction root: legacy behavior, never reclassified.
        if inside_lane():
            os.execvpe(command[0], command, os.environ)
        return run_scope(BUILD, command, emulator=False)
    return free_run(command, parse_mem(options.mem))


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
            "lane-job",
            "queue",
            "cancel",
            "find",
        ],
    )
    parser.add_argument("--lane", choices=LANES)
    parser.add_argument("--project-key")
    parser.add_argument("--key")
    parser.add_argument("--runtime")
    parser.add_argument("--timeout")
    parser.add_argument("--mem")
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
            return run_command(command, args)
        elif args.action in ("queue", "cancel", "find"):
            extra = (["--key", args.key] if args.key else []) + command
            return queue_command(args.action, extra)
        elif args.action == "lane-job":
            if not args.lane or not args.project_key:
                raise Refused("lane-job needs --lane and --project-key")
            return lane_job(args.lane, args.project_key, command)
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
