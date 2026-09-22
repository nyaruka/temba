#!/usr/bin/env python3
"""
Runs the checks CI runs before the tests, against the project in the current directory - which needn't be this
checkout, as projects that build on this one run this same script. The project configures the checks in the
[tool.code_check] section of its pyproject.toml:

  packages    the python packages to lint and format-check (required)
  locale      the directory holding the translation catalogs (required)
  translated  the locales in which every string must have a translation
  ignore      globs of files for makemessages to skip, relative to the working directory
  migrations  whether to check for model changes with no migration
  templates   the template directories to format-check

The fast static checks run first so that a formatting slip fails in seconds rather than after the slow catalog
regeneration.
"""

import argparse
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import tomllib

import colorama

from temba.utils.mutated_globals import find_mutated_globals, is_app_source


class Checker:
    def __init__(self, config: dict, *, debug: bool):
        self.config = config
        self.debug = debug

    def run(self):
        for check in (self.ruff, self.templates, self.mutated_globals, self.migrations, self.locale, self.translations):
            check()

        print("👍 " + colorama.Fore.GREEN + "Code looks good. Make that PR!")

    def status(self, line: str):
        print(colorama.Fore.GREEN + f">>> {line}..." + colorama.Style.RESET_ALL)

    def fail(self, message: str, hint: str = None):
        print(colorama.Fore.RED + message + (f"\n\n{hint}" if hint else "") + colorama.Style.RESET_ALL)
        sys.exit(1)

    def cmd(self, line: str, hint: str = None) -> str:
        """
        Runs a shell command, failing the checks with its output if it exits non-zero
        """
        if self.debug:
            print(colorama.Style.DIM + "% " + line + colorama.Style.RESET_ALL)
        try:
            result = subprocess.run(line, shell=True, capture_output=True, check=True)
        except subprocess.CalledProcessError as e:
            self.fail((e.stdout + e.stderr).decode("utf-8"), hint)
        output = result.stdout.decode("utf-8")
        if self.debug:
            print(colorama.Style.DIM + output + colorama.Style.RESET_ALL)
        return output

    def ruff(self):
        packages = " ".join(self.config["packages"])

        self.status("Running ruff format")
        self.cmd(f"ruff format --check {packages}")

        self.status("Running ruff")
        self.cmd(f"ruff check {packages}")

    def templates(self):
        if dirs := " ".join(self.config.get("templates", [])):
            self.status("Running djangofmt")
            self.cmd(f"djangofmt --check {dirs}")

    def mutated_globals(self):
        self.status("Check for module-level state mutated in functions")
        problems = []
        for package in self.config["packages"]:
            for path in sorted(pathlib.Path(package).rglob("*.py")):
                if is_app_source(path):
                    problems.extend(find_mutated_globals(path.read_text(), str(path)))
        if problems:
            self.fail(
                "\n".join(problems),
                "Each of these is shared by every request a threaded server is handling at once. Either don't mutate "
                "it after import, or add a `# thread-safe: <reason>` comment to the line that defines it.",
            )

    def migrations(self):
        if self.config.get("migrations", False):
            self.status("Check for missing migrations")
            self.cmd("python manage.py makemigrations --check")

    def locale(self):
        """
        Regenerates the translation catalogs and fails if that changes them, leaving the regenerated files in place
        ready to be committed
        """
        locale_dir = self.config["locale"]

        # makemessages only ever writes to a `locale` directory directly under its working directory, so it has to
        # be run from the parent of the configured locale directory - with the ignore globs rebased to be relative
        # to it
        msg_dir = os.path.dirname(locale_dir) or "."
        ignores = " ".join(f"--ignore='{i.removeprefix(msg_dir + '/')}'" for i in self.config.get("ignore", []))

        self.status("Check locale files are up to date")
        with tempfile.TemporaryDirectory() as backup_dir:
            # take a copy of the PO files so we can compare the regenerated ones against them, and then put them
            # back. we compare against the working copy rather than using git because git isn't usable from here
            # in CI, where the checkout isn't a safe directory for the user running the checks
            self.cmd(f"cp -a {locale_dir}/. {backup_dir}")

            # this is our own makemessages rather than django's - see temba/utils/management/commands/makemessages.py
            # - and it's run with the manage.py beside this script as the project being checked needn't have its own
            manage_py = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manage.py")
            self.cmd(
                f"python '{manage_py}' makemessages --cwd '{msg_dir}' -a -e html,txt,py --no-location --no-wrap "
                f"--no-obsolete {ignores}"
            )

            self.cmd(f"diff -ur {backup_dir} {locale_dir}")

            # nothing to do, so restore the originals rather than leaving a dirty working tree behind
            self.cmd(f"cp -a {backup_dir}/. {locale_dir}")

    def translations(self):
        """
        A string without a translation falls back to English at runtime, which is invisible in an English-speaking
        dev environment. makemessages makes it easy to miss: a new string that resembles an existing one gets that
        string's translation copied in flagged as fuzzy, and msgfmt then drops fuzzy entries when compiling. So every
        string has to have a real translation in each of the maintained locales - the source language's catalog is
        exempt as it's never translated.
        """
        if not (translated := self.config.get("translated", [])):
            return

        self.status("Check translations are complete")
        problems = []
        for locale in translated:
            po = f"{self.config['locale']}/{locale}/LC_MESSAGES/django.po"
            for flags in ("--untranslated --no-fuzzy", "--only-fuzzy"):
                # output is empty when nothing matches, and otherwise a catalog whose first entry is the header
                if entries := self.cmd(f"msgattrib {flags} --no-wrap {po}").strip().split("\n\n", 1)[1:]:
                    problems.append(f"{po}:\n\n{entries[0]}")

            # msgattrib judges a plural entry by its first form alone, so also catch later forms left empty - which
            # with the catalogs unwrapped is a msgstr[n] "" line with no continuation line after it
            with open(po) as f:
                entries = f.read().split("\n\n")
            if partial := [
                e for e in entries if "msgid_plural" in e and re.search(r'^msgstr\[\d+\] ""$(?!\n")', e, re.M)
            ]:
                problems.append(f"{po}:\n\n" + "\n\n".join(partial))
        if problems:
            self.fail(
                "\n\n".join(problems),
                "Each of these will show in English to users of that locale. Author a translation for it, and if it's "
                "flagged fuzzy then remove that flag and the `#|` lines above it once the translation is right.",
            )


def main():
    parser = argparse.ArgumentParser(description="Code checks")
    parser.add_argument("--debug", action="store_true", help="print each command and its output")
    args = parser.parse_args()

    colorama.init()

    try:
        with open("pyproject.toml", "rb") as f:
            config = tomllib.load(f)["tool"]["code_check"]
    except FileNotFoundError, KeyError:
        print(
            colorama.Fore.RED
            + "No [tool.code_check] section in the pyproject.toml of the current directory."
            + colorama.Style.RESET_ALL
        )
        sys.exit(1)

    Checker(config, debug=args.debug).run()


if __name__ == "__main__":
    main()
