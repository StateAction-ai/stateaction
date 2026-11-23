"""Static policy for a public repository's workflows (SA-138).

Workflows are parsed as text so the check runs with the standard library only.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = sorted((ROOT / ".github" / "workflows").glob("*.yml"))
UNTRUSTED = re.compile(
    r"\$\{\{\s*(github\.event\.(pull_request|issue|comment|review|head_commit"
    r"|workflow_run\.(head_branch|head_commit|display_title|pull_requests)|ref\b)"
    r"|github\.(head_ref|ref_name)|inputs\.|github\.event\.inputs\.)"
)


def triggers(path):
    """Event names under the top-level `on:` key (block, inline or list form)."""
    found = set()
    in_on = False
    for line in lines(path):
        if re.match(r"^on:\s*\S", line):
            found |= set(re.findall(r"[a-z_]+", line.split(":", 1)[1]))
        elif re.match(r"^on:\s*$", line):
            in_on = True
        elif in_on and re.match(r"^\S", line):
            in_on = False
        elif in_on:
            match = re.match(r"^  ([a-z_]+):", line) or re.match(
                r"^  - ([a-z_]+)", line
            )
            if match:
                found.add(match.group(1))
    return found


def lines(path):
    return path.read_text().splitlines()


class WorkflowHardening(unittest.TestCase):
    def test_workflows_exist(self):
        self.assertTrue(WORKFLOWS)

    def test_only_trusted_triggers(self):
        allowed = {
            "auto-merge.yml": {"workflow_dispatch", "workflow_run"},
            "deploy.yml": {"workflow_dispatch", "push"},
            "checks.yml": {"workflow_dispatch"},
            "pr-policy.yml": {"workflow_dispatch"},
        }
        for path in WORKFLOWS:
            self.assertIn(path.name, allowed, f"unreviewed workflow {path.name}")
            self.assertEqual(triggers(path), allowed[path.name], path.name)

    def test_top_level_permissions_are_read_or_explicit(self):
        for path in WORKFLOWS:
            text = path.read_text()
            self.assertRegex(text, r"(?m)^permissions:", path.name)
            self.assertNotIn("write-all", text, path.name)
            top = re.match(r"(?s).*?^permissions:\n((?:  .*\n)+)", text, re.M)
            if path.name != "auto-merge.yml":
                self.assertIsNotNone(top, path.name)
                self.assertNotIn(": write", top.group(1), path.name)

    def test_actions_pinned_to_full_sha(self):
        for path in WORKFLOWS:
            for number, line in enumerate(lines(path), 1):
                match = re.match(r"\s*-?\s*uses:\s*(\S+)", line)
                if match and not match.group(1).startswith("./"):
                    self.assertRegex(
                        match.group(1),
                        r"@[0-9a-f]{40}$",
                        f"{path.name}:{number} must pin a full commit SHA",
                    )

    def test_checkout_does_not_persist_credentials(self):
        for path in WORKFLOWS:
            body = lines(path)
            for index, line in enumerate(body):
                if "actions/checkout@" in line:
                    window = "\n".join(body[index : index + 6])
                    self.assertIn(
                        "persist-credentials: false", window, f"{path.name}:{index + 1}"
                    )

    def test_no_untrusted_context_in_shell(self):
        for path in WORKFLOWS:
            in_run = False
            for number, line in enumerate(lines(path), 1):
                stripped = line.strip()
                if re.match(r"-?\s*run:", stripped):
                    in_run = True
                elif re.match(r"^[A-Za-z_-]+:", stripped) or stripped.startswith("- "):
                    in_run = False
                if in_run or stripped.startswith("run:"):
                    self.assertIsNone(
                        UNTRUSTED.search(line),
                        f"{path.name}:{number} interpolates untrusted input in a shell; use env",
                    )

    def test_secrets_only_in_deploy_with_protected_environment(self):
        for path in WORKFLOWS:
            if not re.search(r"\bsecrets\b", path.read_text()):
                continue
            self.assertEqual(path.name, "deploy.yml", "secrets only in deploy.yml")
            text = path.read_text()
            self.assertRegex(text, r"(?m)^\s+environment:\s*production")

    def test_privileged_workflow_run_rejects_foreign_repositories(self):
        merger = (ROOT / "scripts" / "automation" / "auto_merge.py").read_text()
        self.assertIn('run.get("head_repository", {}).get("full_name"', merger)
        workflow = (ROOT / ".github" / "workflows" / "auto-merge.yml").read_text()
        self.assertIn(
            "github.event.workflow_run.head_repository.full_name == github.repository",
            workflow,
        )
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn("ref: refs/heads/main", workflow)


if __name__ == "__main__":
    unittest.main()
