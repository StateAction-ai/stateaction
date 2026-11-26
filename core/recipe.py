"""Local recipe authoring commands."""

import argparse
import difflib
import json
import subprocess
import sys
from pathlib import Path

from catalog import ROOT, bindings, check_identifier, modules, pretty, refresh
from compiler import compile_recipe
from jsonschema.exceptions import SchemaError, ValidationError
from local_run import run_local
from sandbox import CompileError, canonical_json
from types_codegen import generate

BINDINGS = Path("core/stateaction_recipes/modules.py")
TEMPLATE = """from stateaction_recipes import Limits, RecordingScope, budget, define_recipe, usd
from stateaction_recipes.modules import clip_filter_passthrough, hand_pose_cpu


@define_recipe(
    id="{id}",
    version=1,
    title="{title}",
    input="recording_source@2",
    limits=Limits(usd("1.00"), usd("2.00"), 120),
)
def build(r: RecordingScope) -> None:
    clips = r.node("clips", clip_filter_passthrough(source=r.source), budget=budget.fixed(10))
    with r.per_clip(clips.plan) as c:
        c.node("hands", hand_pose_cpu(video=c.video), budget=budget.fixed(20))
"""


def source_paths(root: Path):
    return sorted(
        path
        for folder in ("recipes", "examples")
        for path in (root / folder).glob("*.py")
    )


def compiled_path(source: Path):
    return source.parent / "compiled" / source.with_suffix(".json").name


def sync(root: Path, *, check: bool):
    catalog = modules(root, check=check)
    refresh(root / BINDINGS, bindings(catalog), check=check)
    generate(root, check=check)
    expected = set()
    recipe_refs = set()
    for path in source_paths(root):
        graph = compile_with_context(path, root, catalog)
        if graph["recipe"] in recipe_refs:
            raise ValueError(f"{path}: duplicate recipe id@version")
        recipe_refs.add(graph["recipe"])
        if graph["recipe"].split("@")[0] != path.stem:
            raise ValueError(f"{path}: name the source file after the recipe id")
        output = compiled_path(path)
        expected.add(output)
        refresh(output, canonical_json(graph).decode() + "\n", check=check)
    for folder in ("recipes", "examples"):
        if orphaned := set((root / folder / "compiled").glob("*.json")) - expected:
            paths = ", ".join(str(path.relative_to(root)) for path in sorted(orphaned))
            raise ValueError(f"{paths}: remove compiled graphs without recipe sources")


def compile_with_context(path: Path, root: Path, catalog: dict):
    try:
        return compile_recipe(path, root, catalog)
    except CompileError as exc:
        raise ValueError(
            f"{path.relative_to(root)}:{exc.line}: {exc.code}. {exc.fix}"
        ) from exc


def diff(root: Path, base: str) -> None:
    revision = subprocess.run(
        ["git", "rev-parse", "--verify", "--end-of-options", base + "^{commit}"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    tracked = subprocess.run(
        [
            "git",
            "ls-tree",
            "-r",
            "--name-only",
            revision,
            "--",
            "recipes/compiled",
            "examples/compiled",
        ],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    current = {
        compiled_path(path).relative_to(root).as_posix() for path in source_paths(root)
    }
    for name in sorted(current | set(tracked)):
        old = (
            subprocess.run(
                ["git", "show", f"{revision}:{name}"],
                cwd=root,
                check=True,
                capture_output=True,
            ).stdout
            if name in tracked
            else None
        )
        new = (root / name).read_bytes() if name in current else None
        before = pretty(json.loads(old)).splitlines(keepends=True) if old else []
        after = pretty(json.loads(new)).splitlines(keepends=True) if new else []
        sys.stdout.writelines(
            difflib.unified_diff(before, after, f"{base}/{name}", name)
        )


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("new").add_argument("id")
    commands.add_parser("sync")
    commands.add_parser("verify")
    commands.add_parser("diff").add_argument("--base", default="origin/main")
    for action in ("check", "graph", "run-local"):
        command = commands.add_parser(action)
        command.add_argument("file", type=Path)
        if action == "run-local":
            command.add_argument("--seconds", type=int, default=3)
            command.add_argument("--fail-node")
            command.add_argument("--fail-window", type=int)
    args = parser.parse_args(argv)
    try:
        if args.action == "new":
            check_identifier(args.id)
            target = ROOT / "recipes" / f"{args.id}.py"
            with target.open("x") as recipe:
                recipe.write(
                    TEMPLATE.format(
                        id=args.id, title=args.id.replace("_", " ").capitalize()
                    )
                )
            print(f"Created {target.relative_to(ROOT)}")
        elif args.action in {"sync", "verify"}:
            sync(ROOT, check=args.action == "verify")
        elif args.action == "diff":
            diff(ROOT, args.base)
        else:
            path = ROOT / args.file
            if not path.resolve().is_relative_to(ROOT):
                raise ValueError("Choose a recipe file inside the checkout.")
            graph = compile_with_context(path, ROOT, modules(ROOT, check=True))
            if args.action == "run-local":
                result = run_local(
                    graph,
                    ROOT,
                    seconds=args.seconds,
                    fail_node=args.fail_node,
                    fail_window=args.fail_window,
                )
                print(pretty(result), end="")
                return int(result["status"] != "passed")
            if args.action == "graph":
                for node_id in graph["topoOrder"]:
                    node = graph["nodes"][node_id]
                    parents = ", ".join(node["producers"]) or "source"
                    print(f"{node_id} [{node['scope']}, {node['module']}] <- {parents}")
                return 0
            print(pretty(graph), end="")
    except (
        ValueError,
        OSError,
        TypeError,
        SchemaError,
        ValidationError,
        subprocess.CalledProcessError,
    ) as exc:
        print(exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
