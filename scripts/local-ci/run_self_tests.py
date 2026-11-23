"""Run the local-ci unit suites as separate processes, a few at a time.

`python3 -m unittest discover` runs the 146 tests serially in one process (about 40 s,
dominated by tests that wait for real process-group reaping). This runner discovers the
same tests, runs each test class in its own process, and splits the classes that hold
more than SPLIT_OVER tests into one process per test (except WHOLE_CLASSES, whose tests each start the Nx CLI and must not overlap). It fails if the number of tests
that ran differs from the number discovered, so a shard that silently ran nothing cannot
pass. Every test still runs unmodified, once.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
import unittest
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPLIT_OVER = 12
# Each of these tests starts the Nx CLI (a Rust runtime with a large thread pool); running
# several at once can exceed the guarded scope's task cap ("can't spawn worker thread").
WHOLE_CLASSES = {"test_nx_graph.NxGraphTests"}
RAN = re.compile(r"^Ran (\d+) tests? in ", re.M)


def iter_tests(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from iter_tests(item)
        else:
            yield item


def discover(start: Path) -> dict[str, list[str]]:
    """Map `module.Class` to its sorted test ids; import failures are reported, not hidden."""
    sys.path.insert(0, str(start))
    suite = unittest.defaultTestLoader.discover(str(start), pattern="test_*.py")
    classes: dict[str, list[str]] = defaultdict(list)
    for test in iter_tests(suite):
        test_id = test.id()
        if test_id.startswith("unittest.loader."):
            raise SystemExit(f"test import failed: {test_id}")
        classes[test_id.rsplit(".", 1)[0]].append(test_id)
    return {name: sorted(ids) for name, ids in sorted(classes.items())}


def shards(classes: dict[str, list[str]]) -> list[list[str]]:
    big, small = [], []
    for name, ids in classes.items():
        if len(ids) > SPLIT_OVER and name not in WHOLE_CLASSES:
            big.extend([i] for i in ids)
        else:
            small.append(ids)
    return big + small


def run_shard(ids: list[str]) -> tuple[list[str], int, str, float]:
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join([str(HERE), os.environ.get("PYTHONPATH", "")]),
    }
    started = time.monotonic()
    result = subprocess.run(
        [sys.executable, "-m", "unittest", *ids],
        env=env,
        capture_output=True,
        text=True,
    )
    return (
        ids,
        result.returncode,
        result.stdout + result.stderr,
        time.monotonic() - started,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jobs", type=int, default=3)
    args = parser.parse_args()
    started = time.monotonic()
    classes = discover(HERE)
    expected = sum(len(ids) for ids in classes.values())
    work = shards(classes)
    ran = 0
    failed = 0
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for ids, code, output, _seconds in pool.map(run_shard, work):
            counts = RAN.findall(output)
            count = int(counts[-1]) if counts else 0
            ran += count
            if code != 0 or count != len(ids):
                failed += 1
                print(
                    f"FAILED shard ({count}/{len(ids)} ran, exit {code}): {ids[0]} ...",
                    flush=True,
                )
                print(output, flush=True)
    seconds = time.monotonic() - started
    print(
        f"Ran {ran} tests in {seconds:.1f}s across {len(work)} processes ({expected} discovered)"
    )
    if failed or ran != expected:
        print(
            f"FAILED ({failed} shard(s) failed)"
            if failed
            else "FAILED (test count mismatch)"
        )
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
