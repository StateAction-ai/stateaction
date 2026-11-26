"""Trusted bootstrap inside bubblewrap."""

import ast
import builtins
import json
import sys

EXPORTS: dict[str, frozenset[str]] = {
    "stateaction_recipes": frozenset(
        ("RecordingScope", "Limits", "budget", "define_recipe", "usd")
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


class Policy:
    def __init__(self):
        self.violation = None
        self.line = 1

    def deny(self, code):
        if self.violation is None:
            self.violation = code
        error = RecipePolicyError(code)
        error.lineno = self.line
        raise error

    def check_import(self, name, names, level):
        if level or name not in EXPORTS or not EXPORTS[name].issuperset(names):
            self.deny("import_not_allowed")

    def check_ast(self, tree):
        for node in ast.walk(tree):
            self.line = getattr(node, "lineno", 1)
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
    policy.line = 1
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
    from stateaction_recipes import RecipeError, modules

    EXPORTS["stateaction_recipes.modules"] = frozenset(modules.__all__)
    if sys.argv[1:] == ["--probe"]:
        import probe

        print("ready", flush=True)
        return probe.run(Policy, RecipePolicyError)
    sys.path.clear()
    try:
        with open("/recipes/recipe.py", "rb") as file:
            source = file.read()
        print("ready", flush=True)
        print(evaluate(source))
    except Exception as exc:
        line = getattr(exc, "lineno", 1)
        traceback = exc.__traceback__
        while traceback:
            if traceback.tb_frame.f_code.co_filename == "/recipes/recipe.py":
                line = traceback.tb_lineno
            traceback = traceback.tb_next
        if isinstance(exc, RecipeError):
            code, fix, line = exc.code, exc.fix, exc.line
        elif isinstance(exc, RecipePolicyError):
            code = str(exc)
            fix = "Use only the recipe SDK and generated module imports. Keep recipe code free of I/O."
        else:
            code = "invalid_recipe"
            fix = "Check syntax, argument names and types against AUTHORING.md. Export a decorated build function."
        print(json.dumps({"code": code, "fix": fix, "line": line}), file=sys.stderr)
        return 20
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
