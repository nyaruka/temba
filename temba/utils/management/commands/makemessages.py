import os
from pathlib import Path

from django.core.management.commands import makemessages


class Command(makemessages.Command):
    """
    Django's makemessages, adjusted so that the catalogs it writes don't conflict between branches for no reason.
    """

    # only ever look at locale directories under the working directory - with settings, LOCALE_PATHS could pull
    # other projects' catalogs into scope
    settings_available = False

    def add_arguments(self, parser):
        super().add_arguments(parser)
        parser.add_argument(
            "--cwd",
            help="The directory to work in, i.e. the parent of the locale directory. Defaults to the current one.",
        )

    def handle(self, *args, **options):
        # makemessages works on the current directory, but starting django from inside a package would put that
        # package's modules on the path ahead of any installed ones of the same name - so we move there only now
        if options["cwd"]:
            os.chdir(options["cwd"])

        super().handle(*args, **options)

    def write_po_file(self, potfile, locale):
        super().write_po_file(potfile, locale)

        # gettext stamps every catalog with the time it ran, so any two branches that regenerate them would conflict
        # on that line even when their messages don't. nothing reads it and gettext has no option to leave it out
        po = Path(potfile).parent / locale / "LC_MESSAGES" / f"{self.domain}.po"
        lines = po.read_text(encoding="utf-8").splitlines(keepends=True)
        po.write_text("".join(ln for ln in lines if not ln.startswith('"POT-Creation-Date:')), encoding="utf-8")
