"""
Re-migrates flow test fixtures in media/test_flows/ to the current spec version.

Used when bumping Flow.CURRENT_SPEC_VERSION so tests don't need to call mailroom's
flow/migrate endpoint just to bring fixtures up to current spec.

Skips fixtures used to test legacy migration behavior:
  - media/test_flows/legacy/migrations/*  (inputs to FlowMigrationTest)
  - media/test_flows/legacy/invalid/*     (intentionally invalid)
  - media/test_flows/legacy/color_v11.json (tests legacy revision migration UI)
  - media/test_flows/mixed_versions.json   (tests mixed-version import)
"""

import json
import pathlib
import re

from packaging.version import Version

from django.core.management.base import BaseCommand

from temba.flows.models import Flow
from temba.orgs.models import Org

SKIP = {
    "media/test_flows/legacy/color_v11.json",
    "media/test_flows/mixed_versions.json",
}
SKIP_DIRS = {
    "media/test_flows/legacy/migrations",
    "media/test_flows/legacy/invalid",
}


def _detect_indent(text: str) -> int:
    m = re.search(r"\n( +)\S", text)
    return len(m.group(1)) if m else 2


class Command(BaseCommand):
    help = "Migrate flow test fixtures in media/test_flows/ to the current flow spec version"

    def handle(self, *args, **options):
        org = Org.objects.first()
        if org is None:
            self.stderr.write("No org found - need at least one org in the DB to run this")
            return

        current = Version(Flow.CURRENT_SPEC_VERSION)

        for path in sorted(pathlib.Path("media/test_flows").rglob("*.json")):
            rel = path.as_posix()
            if rel in SKIP or any(rel.startswith(d) for d in SKIP_DIRS):
                continue

            text = path.read_text()
            indent = _detect_indent(text)
            data = json.loads(text)

            if "version" not in data:
                self.stdout.write(f"SKIP (no version field): {rel}")
                continue

            # skip if all inner flows are already at the current spec version
            inner_versions = [
                Version(str(f.get("spec_version") or f.get("version") or "0")) for f in data.get("flows", [])
            ]
            if inner_versions and all(v >= current for v in inner_versions):
                self.stdout.write(f"SKIP (already current): {rel}")
                continue

            export_version = Version(str(data["version"]))
            self.stdout.write(f"MIGRATE {rel}: export v{export_version} -> spec v{current}")

            try:
                migrated = Flow.migrate_export(org, data, same_site=False, version=export_version)
            except Exception as e:
                self.stderr.write(f"  FAILED: {e}")
                continue

            # keep the export envelope at the current export format - distinct from flow spec_version
            migrated["version"] = Org.CURRENT_EXPORT_VERSION

            # strip the legacy "version" key from each migrated flow def - the migrated form uses
            # "spec_version" only and Flow.migrate_definition treats the presence of "version" as
            # an indicator of a legacy definition needing migration
            for flow_def in migrated.get("flows", []):
                flow_def.pop("version", None)

            path.write_text(json.dumps(migrated, indent=indent) + "\n")
