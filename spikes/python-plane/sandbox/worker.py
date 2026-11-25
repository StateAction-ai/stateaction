"""Trusted bootstrap inside bubblewrap."""

import ast
import builtins
import importlib.abc
import json
import sys
from pathlib import Path

EXPORTS = {
    "stateaction_recipes": frozenset(
        ("RecordingScope", "budget", "define_recipe", "usd")
    ),
    "stateaction_recipes.modules": frozenset(
        (
            "clip_filter_passthrough",
            "recording_mp4_remux",
            "flora_tempseg_vllm_fp8",
            "flora_captioner_vllm_fp8",
            "hand_pose_cpu",
        )
    ),
}
AUDIT_EVENTS = {
    "open",
    "os.system",
    "os.exec",
    "os.fork",
    "os.forkpty",
    "os.posix_spawn",
    "ctypes.dlopen",
    "ctypes.dlsym",
}
AUDIT_PREFIXES = ("socket.", "subprocess.")


class RecipePolicyError(PermissionError):
    pass


class Policy(importlib.abc.MetaPathFinder):
    def __init__(self):
        self.violation = None

    def deny(self, code):
        if self.violation is None:
            self.violation = code
        raise RecipePolicyError(code)

    def check_import(self, name, names, level):
        if level or name not in EXPORTS or not EXPORTS[name].issuperset(names):
            self.deny("import_not_allowed")

    def check_ast(self, tree):
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    self.check_import(alias.name, (), 0)
            elif isinstance(node, ast.ImportFrom):
                self.check_import(
                    node.module, (alias.name for alias in node.names), node.level
                )

    def import_module(self, name, globals=None, locals=None, fromlist=(), level=0):
        self.check_import(name, fromlist or (), level)
        return builtins.__import__(name, globals, locals, fromlist, level)

    def find_spec(self, fullname, path=None, target=None):
        self.check_import(fullname, (), 0)

    def audit(self, event, _args):
        if event in AUDIT_EVENTS or event.startswith(AUDIT_PREFIXES):
            self.deny(f"nondeterministic_api:{event}")


def evaluate(source):
    policy = Policy()
    tree = ast.parse(source, filename="/recipes/recipe.py")
    policy.check_ast(tree)
    code = compile(tree, "/recipes/recipe.py", "exec", dont_inherit=True)
    sys.meta_path.insert(0, policy)
    sys.addaudithook(policy.audit)
    namespace = {
        "__name__": "recipe",
        "__builtins__": dict(vars(builtins), __import__=policy.import_module),
    }
    try:
        exec(code, namespace)  # noqa: S102 - Evaluation runs inside bubblewrap.
        graph = namespace["build"]
        if type(graph) is not dict:
            raise ValueError("expected decorated recipe")
        return json.dumps(
            graph, ensure_ascii=True, separators=(",", ":"), allow_nan=False
        )
    finally:
        if policy.violation is not None:
            raise RecipePolicyError(policy.violation)


def main():
    sys.path.insert(0, "/compiler")
    __import__("stateaction_recipes.modules")
    if sys.argv[1:] == ["--probe"]:
        import probe

        return probe.run(Policy, RecipePolicyError)
    sys.path.clear()
    try:
        source = Path("/recipes/recipe.py").read_bytes()
        print(evaluate(source))
    except RecipePolicyError as exc:
        print(exc, file=sys.stderr)
        return 20
    except Exception:  # noqa: BLE001 - Return a code without recipe exception text.
        print("invalid_recipe", file=sys.stderr)
        return 20
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
