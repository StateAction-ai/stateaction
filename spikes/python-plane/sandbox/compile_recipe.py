"""Compile an E6 recipe in a fresh Linux sandbox."""

import argparse
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

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
WALL_SECONDS = 8
WORKER_ERRORS = {
    b"import_not_allowed": "import_not_allowed",
    b"nondeterministic_api:open": "nondeterministic_api:open",
    b"nondeterministic_api:os.system": "nondeterministic_api:os.system",
    b"nondeterministic_api:socket.__new__": "nondeterministic_api:socket.__new__",
    b"nondeterministic_api:subprocess.Popen": "nondeterministic_api:subprocess.Popen",
    b"invalid_recipe": "invalid_recipe",
}


class CompileError(Exception):
    pass


def sandbox_command(source_fd, bwrap, policy_probe):
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
        str(HERE / "stateaction_recipes"),
        "/compiler/stateaction_recipes",
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


def run_sandbox(source, *, bwrap=BWRAP, policy_probe=False):
    with (
        tempfile.TemporaryFile() as recipe,
        tempfile.TemporaryFile() as output,
        tempfile.TemporaryFile() as errors,
    ):
        recipe.write(source)
        recipe.seek(0)
        command = sandbox_command(recipe.fileno(), bwrap, policy_probe)
        try:
            result = subprocess.run(
                command,
                pass_fds=(recipe.fileno(),),
                env={},
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=errors,
                timeout=WALL_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise CompileError("sandbox_wall_limit") from exc
        except OSError as exc:
            raise CompileError("sandbox_unavailable") from exc
        output.seek(0)
        errors.seek(0)
        if result.returncode == 0:
            return output.read(OUTPUT_LIMIT)
        if result.returncode == 20:
            reason = errors.read(128).strip()
            code = WORKER_ERRORS.get(reason)
            if code is None and reason.startswith(b"nondeterministic_api:"):
                code = "nondeterministic_api"
            raise CompileError(code or "invalid_recipe")
        if result.returncode < 0 or result.returncode >= 128:
            raise CompileError(f"sandbox_process_exit:{result.returncode}")
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


def compile_recipe(source):
    if len(source) > SOURCE_LIMIT:
        raise CompileError("invalid_recipe")
    results = []
    for _ in range(2):
        try:
            graph = json.loads(run_sandbox(source))
            if (
                type(graph) is not dict
                or graph.get("schema") != "stateaction.authoring-graph/e6"
            ):
                raise ValueError("unexpected graph schema")
            canonical = canonical_json(graph)
            results.append((canonical, hashlib.sha256(canonical).hexdigest()))
        except (ValueError, RecursionError) as exc:
            raise CompileError("invalid_recipe") from exc
    if results[0][1] != results[1][1]:
        raise CompileError("nondeterministic_recipe")
    return results[0]


def read_source(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise CompileError("invalid_recipe")
        return source.read(SOURCE_LIMIT + 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--digest", action="store_true")
    args = parser.parse_args()
    try:
        graph, digest = compile_recipe(read_source(args.source))
    except (CompileError, OSError) as exc:
        print(
            str(exc) if isinstance(exc, CompileError) else "invalid_recipe",
            file=sys.stderr,
        )
        return 1
    if args.digest:
        print(digest)
    else:
        sys.stdout.buffer.write(graph)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
