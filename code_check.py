#!/usr/bin/env python3

import argparse
import ast
import os
import pathlib
import subprocess
import tempfile
import tomllib

import colorama

parser = argparse.ArgumentParser(description="Code checks")
parser.add_argument("--debug", action="store_true")
args = parser.parse_args()

DEBUG = args.debug


def cmd(line):
    if DEBUG:
        print(colorama.Style.DIM + "% " + line + colorama.Style.RESET_ALL)
    try:
        output = subprocess.check_output(line, shell=True).decode("utf-8")
        if DEBUG:
            print(colorama.Style.DIM + output + colorama.Style.RESET_ALL)
        return output
    except subprocess.CalledProcessError as e:
        print(colorama.Fore.RED + e.stdout.decode("utf-8") + colorama.Style.RESET_ALL)
        exit(1)


# Module-level containers that functions mutate in place are shared between every request a threaded server is
# handling at once - and unlike assigning to a global, mutating one needs no `global` statement, so no linter rule
# flags it. Each one has to either be populated once at import time or be safe to mutate concurrently, and says
# which with a `# thread-safe: <reason>` comment on the line that defines it.
MUTATING_METHODS = {"append", "extend", "insert", "pop", "popitem", "remove", "clear", "update", "setdefault", "add", "discard", "sort", "reverse"}
CONTAINER_TYPES = {"dict", "list", "set", "OrderedDict", "defaultdict", "deque", "Counter"}
THREAD_SAFE_MARKER = "# thread-safe:"


def find_mutated_globals(path: pathlib.Path) -> list[str]:
    source = path.read_text()
    lines = source.splitlines()
    tree = ast.parse(source, str(path))

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
            isinstance(value, ast.Call) and getattr(value.func, "id", getattr(value.func, "attr", None)) in CONTAINER_TYPES
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

        # a name the function rebinds as a plain local isn't the module-level one
        declared_global = {n for node in ast.walk(func) if isinstance(node, ast.Global) for n in node.names}
        rebound = {
            t.id for node in ast.walk(func) if isinstance(node, ast.Assign) for t in node.targets if isinstance(t, ast.Name)
        }
        shadowed = rebound - declared_global

        for node in ast.walk(func):
            name = None
            if isinstance(node, (ast.Assign, ast.AugAssign, ast.Delete)):  # X[k] = v, X[k] += v, del X[k]
                targets = node.targets if isinstance(node, (ast.Assign, ast.Delete)) else [node.target]
                name = next((t.value.id for t in targets if isinstance(t, ast.Subscript) and isinstance(t.value, ast.Name)), None)
            elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):  # X.append(v) etc
                if isinstance(node.func.value, ast.Name) and node.func.attr in MUTATING_METHODS:
                    name = node.func.value.id
            if name in containers and name not in shadowed:
                problems.append(f"{path}:{node.lineno}: {func.name}() mutates module-level `{name}` (defined line {containers[name]})")
    return problems


def is_app_source(path: pathlib.Path) -> bool:
    return "migrations" not in path.parts and "tests" not in path.parts and path.name != "tests.py"


def status(line):
    print(colorama.Fore.GREEN + f">>> {line}..." + colorama.Style.RESET_ALL)


if __name__ == "__main__":
    colorama.init()

    # checks run against the project in the current directory - which needn't be this checkout, as projects that
    # build on this one run this same script - and are configured by the [tool.code_check] section of its
    # pyproject.toml
    with open("pyproject.toml", "rb") as f:
        config = tomllib.load(f)["tool"]["code_check"]

    packages = " ".join(config["packages"])
    locale_dir = config["locale"]

    # makemessages only ever writes to a `locale` directory directly under its working directory, so it has to be
    # run from the parent of the configured locale directory - with the ignore globs rebased to be relative to it
    msg_dir = os.path.dirname(locale_dir) or "."
    ignores = " ".join(f"--ignore='{i.removeprefix(msg_dir + '/')}'" for i in config.get("ignore", []))

    if config.get("migrations", False):
        status("Check for missing migrations")
        cmd("python manage.py makemigrations --check")

    status("Check locale files are up to date")
    with tempfile.TemporaryDirectory() as backup_dir:
        # take a copy of the PO files so we can compare the regenerated ones against them, and then put them
        # back. we compare against the working copy rather than using git because git isn't usable from here
        # in CI, where the checkout isn't a safe directory for the user running the checks
        cmd(f"cp -a {locale_dir}/. {backup_dir}")

        # run without django settings so makemessages only sees locale directories under the current directory -
        # with settings configured, LOCALE_PATHS could pull other projects' catalogs into scope
        cmd(
            f"cd '{msg_dir}' && "
            f"DJANGO_SETTINGS_MODULE= django-admin makemessages -a -e haml,html,txt,py --no-location --no-wrap "
            f"{ignores} 2>&1"
        )
        cmd(f"for f in {locale_dir}/*/LC_MESSAGES/django.po; do msgattrib --no-obsolete --no-wrap -o $f $f; done")

        # POT-Creation-Date can change without any actual message changes so ignore it. if this fails then the
        # regenerated files are left in place, ready to be committed
        cmd(f"diff -ur -I '^\"POT-Creation-Date:' {backup_dir} {locale_dir}")

        # nothing to do, so restore the originals rather than leaving a dirty working tree behind
        cmd(f"cp -a {backup_dir}/. {locale_dir}")

    status("Check for module-level state mutated in functions")
    problems = []
    for package in config["packages"]:
        for path in sorted(pathlib.Path(package).rglob("*.py")):
            if is_app_source(path):
                problems.extend(find_mutated_globals(path))
    if problems:
        print(
            colorama.Fore.RED
            + "\n".join(problems)
            + "\n\nEach of these is shared by every request a threaded server is handling at once. Either don't mutate "
            + "it after import, or add a `# thread-safe: <reason>` comment to the line that defines it."
            + colorama.Style.RESET_ALL
        )
        exit(1)

    status("Running ruff format")
    cmd(f"ruff format --check {packages}")

    status("Running ruff")
    cmd(f"ruff check {packages}")

    print("👍 " + colorama.Fore.GREEN + "Code looks good. Make that PR!")
