#!/usr/bin/env python3

import argparse
import ast
import os
import pathlib
import re
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

        # only this function's own scope: nested functions and classes are scopes of their own, and are visited in
        # their own right by the walk above
        scope = list(iter_scope(func))

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
                problems.append(f"{path}:{node.lineno}: {func.name}() mutates module-level `{name}` (defined line {containers[name]})")
    return problems


def iter_scope(func):
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

        # this is our own makemessages rather than django's - see temba/utils/management/commands/makemessages.py -
        # and it's run with the manage.py beside this script as the project being checked needn't have its own
        manage_py = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manage.py")
        cmd(
            f"python '{manage_py}' makemessages --cwd '{msg_dir}' -a -e haml,html,txt,py --no-location --no-wrap "
            f"--no-obsolete {ignores} 2>&1"
        )

        # if this fails then the regenerated files are left in place, ready to be committed
        cmd(f"diff -ur {backup_dir} {locale_dir}")

        # nothing to do, so restore the originals rather than leaving a dirty working tree behind
        cmd(f"cp -a {backup_dir}/. {locale_dir}")

    # a string without a translation falls back to English at runtime, which is invisible in an English-speaking dev
    # environment. makemessages makes it easy to miss: a new string that resembles an existing one gets that string's
    # translation copied in flagged as fuzzy, and msgfmt then drops fuzzy entries when compiling. so every string has to
    # have a real translation in each of the maintained locales - the source language's catalog is exempt as it's
    # never translated
    if translated := config.get("translated", []):
        status("Check translations are complete")
        problems = []
        for locale in translated:
            po = f"{locale_dir}/{locale}/LC_MESSAGES/django.po"
            for flags in ("--untranslated --no-fuzzy", "--only-fuzzy"):
                # output is empty when nothing matches, and otherwise a catalog whose first entry is the header
                if entries := cmd(f"msgattrib {flags} --no-wrap {po}").strip().split("\n\n", 1)[1:]:
                    problems.append(f"{po}:\n\n{entries[0]}")

            # msgattrib judges a plural entry by its first form alone, so also catch later forms left empty - which
            # with the catalogs unwrapped is a msgstr[n] "" line with no continuation line after it
            with open(po) as f:
                entries = f.read().split("\n\n")
            if partial := [e for e in entries if "msgid_plural" in e and re.search(r'^msgstr\[\d+\] ""$(?!\n")', e, re.M)]:
                problems.append(f"{po}:\n\n" + "\n\n".join(partial))
        if problems:
            print(
                colorama.Fore.RED
                + "\n\n".join(problems)
                + "\n\nEach of these will show in English to users of that locale. Author a translation for it, and if it's "
                + "flagged fuzzy then remove that flag and the `#|` lines above it once the translation is right."
                + colorama.Style.RESET_ALL
            )
            exit(1)

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
