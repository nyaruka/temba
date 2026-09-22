"""
Finds functions that mutate module-level containers in place.

Such a container is shared between every request a threaded server is handling at once - and unlike assigning to
a global, mutating one needs no `global` statement, so no linter rule flags it. Each one has to either be populated
once at import time or be safe to mutate concurrently, and says which with a `# thread-safe: <reason>` comment on
the line that defines it.
"""

import ast
import pathlib

MUTATING_METHODS = {
    "append",
    "extend",
    "insert",
    "pop",
    "popitem",
    "remove",
    "clear",
    "update",
    "setdefault",
    "add",
    "discard",
    "sort",
    "reverse",
}
CONTAINER_TYPES = {"dict", "list", "set", "OrderedDict", "defaultdict", "deque", "Counter"}
THREAD_SAFE_MARKER = "# thread-safe:"


def find_mutated_globals(source: str, filename: str) -> list[str]:
    """
    Returns a description of each place in the given module source that a function mutates a module-level container
    """
    lines = source.splitlines()
    tree = ast.parse(source, filename)

    # module-level names bound to a container, less any whose defining line carries the marker
    containers = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets = [node.target]
        else:
            continue
        value = node.value
        is_container = isinstance(value, (ast.Dict, ast.List, ast.Set, ast.DictComp, ast.ListComp, ast.SetComp)) or (
            isinstance(value, ast.Call)
            and getattr(value.func, "id", getattr(value.func, "attr", None)) in CONTAINER_TYPES
        )
        for target in targets:
            if isinstance(target, ast.Name) and is_container and THREAD_SAFE_MARKER not in lines[node.lineno - 1]:
                containers[target.id] = node.lineno
    if not containers:
        return []

    problems = []
    for func in ast.walk(tree):
        if not isinstance(func, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue

        # only this function's own scope: nested functions and classes are scopes of their own, and are visited in
        # their own right by the walk above
        scope = list(_iter_scope(func))

        # a name this function binds itself - a parameter, or anything it assigns to by any means - is a local
        # shadowing whatever module-level name it shares, unless it's declared global
        declared_global = {n for node in scope if isinstance(node, ast.Global) for n in node.names}
        params = {a.arg for a in ast.walk(func.args) if isinstance(a, ast.arg)}
        bound = {node.id for node in scope if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)}
        bound |= {node.name for node in scope if isinstance(node, ast.ExceptHandler) and node.name}
        shadowed = (params | bound) - declared_global

        for node in scope:
            name = None
            if isinstance(node, (ast.Assign, ast.AugAssign, ast.Delete)):
                targets = node.targets if isinstance(node, (ast.Assign, ast.Delete)) else [node.target]
                for target in targets:
                    if isinstance(target, ast.Subscript) and isinstance(target.value, ast.Name):  # X[k] = v, del X[k]
                        name = target.value.id
                    elif isinstance(node, ast.AugAssign) and isinstance(target, ast.Name):  # X += [v] mutates in place
                        name = target.id
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):  # X.append(v) etc
                if isinstance(node.func.value, ast.Name) and node.func.attr in MUTATING_METHODS:
                    name = node.func.value.id
            if name in containers and name not in shadowed:
                problems.append(
                    (
                        node.lineno,
                        f"{filename}:{node.lineno}: {func.name}() mutates module-level `{name}` (defined line {containers[name]})",
                    )
                )
    return [message for _, message in sorted(problems)]


def _iter_scope(func):
    """
    Walks a function body without descending into the nested functions and classes that have scopes of their own
    """
    stack = list(func.body)
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            continue
        yield node
        stack.extend(ast.iter_child_nodes(node))


def is_app_source(path: pathlib.Path) -> bool:
    """
    Whether the given file is application code that the check applies to, as opposed to migrations or tests
    """
    return "migrations" not in path.parts and "tests" not in path.parts and path.name != "tests.py"
