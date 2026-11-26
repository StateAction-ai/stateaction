"""Launch the recipe compiler in a fresh Linux sandbox."""

import errno
import json
import os
import select
import stat
import subprocess
import sys
import tempfile
from contextlib import ExitStack
from pathlib import Path
from time import monotonic

HERE = Path(__file__).resolve().parent
BWRAP = Path("/usr/bin/bwrap")
PRLIMIT = "/usr/bin/prlimit"
PYTHON_VERSION = (3, 12, 13)
RUNTIME = Path("/runtime")
HOST_LIB = Path("/usr/lib/x86_64-linux-gnu")
LIBRARIES = (
    "ld-linux-x86-64.so.2",
    "libc.so.6",
    "libdl.so.2",
    "libm.so.6",
    "libpthread.so.0",
    "librt.so.1",
    "libutil.so.1",
)
SOURCE_LIMIT = 64 * 1024
OUTPUT_LIMIT = 1024 * 1024
STARTUP_SECONDS = 30
WALL_SECONDS = 8
READY = b"ready\n"


class CompileError(Exception):
    def __init__(self, code, fix="Check the sandbox setup and recipe source.", line=1):
        super().__init__(f"{code}: {fix}")
        self.code = code
        self.fix = fix
        self.line = line


def sandbox_command(source_fd, bindings_fd, bwrap, policy_probe):
    if sys.implementation.name != "cpython" or sys.version_info[:3] != PYTHON_VERSION:
        raise CompileError("sandbox_unavailable: requires CPython 3.12.13")
    stdlib = Path(sys.base_prefix) / "lib/python3.12"
    python = Path(sys.executable).resolve()
    if not all(path.exists() for path in (bwrap, Path(PRLIMIT), stdlib, python)):
        raise CompileError("sandbox_unavailable")
    command = [
        PRLIMIT,
        "--cpu=5:5",
        "--as=536870912:536870912",
        "--nofile=64:64",
        f"--fsize={OUTPUT_LIMIT}:{OUTPUT_LIMIT}",
        "--core=0:0",
        "--",
        str(bwrap),
        "--unshare-all",
        "--unshare-user",
        "--unshare-cgroup",
        "--disable-userns",
        "--assert-userns-disabled",
        "--cap-drop",
        "ALL",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--setenv",
        "PYTHONHASHSEED",
        "0",
        "--setenv",
        "LC_ALL",
        "C.UTF-8",
        "--size",
        "16777216",
        "--tmpfs",
        "/tmp",
        "--chdir",
        "/tmp",
        "--ro-bind",
        str(python),
        str(RUNTIME / "bin/python3.12"),
        "--ro-bind",
        str(stdlib),
        str(RUNTIME / "lib/python3.12"),
        "--tmpfs",
        str(RUNTIME / "lib/python3.12/site-packages"),
        "--remount-ro",
        str(RUNTIME / "lib/python3.12/site-packages"),
        "--ro-bind",
        str(HERE / "worker.py"),
        "/compiler/worker.py",
        "--ro-bind",
        str(HERE / "stateaction_recipes/__init__.py"),
        "/compiler/stateaction_recipes/__init__.py",
        "--ro-bind-data",
        str(bindings_fd),
        "/compiler/stateaction_recipes/modules.py",
        "--ro-bind-data",
        str(source_fd),
        "/recipes/recipe.py",
    ]
    if policy_probe:
        command += ["--ro-bind", str(HERE / "probe.py"), "/compiler/probe.py"]
    for name in LIBRARIES:
        command += ["--ro-bind", str(HOST_LIB / name), f"/lib/x86_64-linux-gnu/{name}"]
    command += [
        "--symlink",
        "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2",
        "/lib64/ld-linux-x86-64.so.2",
        "--remount-ro",
        "/",
        "--",
        str(RUNTIME / "bin/python3.12"),
        "-P",
        "-s",
        "-S",
        "-B",
        "/compiler/worker.py",
    ]
    return command + (["--probe"] if policy_probe else [])


def read_before(fd, deadline, size, timeout_code):
    remaining = deadline - monotonic()
    if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
        raise CompileError(timeout_code, "Keep the build short and check host load.")
    return os.read(fd, size)


def run_sandbox(source, bindings, *, bwrap=BWRAP, policy_probe=False):
    with (
        tempfile.TemporaryFile() as recipe,
        tempfile.TemporaryFile() as bindings_file,
        tempfile.TemporaryFile() as errors,
    ):
        recipe.write(source)
        recipe.seek(0)
        bindings_file.write(bindings)
        bindings_file.seek(0)
        fds = (recipe.fileno(), bindings_file.fileno())
        command = sandbox_command(*fds, bwrap, policy_probe)
        try:
            with subprocess.Popen(
                command,
                pass_fds=fds,
                env={},
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=errors,
            ) as process:
                try:
                    fd = process.stdout.fileno()
                    startup = monotonic() + STARTUP_SECONDS
                    if (
                        read_before(fd, startup, len(READY), "sandbox_startup_limit")
                        != READY
                    ):
                        raise CompileError("sandbox_unavailable")
                    deadline = monotonic() + WALL_SECONDS
                    output = bytearray()
                    while chunk := read_before(
                        fd, deadline, 65536, "sandbox_wall_limit"
                    ):
                        output.extend(chunk)
                        if len(output) > OUTPUT_LIMIT:
                            raise CompileError(
                                "sandbox_output_limit",
                                "Keep the emitted graph at or below 1 MiB.",
                            )
                    code = process.wait(timeout=max(0, deadline - monotonic()))
                except BaseException:
                    process.kill()
                    process.wait()
                    raise
        except subprocess.TimeoutExpired as exc:
            raise CompileError(
                "sandbox_wall_limit", "Keep the build function short and synchronous."
            ) from exc
        except OSError as exc:
            raise CompileError("sandbox_unavailable") from exc
        if code == 0:
            return bytes(output)
        if code == 20:
            errors.seek(max(0, errors.seek(0, os.SEEK_END) - 2048))
            lines = errors.read().splitlines()
            try:
                diagnostic = json.loads(lines[-1])
                code, fix, line = (diagnostic[key] for key in ("code", "fix", "line"))
                if type(code) is str and type(fix) is str and type(line) is int:
                    raise CompileError(code, fix, line)
            except (ValueError, KeyError, IndexError, TypeError):
                pass
            raise CompileError("invalid_recipe", "Export a decorated build function.")
        if code < 0 or code >= 128:
            raise CompileError(f"sandbox_process_exit:{code}")
        raise CompileError("sandbox_unavailable")


def canonical_json(value):
    def order(item):
        if type(item) is dict:
            return {
                key: order(item[key])
                for key in sorted(item, key=lambda key: key.encode("utf-16-be"))
            }
        if type(item) is list:
            return [order(element) for element in item]
        if item is None or type(item) in (bool, str):
            return item
        if type(item) is int and -(2**53 - 1) <= item <= 2**53 - 1:
            return item
        raise ValueError("unsupported canonical JSON value")

    return json.dumps(
        order(value),
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def read_source(path: Path, root: Path):
    def invalid():
        return CompileError(
            "invalid_source_path",
            "Use a regular recipe file inside the checkout without symlinks.",
        )

    if not path.is_relative_to(root):
        raise invalid()
    parts = path.relative_to(root).parts
    if not parts or ".." in parts:
        raise invalid()
    directories = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        with ExitStack() as stack:
            fd = os.open(root, directories)
            stack.callback(os.close, fd)
            for component in parts[:-1]:
                fd = os.open(component, directories, dir_fd=fd)
                stack.callback(os.close, fd)
            source_fd = os.open(
                parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=fd
            )
            with os.fdopen(source_fd, "rb") as source:
                if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                    raise invalid()
                return source.read(SOURCE_LIMIT + 1)
    except OSError as exc:
        if exc.errno in (errno.ELOOP, errno.ENOTDIR):
            raise invalid() from exc
        raise
