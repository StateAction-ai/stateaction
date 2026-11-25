"""E6 acceptance tests against the actual bwrap compiler."""

import errno
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from compile_recipe import (
    HERE,
    SOURCE_LIMIT,
    CompileError,
    canonical_json,
    compile_recipe,
    run_sandbox,
)

EXAMPLE = HERE / "recipes/egocentric_default.py"
DIGEST = "968d5537d32ff75756c44df51ac8bb5fbf84a8b47e3d2d63ed91a80db59c0408"


class SandboxTest(unittest.TestCase):
    def test_example_compiles_via_cli(self):
        command = [sys.executable, "-B", str(HERE / "compile_recipe.py"), str(EXAMPLE)]
        payload = subprocess.check_output(command, timeout=20)
        graph = json.loads(payload)
        self.assertEqual(payload, canonical_json(graph))
        self.assertEqual(hashlib.sha256(payload).hexdigest(), DIGEST)
        self.assertEqual(graph["recipe"], "egocentric_default@1")
        self.assertEqual(graph["fanOut"], {"clip": "clips.plan"})
        self.assertEqual(
            set(graph["nodes"]),
            {"caption", "clips", "hand_pose", "review_video", "segment"},
        )
        self.assertEqual(
            graph["nodes"]["caption"]["inputs"],
            {"segments": "segment.segments", "video": "clip.video"},
        )
        self.assertEqual(
            graph["nodes"]["caption"]["resources"],
            {
                "budget": {"fixedSeconds": 300, "perSourceSecond": "0.25"},
                "gpu": "RTX-PRO-6000",
            },
        )
        self.assertEqual(
            subprocess.check_output([*command, "--digest"], timeout=20)
            .decode()
            .strip(),
            DIGEST,
        )

    def test_source_formatting_preserves_semantic_digest(self):
        _, digest = compile_recipe(
            b"\n# Synthetic formatting change\n" + EXAMPLE.read_bytes()
        )
        self.assertEqual(digest, DIGEST)

    def test_refuses_recipe_probes(self):
        cases = {
            "open": (b'open("/tmp/e6-recipe", "w")', "nondeterministic_api:open"),
            "caught_open": (
                b'try:\n    open("/tmp/e6-recipe", "w")\nexcept PermissionError:\n    pass',
                "nondeterministic_api:open",
            ),
            "network": (b"import socket", "import_not_allowed"),
            "subprocess": (b"from subprocess import run", "import_not_allowed"),
            "cached_import": (b"import sys", "import_not_allowed"),
            "dynamic_import": (b'__import__("sys")', "import_not_allowed"),
            "relative_import": (b"from . import other", "import_not_allowed"),
            "private_sdk_import": (
                b"from stateaction_recipes import Handle",
                "import_not_allowed",
            ),
        }
        for name, (probe, error) in cases.items():
            with self.subTest(probe=name), self.assertRaises(CompileError) as caught:
                compile_recipe(probe + b"\n" + EXAMPLE.read_bytes())
            self.assertEqual(str(caught.exception), error)

    def test_os_boundary_and_hooks(self):
        with tempfile.TemporaryDirectory(prefix="e6-synthetic-") as directory:
            canary = Path(directory) / "host-canary.txt"
            canary.write_text("synthetic sandbox test\n")
            with patch.dict(os.environ, {"E6_SYNTHETIC_PARENT": "not for recipes"}):
                result = json.loads(run_sandbox(os.fsencode(canary), policy_probe=True))

        self.assertEqual(
            result["environment"],
            {
                "PYTHONHASHSEED": "0",
                "LC_ALL": "C.UTF-8",
                "PWD": "/tmp",
            },
        )
        self.assertEqual(result["python_flags"], [True, 1, 1, 1])
        seeded_hash = subprocess.check_output(
            [sys.executable, "-B", "-c", 'print(hash("e6"))'],
            env={"PYTHONHASHSEED": "0"},
            timeout=5,
        )
        self.assertEqual(result["hash"], int(seeded_hash))
        self.assertEqual(result["cpu"], [5, 5])
        self.assertEqual(result["address_space"], [536870912, 536870912])
        self.assertEqual(result["descriptors"], [64, 64])
        self.assertEqual(result["inherited_descriptors"], [])
        self.assertEqual(result["file_size"], [1048576, 1048576])
        self.assertEqual(result["network_interfaces"], ["lo"])
        self.assertEqual(
            result["root"], ["compiler", "lib", "lib64", "recipes", "runtime", "tmp"]
        )
        self.assertEqual(
            result["before_hooks"],
            {
                "create_at_root": errno.EROFS,
                "write_recipe": errno.EROFS,
                "read_host_canary": errno.ENOENT,
            },
        )
        self.assertEqual(
            result["after_hooks"],
            {
                "open": "nondeterministic_api:open",
                "socket": "nondeterministic_api:socket.__new__",
                "subprocess": "nondeterministic_api:subprocess.Popen",
                "os_system": "nondeterministic_api:os.system",
                "cached_import": "import_not_allowed",
                "finder": "import_not_allowed",
            },
        )

    def test_fails_closed_if_bwrap_is_missing(self):
        with self.assertRaisesRegex(CompileError, "^sandbox_unavailable$"):
            run_sandbox(EXAMPLE.read_bytes(), bwrap=Path("/no-such-e6-bwrap"))

    def test_refuses_oversized_and_invalid_sources(self):
        for source in (b"#" * (SOURCE_LIMIT + 1), b"def:", b"build = None"):
            with (
                self.subTest(length=len(source)),
                self.assertRaisesRegex(CompileError, "^invalid_recipe$"),
            ):
                compile_recipe(source)

    def test_refuses_different_digests(self):
        graphs = [
            b'{"schema":"stateaction.authoring-graph/e6","recipe":"first"}',
            b'{"schema":"stateaction.authoring-graph/e6","recipe":"second"}',
        ]
        with (
            patch("compile_recipe.run_sandbox", side_effect=graphs),
            self.assertRaisesRegex(CompileError, "^nondeterministic_recipe$"),
        ):
            compile_recipe(b"synthetic")


if __name__ == "__main__":
    unittest.main()
