#!/usr/bin/env python3
"""Fast checks for a docs-only change: prettier format and relative links/anchors.

The changed paths arrive newline-separated in STATEACTION_DOCS_CHANGED (the docs-only run
sets it; Nx lists it as an input of `tooling:docs-check`, so the result is cached per
changed-path list and docs tree). Deleted paths are skipped. Standard library only.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote

ENV = "STATEACTION_DOCS_CHANGED"
REMOVED_ENV = "STATEACTION_DOCS_REMOVED"
FENCE = re.compile(r"^\s*(```|~~~)")
INLINE_CODE = re.compile(r"`+[^`\n]*`+")
LINK = re.compile(
    r"!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>\n]*>|[^)\s]*)(?:\s+(?:\"[^\"]*\"|'[^']*'))?\s*\)"
)
REFDEF = re.compile(r"^\s{0,3}\[[^\]]+\]:\s*(<[^>\n]*>|\S+)", re.M)
HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$")
HTML_ID = re.compile(r"""<[a-zA-Z][^>]*\s(?:id|name)=["']([^"']+)["']""")
SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")


def strip_code(text: str, inline: bool = True) -> str:
    """Drop fenced code blocks (and inline code) so example links are not checked."""
    out, fenced = [], None
    for line in text.splitlines():
        match = FENCE.match(line)
        if match:
            fenced = None if fenced == match[1] else fenced or match[1]
            continue
        if fenced is None:
            out.append(INLINE_CODE.sub("", line) if inline else line)
    return "\n".join(out)


def slug(heading: str) -> str:
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", heading)
    text = re.sub(r"[`*~]", "", text).strip().lower()
    text = re.sub(r"[^\w\- ]", "", text, flags=re.UNICODE)
    return text.replace(" ", "-")


def anchors(text: str) -> set[str]:
    found: set[str] = set()
    seen: dict[str, int] = {}
    body = strip_code(text, inline=False)
    for line in body.splitlines():
        match = HEADING.match(line)
        if not match:
            continue
        base = slug(match[1])
        count = seen.get(base, 0)
        seen[base] = count + 1
        found.add(base if count == 0 else f"{base}-{count}")
    found.update(HTML_ID.findall(text))
    return found


def targets(text: str) -> list[str]:
    body = strip_code(text)
    raw = [m[1] for m in LINK.finditer(body)] + [m[1] for m in REFDEF.finditer(body)]
    return [t[1:-1] if t.startswith("<") else t for t in raw if t]


def untracked_by_design(root: Path, destination: Path) -> bool:
    """A missing target that is git-ignored (local captures) or inside a submodule checkout
    that this tree does not populate cannot be checked, so it is not a broken link."""
    relative = destination.relative_to(root.resolve()).as_posix()
    modules = root / ".gitmodules"
    if modules.is_file():
        for match in re.finditer(r"^\s*path\s*=\s*(\S+)", modules.read_text(), re.M):
            if relative == match[1] or relative.startswith(match[1] + "/"):
                return True
    ignored = subprocess.run(
        ["git", "check-ignore", "-q", "--", relative], cwd=root, capture_output=True
    )
    return ignored.returncode == 0


def check_links(root: Path, path: str) -> list[str]:
    source = root / path
    text = source.read_text(encoding="utf-8", errors="replace")
    problems = []
    for target in targets(text):
        if SCHEME.match(target) or target.startswith("//"):
            continue
        target, _, fragment = target.partition("#")
        target = unquote(target.partition("?")[0])
        fragment = unquote(fragment)
        if not target:
            destination = source
        elif target.startswith("/"):
            destination = root / target.lstrip("/")
        else:
            destination = source.parent / target
        try:
            destination = destination.resolve()
            destination.relative_to(root.resolve())
        except (OSError, ValueError):
            problems.append(f"{path}: link {target!r} leaves the repository")
            continue
        if not destination.exists():
            if untracked_by_design(root, destination):
                continue
            problems.append(f"{path}: link target {target!r} does not exist")
            continue
        if fragment and destination.is_file() and destination.suffix == ".md":
            known = anchors(destination.read_text(encoding="utf-8", errors="replace"))
            if fragment not in known and fragment.lower() not in known:
                problems.append(
                    f"{path}: anchor #{fragment} not found in {destination.name}"
                )
    return problems


def check_removed(root: Path, removed: set[str]) -> list[str]:
    """Links anywhere in the repository's Markdown to a doc this change deleted or renamed."""
    listing = subprocess.run(
        ["git", "ls-files", "-z", "--", "*.md"], cwd=root, capture_output=True
    )
    problems = []
    for name in sorted(filter(None, listing.stdout.decode().split("\0"))):
        if not (root / name).is_file():
            continue
        source = root / name
        for target in targets(source.read_text(encoding="utf-8", errors="replace")):
            if SCHEME.match(target) or target.startswith("//"):
                continue
            path = unquote(target.partition("#")[0].partition("?")[0])
            if not path:
                continue
            base = root if path.startswith("/") else source.parent
            try:
                resolved = (
                    (base / path.lstrip("/")).resolve().relative_to(root.resolve())
                )
            except (OSError, ValueError):
                continue
            if resolved.as_posix() in removed:
                problems.append(f"{name}: link to {path!r}, which this change removed")
    return problems


def main() -> int:
    raw = os.environ.get(ENV)
    if raw is None:
        print(
            f"{ENV} is not set; this check runs only in a docs-only gate",
            file=sys.stderr,
        )
        return 2
    root = Path.cwd()
    changed = [p for p in raw.split("\n") if p]
    existing = sorted({p for p in changed if (root / p).is_file()})
    problems: list[str] = []
    if existing:
        result = subprocess.run(
            [
                "pnpm",
                "exec",
                "prettier",
                "--check",
                "--ignore-unknown",
                "--",
                *existing,
            ],
            cwd=root,
        )
        if result.returncode:
            problems.append("prettier --check failed (see output above)")
    for path in existing:
        if path.endswith(".md"):
            problems.extend(check_links(root, path))
    removed = {p for p in os.environ.get(REMOVED_ENV, "").split("\n") if p}
    if removed:
        problems.extend(check_removed(root, removed))
    for problem in problems:
        print(problem, file=sys.stderr)
    print(
        f"docs checks: {len(existing)} changed docs checked, {len(problems)} problems"
    )
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
