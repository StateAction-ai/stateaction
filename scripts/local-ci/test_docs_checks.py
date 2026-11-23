"""Tests for the docs-only link/anchor check (SA-117). Prettier is covered by the gate."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import docs_checks  # noqa: E402


class LinkCheckTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)

    def write(self, path: str, text: str) -> str:
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        return path

    def check(self, path: str) -> list[str]:
        return docs_checks.check_links(self.root, path)

    def test_valid_relative_links_and_anchors_pass(self):
        self.write("docs/b.md", "# Title\n\n## Second part\n\n## Second part\n")
        self.write("docs/img.png", "x")
        self.write(
            "docs/a.md",
            "# A\n[b](b.md) [t](b.md#title) [s](./b.md#second-part-1) ![i](img.png)\n"
            "[self](#a) [dir](../docs/) [root](/docs/b.md) [ref][r]\n\n[r]: b.md#second-part\n",
        )
        self.assertEqual(self.check("docs/a.md"), [])

    def test_missing_file_and_anchor_are_reported(self):
        self.write("docs/b.md", "# Title\n")
        self.write("docs/a.md", "[x](nope.md) [y](b.md#absent) [z](#gone)\n")
        problems = self.check("docs/a.md")
        self.assertEqual(len(problems), 3, problems)
        self.assertIn("nope.md", problems[0])
        self.assertIn("#absent", problems[1])
        self.assertIn("#gone", problems[2])

    def test_code_external_and_escaping_links(self):
        self.write(
            "a.md",
            "```\n[x](missing.md)\n```\n`[y](missing.md)`\n[w](https://example.invalid/x)\n"
            "[m](mailto:a@b.invalid) [out](../../etc/passwd)\n",
        )
        problems = self.check("a.md")
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("leaves the repository", problems[0])

    def test_ignored_and_submodule_targets_are_not_broken_links(self):
        self.write(".gitignore", "captures/\n")
        self.write(".gitmodules", '[submodule "s"]\n\tpath = stera-sdk\n\turl = x\n')
        self.write("docs/a.md", "[c](../captures/a.json) [s](../stera-sdk/src/x.py)\n")
        self.assertEqual(self.check("docs/a.md"), [])

    def test_heading_slugs_follow_github(self):
        found = docs_checks.anchors(
            "# `code` & Things!\n## Run: `x` (fast)\n```\n# not a heading\n```\n"
            '<a id="manual"></a>\n'
        )
        self.assertEqual(found, {"code--things", "run-x-fast", "manual"})

    def test_links_to_a_removed_doc_from_unchanged_docs_are_reported(self):
        self.write("docs/gone.md", "# Gone\n")
        self.write("docs/keep.md", "[g](gone.md#gone) [ok](keep.md)\n")
        self.write("README.md", "[g](docs/gone.md)\n")
        subprocess.run(["git", "add", "-A"], cwd=self.root, check=True)
        problems = docs_checks.check_removed(self.root, {"docs/gone.md"})
        self.assertEqual(len(problems), 2, problems)
        self.assertEqual(docs_checks.check_removed(self.root, {"docs/other.md"}), [])

    def test_main_requires_the_changed_list_and_skips_deleted_paths(self):
        env = {"PATH": "/usr/bin:/bin"}
        result = subprocess.run(
            [sys.executable, str(HERE / "docs_checks.py")],
            cwd=self.root,
            env=env,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)
        result = subprocess.run(
            [sys.executable, str(HERE / "docs_checks.py")],
            cwd=self.root,
            env=env | {docs_checks.ENV: "docs/deleted.md"},
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
