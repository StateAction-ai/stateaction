"""Trusted probes for the OS boundary and the Python hooks."""

import importlib
import json
import os
import resource
import socket
import subprocess
import sys
from pathlib import Path


def run(policy_type, denied_error):
    isolation = {
        "environment": dict(os.environ),
        "python_flags": [
            sys.flags.safe_path,
            sys.flags.no_user_site,
            sys.flags.no_site,
            sys.flags.dont_write_bytecode,
        ],
        "hash": hash("e6"),
        "cpu": resource.getrlimit(resource.RLIMIT_CPU),
        "address_space": resource.getrlimit(resource.RLIMIT_AS),
        "descriptors": resource.getrlimit(resource.RLIMIT_NOFILE),
        "file_size": resource.getrlimit(resource.RLIMIT_FSIZE),
        "network_interfaces": [name for _, name in socket.if_nameindex()],
        "root": sorted(os.listdir("/")),
        "before_hooks": {},
        "after_hooks": {},
    }
    inherited = []
    for fd in range(3, resource.getrlimit(resource.RLIMIT_NOFILE)[0]):
        try:
            os.fstat(fd)
        except OSError:
            continue
        inherited.append(fd)
    isolation["inherited_descriptors"] = inherited
    before_hooks = isolation["before_hooks"]
    with open("/recipes/recipe.py") as source:
        host_canary = source.read()
    for name, path, mode in (
        ("create_at_root", "/e6-write-check", "x"),
        ("write_recipe", "/recipes/recipe.py", "r+"),
        ("read_host_canary", host_canary, "r"),
    ):
        try:
            with open(path, mode):
                before_hooks[name] = "unexpected_success"
        except OSError as exc:
            before_hooks[name] = exc.errno
    with open("/tmp/e6-write-check", "x"):
        pass

    policy = policy_type()
    sys.meta_path.insert(0, policy)
    sys.addaudithook(policy.audit)
    for name, probe in (
        ("open", lambda: Path("/tmp/e6-write-check").read_bytes()),
        ("socket", socket.socket),
        ("subprocess", lambda: subprocess.run(["/no-such-e6-command"], check=True)),
        ("os_system", lambda: os.system("/no-such-e6-command")),
        ("cached_import", lambda: policy.import_module("socket")),
        ("finder", lambda: importlib.import_module("e6_missing_probe")),
    ):
        try:
            probe()
        except denied_error as exc:
            isolation["after_hooks"][name] = str(exc)
        else:
            raise AssertionError(f"probe was allowed: {name}")

    print(json.dumps(isolation))
    return 0
